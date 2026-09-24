// Run the opt-in live native-subagent pilot; consumes Codex and DeepSeek usage.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync,
  writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnPlan } from './platform.js';
import { ensurePrivateDirectory, privateWrite } from './private-files.js';
import { loadPilotConfig } from './pilot-config.js';
import { ROOT, configArgs, doctor, killGroup, loadConfig, loadCredentials, workerEnvironment } from './worker.js';

export function assess(receipts, markers, returncode, events) {
  const children = receipts.filter((entry) => entry.route === 'deepseek');
  const recipients = new Set(children.flatMap((entry) => entry.recipients ?? []));
  return {
    parent_completed: returncode === 0 && events.some((event) => event.type === 'turn.completed'),
    native_spawn: receipts.some((entry) => entry.route === 'native'
      && (entry.calls ?? []).some((call) => call.name === 'spawn_agent')),
    deepseek_completed: children.length > 0 && children.every((entry) => Boolean(entry.completed)),
    tool_used: children.some((entry) => (entry.calls ?? []).some((call) => call.name === 'exec_command')),
    file_values_returned: markers.every((_, index) => children.some((entry) =>
      Boolean((entry.tool_results ?? [])[index]) && Boolean((entry.answers ?? [])[index]))),
    same_agent_followup: recipients.size === 1 && children.some((entry) => (entry.task_count ?? 0) >= 2),
    no_transport_errors: receipts.every((entry) => entry.route === 'cancelled'
      || (entry.route !== 'error' && entry.http_status === 200)),
  };
}

export function authFile(env) {
  return path.join(env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'auth.json');
}

