import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assess, authFile, execArgs, run } from '../scripts/pilot.js';

const PILOT = fileURLToPath(new URL('../scripts/pilot.js', import.meta.url));
const markers = ['first', 'second'];

// Fake Codex: answers the catalog probe, records the argv it was spawned with, then either completes a
// turn with JSONL on stdout or hangs so the pilot has to kill its process group.
const FAKE_CODEX = [
  `#!${process.execPath}`,
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  'const args = process.argv.slice(2);',
  "if (args[0] === 'debug') {",
  "  if (process.env.FAKE_CODEX_VANISH === '1') fs.unlinkSync(process.argv[1]);",
  "  process.stdout.write(JSON.stringify({ models: [{ slug: 'gpt-6-astra' }] }));",
  '  process.exit(0);',
  '}',
  "const home = process.env.CODEX_HOME ?? '';",
  'fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({',
  '  pid: process.pid, argv: args, cwd: process.cwd(), home,',
  "  auth: fs.existsSync(path.join(home, 'auth.json')),",
  "  config: fs.existsSync(path.join(home, 'config.toml')),",
  '  deepseek: Boolean(process.env.DEEPSEEK_API_KEY),',
  "}) + '\\n');",
  "if (process.env.FAKE_CODEX_MODE === 'hang') {",
  '  process.stdin.resume();',
  '  setInterval(() => {}, 1000);',
  '} else {',
  "  fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], 'pilot ok\\n');",
  "  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'fake' }) + '\\n');",
  "  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 3 } }) + '\\n');",
  '  process.exit(0);',
  '}',
  '',
].join('\n');

// Fake router: consumes the pilot config, writes the receipts the pilot assesses, then stays alive until
// its process group is killed.
const FAKE_ROUTER = [
  "import { appendFileSync, writeFileSync } from 'node:fs';",
  "let input = '';",
  'for await (const chunk of process.stdin) input += chunk;',
  'const { config } = JSON.parse(input);',
  "appendFileSync(process.env.FAKE_ROUTER_LOG, process.pid + '\\n');",
  "const native = { route: 'native', http_status: 200, calls: [{ name: 'spawn_agent' }, { name: 'followup_task' }] };",
  'const child = { route: \'deepseek\', http_status: 200, completed: true, recipients: [\'flash\'], task_count: 2,',
  "  calls: [{ name: 'exec_command' }], tool_results: [true, true], answers: [true, true] };",
  "writeFileSync(config.receipts, JSON.stringify(native) + '\\n' + JSON.stringify(child) + '\\n');",
  "process.stdout.write(JSON.stringify({ pid: process.pid, port: 41234 }) + '\\n');",
  'setInterval(() => {}, 1000);',
  '',
].join('\n');

// Runs the pilot through its exported entry point and reports the signal listeners it left behind.
const RUNNER = [
  "import { run } from './scripts/pilot.js';",
  'process.exitCode = await run();',
  "process.stdout.write(JSON.stringify({ event: 'runner.listeners',",
  "  sigint: process.listenerCount('SIGINT'), sigterm: process.listenerCount('SIGTERM') }) + '\\n');",
  '',
].join('\n');

const WORKER_STUB = (root, codex, { failKill = false } = {}) => [
  `export const ROOT = ${JSON.stringify(root)};`,
  'export function loadConfig() {',
  "  return { codex: { model: 'deepseek-flash', model_provider: 'opencodex-deepseek', model_reasoning_effort: 'high',",
  '      features: { multi_agent: false, plugins: false },',
  "      model_providers: { 'opencodex-deepseek': { base_url: 'https://api.deepseek.com', env_key: 'DEEPSEEK_API_KEY' } } },",
  "    model_metadata: { display_name: 'DeepSeek Flash (OpenCodex)' } };",
  '}',
  'export function workerEnvironment(source) { return { ...source }; }',
  "export function loadCredentials(env, config) { env.DEEPSEEK_API_KEY = 'fake-test-key'; }",
  `export function doctor(config, env) { return { status: 'ready', codex: ${JSON.stringify(codex)} }; }`,
  'export function configArgs(values) {',
  "  return Object.entries(values).flatMap(([key, value]) => ['-c', key + '=' + JSON.stringify(value)]);",
  '}',
  'let killCalls = 0;',
  'export async function killGroup(child) {',
  ...(failKill ? ["  if (++killCalls === 1) throw new Error('killGroup unavailable');"] : []),
  "  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }",
  '  if (child.exitCode === null && child.signalCode === null) {',
  "    await new Promise((resolve) => child.once('close', resolve));",
  '  }',
  '}',
  '',
].join('\n');

