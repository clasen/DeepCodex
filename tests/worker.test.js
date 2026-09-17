import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as worker from '../scripts/worker.js';

const WORKER = fileURLToPath(new URL('../scripts/worker.js', import.meta.url));
const BIN = fileURLToPath(new URL('../bin/opencodex.js', import.meta.url));
const FAKE = fs.readFileSync(new URL('./fake-codex.js', import.meta.url), 'utf8');

const previousTmpdir = process.env.TMPDIR;
const suiteTmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencodex-worker-tests-'));
process.env.TMPDIR = suiteTmpdir;
after(() => {
  if (previousTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = previousTmpdir;
  fs.rmSync(suiteTmpdir, { recursive: true, force: true });
});

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

// Runs a CLI command on a descendant-producing ticket until the descendant exists, cancels the run,
// and returns the parsed report after checking that the descendant died with its process group.
async function cancelAndCollect(t, command, env, box, pidFile) {
  const ticket = path.join(box.dir, `${path.basename(pidFile)}.task`);
  fs.writeFileSync(ticket, `descendant:${pidFile}`);
  const full = [...command, '--cwd', box.dir, '--task-file', ticket];
  const child = spawn(full[0], full.slice(1), { env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  let stdout = '';
  child.stdout.on('data', chunk => {
    stdout += chunk;
  });
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(pidFile) && child.exitCode === null && Date.now() < deadline) await delay(10);
  assert.ok(fs.existsSync(pidFile), 'fixture descendant did not start');
  child.kill('SIGTERM');
  await new Promise(resolve => child.once('close', resolve));
  assert.notEqual(child.exitCode, 0, 'cancelled runs exit non-zero');
  const report = JSON.parse(stdout);
  assert.equal(report.status, 'cancelled');
  const descendant = Number(fs.readFileSync(pidFile, 'utf8'));
  const gone = Date.now() + 2000;
  while (Date.now() < gone) {
    try {
      process.kill(descendant, 0);
    } catch {
      return report;
    }
    await delay(10);
  }
  assert.fail('worker descendant survived cancellation');
}

// The fixture binary is the fake Codex with this interpreter in its shebang, so no provider and no
// real Codex CLI are ever involved.
function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'opencodex-test-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const binary = path.join(dir, 'codex');
  fs.writeFileSync(binary, FAKE.replace('#!/usr/bin/env node', `#!${process.execPath}`));
  fs.chmodSync(binary, 0o700);
  const config = JSON.parse(JSON.stringify(worker.loadConfig()));
  config.limits.timeout_seconds = 3;
  config.limits.poll_interval_seconds = 0.01;
  const env = worker.workerEnvironment({ ...process.env, DEEPSEEK_API_KEY: 'test-secret', PARENT_SECRET: 'must-not-inherit' });
  return {
    dir,
    binary,
    config,
    env,
    runWorker: (task = 'ticket', write = false) => worker.runWorker(binary, config, dir, task, write, env),
  };
}

test('success preserves stdin and scopes the process environment', async (t) => {
  const box = fixture(t);
  const ticket = 'Implement the ticket; $(no-shell) "quoted"\nsecond line — café';
  const result = await box.runWorker(ticket);
  assert.equal(result.status, 'completed');
  const body = JSON.parse(result.result);
  assert.equal(body.task, ticket);
  assert.ok(!body.argv.includes(ticket), 'ticket must travel on stdin, not argv');
  assert.equal(body.parent_secret, null);
  assert.equal(body.cwd, box.dir);
  assert.equal(body.argv[0], 'exec', 'child argv must not repeat the binary path');
  assert.ok(!body.argv.includes(box.binary), 'the binary belongs in argv[0] only, which spawn supplies');
  assert.ok(body.argv.includes('--ignore-user-config'));
  assert.ok(body.argv.includes('read-only'));
  assert.ok(body.argv.includes('model="deepseek-flash"'));
  assert.ok(body.argv.includes('model_providers.opencodex-deepseek.base_url="https://api.deepseek.com"'));
  assert.equal(result.usage.input_tokens, 12);
  assert.ok(!JSON.stringify(worker.redact(result, 'test-secret')).includes('test-secret'));
});

test('write mode requires the explicit flag', async (t) => {
  const box = fixture(t);
  const result = await box.runWorker('ticket', true);
  assert.equal(result.sandbox, 'workspace-write');
  assert.ok(JSON.parse(result.result).argv.includes('workspace-write'));
});

test('no false success on a bad completion', async (t) => {
  const box = fixture(t);
  for (const mode of ['empty', 'incomplete', 'failed', 'nonzero', 'malformed']) {
    const result = await box.runWorker(mode);
    assert.equal(result.status, 'failed', `${mode} must not report success`);
    assert.equal(result.partial_changes_possible, true);
  }
});

test('timeout kills the worker process group', async (t) => {
  const box = fixture(t);
  box.config.limits.timeout_seconds = 0.1;
  const result = await box.runWorker('sleep');
  assert.equal(result.status, 'timeout');
  assert.throws(() => process.kill(result.worker_pid, 0), { code: 'ESRCH' });
});

test('output limit stops the worker', async (t) => {
  const box = fixture(t);
  box.config.limits.max_output_bytes = 1000;
  const result = await box.runWorker('output_limit');
  assert.equal(result.status, 'output_limit');
});

test('lock blocks a parallel worker and releases', async (t) => {
  const box = fixture(t);
  const lock = await worker.workerLock();
  try {
    await assert.rejects(() => box.runWorker(), /Another OpenCodex worker/);
  } finally {
    lock.close();
  }
  assert.equal((await box.runWorker()).status, 'completed');
});

test('project MCP servers are rejected before spawn', async (t) => {
  const box = fixture(t);
  fs.mkdirSync(path.join(box.dir, '.codex'));
  fs.writeFileSync(path.join(box.dir, '.codex', 'config.toml'), '[mcp_servers.example]\ncommand="unexpected"\n');
  await assert.rejects(() => box.runWorker(), /Project MCP/);
});

test('doctor without an api key never runs inference', (t) => {
  const box = fixture(t);
  const env = { ...box.env, PATH: box.dir };
  delete env.DEEPSEEK_API_KEY;
  const report = worker.doctor(box.config, env);
  assert.equal(report.status, 'not_ready');
  assert.equal(report.compatible_cli, true);
  assert.equal(report.api_key_present, false);
});

test('credentials file loads only the key without expansion', (t) => {
  const box = fixture(t);
  const file = path.join(box.dir, '.env');
  const key = 'literal-$(touch unwanted)-$HOME-#value';
  fs.writeFileSync(file, `UNRELATED=ignored\nexport DEEPSEEK_API_KEY='${key}' # comment\n`);
  box.config.credentials.env_file = file;
  const env = {};
  worker.loadCredentials(env, box.config);
  assert.deepEqual(env, { DEEPSEEK_API_KEY: key });
  assert.equal(fs.existsSync(path.join(box.dir, 'unwanted')), false);
});

test('environment key takes precedence over the credentials file', (t) => {
  const box = fixture(t);
  const file = path.join(box.dir, '.env');
  fs.writeFileSync(file, 'DEEPSEEK_API_KEY="broken');
  box.config.credentials.env_file = file;
  const env = { DEEPSEEK_API_KEY: 'environment-key' };
  worker.loadCredentials(env, box.config);
  assert.equal(env.DEEPSEEK_API_KEY, 'environment-key');
});

test('missing credentials file remains not ready', (t) => {
  const box = fixture(t);
  box.config.credentials.env_file = path.join(box.dir, 'missing.env');
  const env = { PATH: box.dir };
  worker.loadCredentials(env, box.config);
  assert.equal(worker.doctor(box.config, env).status, 'not_ready');
});

test('invalid credentials fail without disclosing values', (t) => {
  const box = fixture(t);
  const file = path.join(box.dir, '.env');
  box.config.credentials.env_file = file;
  const contents = ['UNRELATED=secret-value', 'DEEPSEEK_API_KEY="secret-value', 'DEEPSEEK_API_KEY=""',
    'DEEPSEEK_API_KEY=secret-value\nDEEPSEEK_API_KEY=duplicate', 'DEEPSEEK_API_KEY=secret-value unexpected'];
  for (const text of contents) {
    fs.writeFileSync(file, text);
    assert.throws(() => worker.loadCredentials({}, box.config),
      error => !String(error.message).includes('secret-value'), `${text} must not disclose the value`);
  }
});

// Expected values come from CPython's shlex.split(value, comments=True), the parser the Python
// worker used; the quoting rules are shlex's, not the shell's.
test('credential quoting matches python shlex', (t) => {
  const box = fixture(t);
  const file = path.join(box.dir, '.env');
  box.config.credentials.env_file = file;
  const accepted = [
    ['plain-value', 'plain-value'],
    ['abc#def', 'abc'],
    ['"quoted value"', 'quoted value'],
    ['"dollar \\$HOME"', 'dollar \\$HOME'],
    ['"backtick \\`cmd\\`"', 'backtick \\`cmd\\`'],
    ['"escaped \\" quote"', 'escaped " quote'],
    ['"a\\\\b"', 'a\\b'],
    ['"trailing\\\\"', 'trailing\\'],
    ['unquoted\\#hash', 'unquoted#hash'],
    ['a\\ b', 'a b'],
    ["'single \\$ keep'", 'single \\$ keep'],
  ];
  for (const [raw, value] of accepted) {
    fs.writeFileSync(file, `DEEPSEEK_API_KEY=${raw}\n`);
    const env = {};
    worker.loadCredentials(env, box.config);
    assert.equal(env.DEEPSEEK_API_KEY, value, `${raw} must parse like python shlex`);
  }
  const rejected = ['', '"unterminated', "'unterminated", 'abc\\', 'two tokens', '"two" "tokens"'];
  for (const raw of rejected) {
    fs.writeFileSync(file, `DEEPSEEK_API_KEY=${raw}\n`);
    assert.throws(() => worker.loadCredentials({}, box.config),
      error => raw === '' || !String(error.message).includes(raw.slice(0, 3)),
      `${JSON.stringify(raw)} must be rejected without echoing it`);
  }
});

test('cli rejects a ticket that is not valid utf-8', (t) => {
  const box = fixture(t);
  const ticket = path.join(box.dir, 'ticket.bin');
  fs.writeFileSync(ticket, Buffer.from([0x66, 0x6f, 0x6f, 0xff, 0xfe, 0x0a]));
  const result = spawnSync(process.execPath, [WORKER, 'run', '--cwd', box.dir, '--task-file', ticket], {
    cwd: box.dir,
    encoding: 'utf8',
    env: { PATH: box.dir, HOME: box.dir, DEEPSEEK_API_KEY: 'test-secret' },
  });
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'failed');
  assert.match(report.error, /encoding utf-8/i);
  assert.ok(!result.stderr.includes('worker.started'), 'an undecodable ticket must not start a worker');
});