export function execArgs(workspace, runDir) {
  return ['exec', '--ephemeral', '--json', '--strict-config', '--skip-git-repo-check',
    '--sandbox', 'read-only', '--cd', workspace, '--output-last-message', path.join(runDir, 'final.txt'), '-'];
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function jsonLines(file) {
  const lines = readFileSync(file, 'utf8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map((line) => JSON.parse(line));
}

function capture(command, args) {
  const plan = spawnPlan(command, args);
  const result = spawnSync(plan.file, plan.args, { encoding: 'utf8', ...plan.options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}: ${result.stderr}`);
  }
  return result.stdout;
}

// SIGINT or SIGTERM aborts the active wait so the cleanup still removes the copied credentials and
// kills both process groups.
function captureSignals() {
  const controller = new AbortController();
  const handlers = new Map(['SIGINT', 'SIGTERM'].map((name) => [name,
    () => controller.abort(new Error(`Pilot interrupted by ${name}`))]));
  for (const [name, handler] of handlers) process.once(name, handler);
  return { signal: controller.signal, dispose: () => {
    for (const [name, handler] of handlers) process.off(name, handler);
  } };
}

function readRouterReadiness(router, timeout_ms, signal) {
  return new Promise((resolve, reject) => {
    let text = '';
    const onData = (chunk) => {
      text += chunk;
      const newline = text.indexOf('\n');
      if (newline === -1) return;
      try { finish(null, JSON.parse(text.slice(0, newline))); } catch (error) { finish(error); }
    };
    const onEnd = () => finish(new Error('Pilot router did not start'));
    const onAbort = () => finish(signal.reason);
    const onError = () => finish(new Error('Pilot router did not start'));
    const timer = setTimeout(() => finish(new Error('Pilot router did not start')), timeout_ms);
    const finish = (error, value) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      router.stdout.off('data', onData);
      router.stdout.off('end', onEnd);
      router.stdout.off('error', onEnd);
      router.off('error', onError);
      if (error) reject(error); else resolve(value);
    };
    router.stdout.on('data', onData);
    router.stdout.on('end', onEnd);
    router.stdout.on('error', onEnd);
    router.on('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function waitForExit(child, timeout_ms, signal) {
  return new Promise((resolve, reject) => {
    const onClose = (code) => finish(null, code);
    const onError = (error) => finish(error);
    const onAbort = () => finish(signal.reason);
    const timer = setTimeout(() => finish(new Error('Codex exec did not finish within timeout_seconds')), timeout_ms);
    const finish = (error, value) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      child.off('close', onClose);
      child.off('error', onError);
      if (error) reject(error); else resolve(value);
    };
    child.once('close', onClose);
    child.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function run() {
  const config = loadPilotConfig();
  const workerConfig = loadConfig();
  const sourceEnv = workerEnvironment(process.env);
  loadCredentials(sourceEnv, workerConfig);
  const diagnosis = doctor(workerConfig, sourceEnv);
  if (diagnosis.status !== 'ready') throw new Error('DeepCodex doctor is not ready');
  const authSource = authFile(sourceEnv);
  if (!statSync(authSource, { throwIfNoEntry: false })?.isFile()) {
    throw new Error('Pilot requires the existing Codex auth.json login');
  }
  const runDir = ensurePrivateDirectory(realpathSync(mkdtempSync(path.join(os.tmpdir(), 'deepcodex-pilot-'))));
  const home = path.join(runDir, 'codex-home');
  const workspace = path.join(runDir, 'workspace');
  ensurePrivateDirectory(home);
  mkdirSync(workspace);
  const markers = [randomBytes(16).toString('hex'), randomBytes(16).toString('hex')];
  ['first.txt', 'second.txt'].forEach((filename, index) => {
    writeFileSync(path.join(workspace, filename), `${markers[index]}\n`);
  });
  const capability = randomBytes(32).toString('base64url');
  const provider = workerConfig.codex.model_provider;
  const providerConfig = workerConfig.codex.model_providers[provider];
  Object.assign(config, {
    child_model: workerConfig.codex.model,
    native_models: [config.parent_model],
    relay_model: config.parent_model,
    deepseek_url: `${providerConfig.base_url}/responses`,
    receipts: path.join(runDir, 'receipts.jsonl'),
    markers,
  });
  let router = null;
  let child = null;
  const started = performance.now() / 1000;
  const signals = captureSignals();
  try {
    // The isolated login is a credential copy, so it is written owner-only on every platform.
    privateWrite(path.join(home, 'auth.json'), readFileSync(authSource, 'utf8'));
    const native = JSON.parse(capture(diagnosis.codex, ['debug', 'models', '--bundled']));
    const parent = (native.models ?? []).find((model) => model.slug === config.parent_model);
    if (!parent) throw new Error(`Native model catalog has no ${config.parent_model}`);
    const metadata = { ...workerConfig.model_metadata, slug: config.child_model, multi_agent_version: 'v2',
      base_instructions: readFileSync(path.join(ROOT, 'prompts/worker.md'), 'utf8') };
    const catalog = path.join(home, 'models.json');
    writeFileSync(catalog, JSON.stringify({ models: [parent, metadata] }));
    const env = workerEnvironment(sourceEnv);
    env.CODEX_HOME = home;
    const routerErrors = openSync(path.join(runDir, 'router-errors.txt'), 'w');
    try {
      router = spawn(process.execPath, [path.join(ROOT, 'scripts/pilot-router.js')],
        { env, cwd: workspace, stdio: ['pipe', 'pipe', routerErrors], detached: true });
      router.stdin.end(JSON.stringify({ config, capability }));
      const ready = await readRouterReadiness(router, config.startup_timeout_seconds * 1000, signals.signal);
      emit({ event: 'pilot.router_started', ...ready, cwd: workspace, owner: 'DeepCodex isolated pilot',
        artifacts: runDir });
      const values = { ...workerConfig.codex };
      delete values.model_reasoning_effort;
      Object.assign(values, { model: config.parent_model, model_provider: 'deepcodex-pilot',
        model_catalog_json: catalog,
        cli_auth_credentials_store: 'file',
        agents: { enabled: true, max_concurrent_threads_per_session: 1 } });
      values.features = { ...values.features, multi_agent: true, multi_agent_v2: true,
        enable_request_compression: false };
      values.model_providers = { 'deepcodex-pilot': {
        name: 'DeepCodex isolated pilot',
        base_url: `http://127.0.0.1:${ready.port}`,
        wire_api: 'responses',
        requires_openai_auth: true,
        supports_websockets: false,
        http_headers: { 'x-deepcodex-pilot': capability },
        request_max_retries: providerConfig.request_max_retries,
        stream_max_retries: providerConfig.stream_max_retries,
        stream_idle_timeout_ms: config.request_timeout_ms,
      } };
      const flat = configArgs(values);
      const configPath = path.join(home, 'config.toml');
      privateWrite(configPath, `${flat.filter((_, index) => index % 2 === 1).join('\n')}\n`);
      delete env.DEEPSEEK_API_KEY;
      const prompt = `Run this authorized native subagent integration test. Spawn exactly one agent named flash, `
        + `model=${config.child_model}, fork_turns=none, reasoning_effort=high. Its first task is: `
        + `Use exec_command to read first.txt in the current workspace and return exactly its content. `
        + `Do not read either file yourself. Wait for the child's result. Then use followup_task on the SAME `
        + `agent to read second.txt with exec_command and return exactly its content. Wait again. `
        + `Never substitute another model or create another agent. Do not use shell to launch Codex. `
        + `If any step fails, report the exact failure. At the end report both returned values and `
        + `the agent's canonical name in Spanish. Do not modify any files.`;
      const eventsFd = openSync(path.join(runDir, 'events.jsonl'), 'w');
      const errorsFd = openSync(path.join(runDir, 'codex-errors.txt'), 'w');
      let returncode;
      try {
        const codex = spawnPlan(diagnosis.codex, execArgs(workspace, runDir), { env });
        child = spawn(codex.file, codex.args,
          { env, cwd: workspace, stdio: ['pipe', eventsFd, errorsFd], detached: true, ...codex.options });
        child.stdin.on('error', () => {});
        child.stdin.end(prompt);
        returncode = await waitForExit(child, config.timeout_seconds * 1000, signals.signal);
      } finally {
        closeSync(eventsFd);
        closeSync(errorsFd);
      }
      const receipts = jsonLines(config.receipts);
      const events = jsonLines(path.join(runDir, 'events.jsonl'));
      const checks = assess(receipts, markers, returncode, events);
      const result = { status: Object.values(checks).every(Boolean) ? 'passed' : 'failed', checks,
        artifacts: runDir, duration_seconds: Math.round((performance.now() / 1000 - started) * 100) / 100,
        routes: receipts.map((entry) => Object.fromEntries(
          Object.entries(entry).filter(([key]) => key !== 'recipients'))) };
      writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(result, null, 2));
      emit(result);
      return result.status === 'passed' ? 0 : 1;
    } finally {
      closeSync(routerErrors);
    }
  } finally {
    signals.dispose();
    try {
      const stopped = await Promise.allSettled([child, router].filter(Boolean).map(killGroup));
      const failed = stopped.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
    } finally {
      rmSync(home, { recursive: true, force: true });
      emit({ event: 'pilot.stopped', artifacts: runDir, temporary_credentials_removed: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await run();
}