function child(overrides = {}) {
  return { route: 'deepseek', http_status: 200, completed: true, recipients: ['flash'], task_count: 2,
    calls: [{ name: 'exec_command' }], tool_results: [true, true], answers: [true, true], ...overrides };
}

// Isolated ROOT with a stubbed worker.js, a fake Codex and a fake router; no real CLI and no inference.
function harness(t, { mode = 'complete', auth = true, vanish = false, failKill = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'opencodex-pilot-run-')));
  const box = {
    root,
    codexHome: path.join(root, 'codex-home'),
    codexLog: path.join(root, 'logs/codex.jsonl'),
    routerLog: path.join(root, 'logs/router.pids'),
    codex: path.join(root, 'fake-codex.js'),
  };
  for (const dir of ['config', 'prompts', 'scripts', 'logs', 'codex-home']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.copyFileSync(PILOT, path.join(root, 'scripts/pilot.js'));
  fs.writeFileSync(path.join(root, 'scripts/worker.js'), WORKER_STUB(root, box.codex, { failKill }));
  fs.writeFileSync(path.join(root, 'scripts/pilot-router.js'), FAKE_ROUTER);
  fs.writeFileSync(path.join(root, 'runner.js'), RUNNER);
  fs.writeFileSync(path.join(root, 'prompts/worker.md'), 'fake child instructions\n');
  fs.writeFileSync(path.join(root, 'config/pilot.json'), JSON.stringify({ parent_model: 'gpt-6-astra',
    parent_effort: 'low', timeout_seconds: 20, request_timeout_ms: 1000, startup_timeout_seconds: 20 }));
  fs.writeFileSync(box.codex, FAKE_CODEX);
  fs.chmodSync(box.codex, 0o700);
  if (auth) fs.writeFileSync(path.join(box.codexHome, 'auth.json'), '{"tokens": {}}\n');
  box.env = { ...process.env, CODEX_HOME: box.codexHome, FAKE_CODEX_LOG: box.codexLog,
    FAKE_ROUTER_LOG: box.routerLog, FAKE_CODEX_MODE: mode, FAKE_CODEX_VANISH: vanish ? '1' : '0' };
  box.records = () => (fs.existsSync(box.codexLog)
    ? fs.readFileSync(box.codexLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : []);
  box.pids = () => (fs.existsSync(box.routerLog)
    ? fs.readFileSync(box.routerLog, 'utf8').trim().split('\n').filter(Boolean).map(Number)
    : []);
  box.alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  t.after(() => {
    for (const pid of [...box.pids(), ...box.records().map(record => record.pid)]) {
      try { process.kill(-pid, 'SIGKILL'); } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return box;
}

function launch(box, script = 'runner.js') {
  return spawn(process.execPath, [path.join(box.root, script)],
    { cwd: box.root, env: box.env, stdio: ['ignore', 'pipe', 'pipe'] });
}

function collect(running, timeout_ms) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      running.kill('SIGKILL');
      reject(new Error(`The pilot did not exit within ${timeout_ms}ms; stderr: ${stderr}`));
    }, timeout_ms);
    running.stdout.on('data', (chunk) => { stdout += chunk; });
    running.stderr.on('data', (chunk) => { stderr += chunk; });
    running.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr, events: stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line)) });
    });
  });
}

async function waitFor(check, timeout_ms) {
  const deadline = Date.now() + timeout_ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('The fake pilot never reached the expected state');
}

test('a parent echo does not prove child work', () => {
  const checks = assess([{ route: 'native', http_status: 200, answers: [true, true] }], markers, 0,
    [{ type: 'turn.completed' }]);
  assert.equal(checks.parent_completed, true);
  assert.equal(checks.file_values_returned, false);
  assert.equal(checks.same_agent_followup, false);
});

test('two children do not prove same-agent followup', () => {
  const receipts = ['/root/one', '/root/two'].map((name) => child({ recipients: [name] }));
  assert.equal(assess(receipts, markers, 0, []).same_agent_followup, false);
});