test('cli run loads the ticket file and redacts the key', (t) => {
  const box = fixture(t);
  const home = path.join(box.dir, 'home');
  fs.mkdirSync(path.join(home, '.config/opencodex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config/opencodex/.env'), 'DEEPSEEK_API_KEY="file-secret"\n');
  const ticket = path.join(box.dir, 'ticket.txt');
  fs.writeFileSync(ticket, 'Read-only fixture');
  const result = spawnSync(process.execPath, [WORKER, 'run', '--cwd', box.dir, '--task-file', ticket], {
    cwd: box.dir,
    encoding: 'utf8',
    env: { PATH: box.dir, HOME: home, TMPDIR: os.tmpdir(), LANG: 'C.UTF-8' },
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'completed');
  assert.equal(JSON.parse(report.result).task, 'Read-only fixture');
  assert.ok(report.result.includes('[REDACTED]'));
  assert.ok(!result.stdout.includes('file-secret'));
});

test('temporary run artifacts are removed', async (t) => {
  const box = fixture(t);
  const result = await box.runWorker();
  const argv = JSON.parse(result.result).argv;
  const final = argv[argv.indexOf('--output-last-message') + 1];
  assert.equal(fs.existsSync(path.dirname(final)), false);
});

test('cancel returns json and terminates descendants', async (t) => {
  const box = fixture(t);
  const pidFile = path.join(box.dir, 'descendant.pid');
  const env = { ...process.env, PATH: `${box.dir}${path.delimiter}${process.env.PATH ?? ''}`, DEEPSEEK_API_KEY: 'test-secret' };
  await cancelAndCollect(t, [process.execPath, WORKER, 'run'], env, box, pidFile);
});

// The CLI imports main() instead of executing worker.js, so cancellation must not depend on the
// entrypoint branch that registers the signal handlers.
test('cancel works through the opencodex cli, which imports main', async (t) => {
  const box = fixture(t);
  const pidFile = path.join(box.dir, 'bin-descendant.pid');
  const env = { ...process.env, PATH: box.dir, HOME: box.dir, DEEPSEEK_API_KEY: 'test-secret' };
  await cancelAndCollect(t, [process.execPath, BIN, 'run'], env, box, pidFile);
});

test('help and run flags stay available without loading sqlite', (t) => {
  const empty = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'opencodex-empty-')));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  const help = spawnSync(process.execPath, [WORKER, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /doctor/);
  assert.match(help.stdout, /--cwd/);
  assert.match(help.stdout, /--task-file/);
  assert.match(help.stdout, /--write/);
  assert.equal(help.stderr, '', 'help must not load the experimental sqlite module');
  const doctor = spawnSync(process.execPath, [WORKER, 'doctor'], { encoding: 'utf8', env: { PATH: empty } });
  assert.equal(doctor.status, 1);
  assert.equal(JSON.parse(doctor.stdout).status, 'not_ready');
  assert.ok(!doctor.stderr.includes('ExperimentalWarning'), 'doctor must not load the experimental sqlite module');
  const missing = spawnSync(process.execPath, [WORKER, 'run', '--cwd', os.tmpdir()], { encoding: 'utf8' });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--task-file/);
});