test('an incomplete DeepSeek response fails', () => {
  const checks = assess([{ route: 'deepseek', http_status: 200, completed: false }], markers, 0,
    [{ type: 'turn.completed' }]);
  assert.equal(checks.deepseek_completed, false);
});

test('client cancellation is not a provider error but cannot pass alone', () => {
  const cancelled = assess([{ route: 'cancelled', reason: 'codex_disconnected' }], markers, 0, []);
  assert.equal(cancelled.no_transport_errors, true);
  assert.equal(cancelled.parent_completed, false);
  assert.equal(cancelled.deepseek_completed, false);
  assert.equal(assess([{ route: 'error', message: 'timeout' }], [], 0, []).no_transport_errors, false);
});

test('complete pilot evidence satisfies every criterion', () => {
  const receipts = [
    { route: 'native', http_status: 200, calls: [{ name: 'spawn_agent' }, { name: 'followup_task' }] },
    child(),
  ];
  assert.deepEqual(assess(receipts, markers, 0, [{ type: 'turn.completed' }]), {
    parent_completed: true,
    native_spawn: true,
    deepseek_completed: true,
    tool_used: true,
    file_values_returned: true,
    same_agent_followup: true,
    no_transport_errors: true,
  });
});

test('a provider failure on any route is a transport error', () => {
  assert.equal(assess([child({ http_status: 500 })], markers, 0, []).no_transport_errors, false);
  assert.equal(assess([{ route: 'native', http_status: 502 }, child()], markers, 0, []).no_transport_errors, false);
});

test('a child must return the answer for every marker, not only the tool result', () => {
  const partial = child({ answers: [false, true] });
  assert.equal(assess([partial], markers, 0, [{ type: 'turn.completed' }]).file_values_returned, false);
  assert.equal(assess([child()], markers, 0, [{ type: 'turn.completed' }]).file_values_returned, true);
});

test('a completed turn with a failing parent exit code is not a completed parent', () => {
  assert.equal(assess([], markers, 1, [{ type: 'turn.completed' }]).parent_completed, false);
  assert.equal(assess([], markers, 0, [{ type: 'turn.failed' }]).parent_completed, false);
});

test('a spawn call outside a native receipt does not prove native spawning', () => {
  assert.equal(assess([child({ calls: [{ name: 'spawn_agent' }] })], markers, 0, []).native_spawn, false);
});

test('one child with a single task is not a same-agent followup', () => {
  assert.equal(assess([child({ task_count: 1 })], markers, 0, []).same_agent_followup, false);
  assert.equal(assess([child({ recipients: [] })], markers, 0, []).same_agent_followup, false);
});

test('a child that never ran a shell command does not prove tool use', () => {
  assert.equal(assess([child({ calls: [] })], markers, 0, []).tool_used, false);
});

test('the login comes from CODEX_HOME and defaults to ~/.codex', () => {
  assert.equal(authFile({ CODEX_HOME: '/tmp/isolated-home' }), path.join('/tmp/isolated-home', 'auth.json'));
  assert.equal(authFile({}), path.join(os.homedir(), '.codex', 'auth.json'));
});

test('codex exec argv keeps the executable out of the argument list', () => {
  assert.equal(typeof run, 'function');
  assert.deepEqual(execArgs('/tmp/run/workspace', '/tmp/run'),
    ['exec', '--ephemeral', '--json', '--strict-config', '--skip-git-repo-check',
      '--sandbox', 'read-only', '--cd', '/tmp/run/workspace', '--output-last-message', '/tmp/run/final.txt', '-']);
});

test('run drives the fake Codex, assesses the receipts and removes the temporary login', async (t) => {
  const box = harness(t);
  const started = Date.now();
  const { code, stderr, events } = await collect(launch(box), 15000);
  assert.equal(code, 0, stderr);
  assert.ok(Date.now() - started < 10000, 'the pilot kept a timer alive after finishing');
  assert.deepEqual(events.map((event) => event.event ?? event.status),
    ['pilot.router_started', 'passed', 'pilot.stopped', 'runner.listeners']);
  const [router, result, stopped, listeners] = events;
  assert.equal(router.owner, 'OpenCodex isolated pilot');
  assert.equal(router.cwd, path.join(router.artifacts, 'workspace'));
  assert.deepEqual(Object.keys(result.checks), ['parent_completed', 'native_spawn', 'deepseek_completed', 'tool_used',
    'file_values_returned', 'same_agent_followup', 'no_transport_errors']);
  assert.equal(Object.values(result.checks).every(Boolean), true);
  assert.equal(result.routes.length, 2);
  assert.equal('recipients' in result.routes[0], false);
  assert.deepEqual(result.routes[1], { route: 'deepseek', http_status: 200, completed: true, task_count: 2,
    calls: [{ name: 'exec_command' }], tool_results: [true, true], answers: [true, true] });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(result.artifacts, 'result.json'), 'utf8')), result);
  assert.equal(stopped.artifacts, result.artifacts);
  assert.equal(stopped.temporary_credentials_removed, true);
  assert.deepEqual([listeners.sigint, listeners.sigterm], [0, 0]);
  const records = box.records();
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].argv, execArgs(path.join(result.artifacts, 'workspace'), result.artifacts));
  assert.deepEqual(records[0].argv.slice(0, 2), ['exec', '--ephemeral']);
  assert.equal(records[0].argv.includes(box.codex), false);
  assert.equal(records[0].cwd, path.join(result.artifacts, 'workspace'));
  assert.equal(records[0].home, path.join(result.artifacts, 'codex-home'));
  assert.equal(records[0].auth, true);
  assert.equal(records[0].config, true);
  assert.equal(records[0].deepseek, false);
  assert.equal(fs.existsSync(path.join(result.artifacts, 'codex-home')), false);
  assert.equal(fs.existsSync(path.join(box.codexHome, 'auth.json')), true);
  assert.equal(box.pids().length, 1);
  assert.deepEqual([box.alive(records[0].pid), box.alive(box.pids()[0])], [false, false]);
});

test('SIGINT stops both process groups and removes the temporary login without waiting for the timeout', async (t) => {
  const box = harness(t, { mode: 'hang' });
  const pilot = launch(box);
  t.after(() => pilot.kill('SIGKILL'));
  const exited = collect(pilot, 15000);
  await waitFor(() => box.records().length === 1, 10000);
  const signaled = Date.now();
  pilot.kill('SIGINT');
  const { code, events } = await exited;
  assert.notEqual(code, 0);
  assert.ok(Date.now() - signaled < 10000, 'the pilot waited for the Codex timeout instead of cleaning up');
  assert.equal(events.at(-1).event, 'pilot.stopped');
  assert.equal(fs.existsSync(path.join(events.at(-1).artifacts, 'codex-home')), false);
  assert.equal(box.pids().length, 1);
  assert.equal(box.alive(box.records()[0].pid), false);
  assert.equal(box.alive(box.pids()[0]), false);
});

test('a missing login fails through the module entry point before anything is spawned', async (t) => {
  const box = harness(t, { auth: false });
  const { code, stderr, events } = await collect(launch(box, 'scripts/pilot.js'), 15000);
  assert.notEqual(code, 0);
  assert.match(stderr, /Pilot requires the existing Codex auth\.json login/);
  assert.deepEqual(events, []);
  assert.equal(fs.existsSync(box.codexLog), false);
  assert.equal(fs.existsSync(box.routerLog), false);
});

test('a Codex that cannot be spawned still stops the router and removes the temporary login', async (t) => {
  const box = harness(t, { vanish: true });
  const { code, stderr, events } = await collect(launch(box), 15000);
  assert.notEqual(code, 0);
  assert.match(stderr, /ENOENT/);
  assert.equal(events.at(-1).event, 'pilot.stopped');
  assert.equal(fs.existsSync(path.join(events.at(-1).artifacts, 'codex-home')), false);
  assert.equal(box.pids().length, 1);
  assert.equal(box.alive(box.pids()[0]), false);
});

test('a failing child cleanup still stops the router and removes the temporary login', async (t) => {
  const box = harness(t, { failKill: true });
  const { code, events } = await collect(launch(box), 15000);
  assert.notEqual(code, 0);
  assert.match(events.at(-1).event, /pilot\.stopped/);
  assert.equal(events.at(-1).temporary_credentials_removed, true);
  assert.equal(fs.existsSync(path.join(events.at(-1).artifacts, 'codex-home')), false);
  assert.equal(box.alive(box.pids()[0]), false);
});
