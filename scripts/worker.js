#!/usr/bin/env node
// Run a bounded Codex worker against DeepSeek without changing user config.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { killProcessTree, resolveExecutable, spawnPlan } from './platform.js';
import { ensurePrivateDirectory, privateOpen } from './private-files.js';
import { parseToml } from './toml.js';

export const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const SQLITE_BUSY = 5;
const ALLOWED_ENVIRONMENT = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TEMP', 'TMP', 'LANG',
  'CODEX_HOME', 'XDG_CONFIG_HOME',
  // Windows: the shell and the Codex CLI need these to start and to find the user profile.
  'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'PROGRAMDATA', 'USERNAME']);

// Windows environment names are case-insensitive, but its own tools and the DeepCodex service read
// exact spellings (env.SystemRoot), so forwarded Windows variables keep the spelling the OS uses.
const WINDOWS_ENVIRONMENT_CASE = new Map([
  ['SYSTEMROOT', 'SystemRoot'], ['COMSPEC', 'ComSpec'], ['WINDIR', 'windir'], ['PROGRAMDATA', 'ProgramData'],
]);
const REQUIRED_CLI_FLAGS = ['--ignore-user-config', '--ephemeral', '--json', '--strict-config'];
const USAGE = 'Usage: worker.js <doctor|run> [options]';

export const HELP = `${USAGE}

Run a bounded Codex worker against DeepSeek without changing user config.

Commands:
  doctor  Check local prerequisites without inference
  run     Execute one ticket; consumes DeepSeek API usage

Run options:
  --cwd PATH        Workspace directory for the ticket (required)
  --task-file PATH  File holding the ticket text (required)
  --write           Allow workspace writes for an authorized editing task

Options:
  -h, --help        Show this help message
`;

export function loadConfig() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'config/worker.json'), 'utf8'));
}

export function configArgs(values, prefix = '') {
  const args = [];
  for (const [key, value] of Object.entries(values)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (isTable(value)) args.push(...configArgs(value, name));
    else args.push('-c', `${name}=${JSON.stringify(value)}`);
  }
  return args;
}

export function workerEnvironment(source) {
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (key.startsWith('LC_')) {
      env[key] = value;
      continue;
    }
    // Windows environment names are case-insensitive, so the allowlist matches regardless of the
    // spelling the platform reports and every forwarded name is normalised, except where the OS has
    // its own spelling (SystemRoot, ComSpec, windir, ProgramData).
    const name = key.toUpperCase();
    if (ALLOWED_ENVIRONMENT.has(name)) env[WINDOWS_ENVIRONMENT_CASE.get(name) ?? name] = value;
  }
  if (source.DEEPSEEK_API_KEY) env.DEEPSEEK_API_KEY = source.DEEPSEEK_API_KEY;
  return env;
}

export function readEnvKey(file, name) {
  let value = null;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r\n|\r|\n/)) {
    let text = line.trim();
    if (text.startsWith('export ')) text = text.slice(7).replace(/^\s+/, '');
    const separator = text.indexOf('=');
    if (separator === -1 || text.slice(0, separator).trim() !== name) continue;
    if (value !== null) throw new Error(`Duplicate ${name} in credentials file`);
    let parts;
    try {
      parts = shlexSplit(text.slice(separator + 1));
    } catch {
      throw new Error(`Invalid ${name} quoting in credentials file`);
    }
    if (parts.length !== 1 || !parts[0]) throw new Error(`Invalid or empty ${name} in credentials file`);
    value = parts[0];
  }
  if (value === null) throw new Error(`Missing ${name} in credentials file`);
  return value;
}

export function loadCredentials(env, config) {
  const provider = config.codex.model_provider;
  const name = config.codex.model_providers[provider].env_key;
  if (!env[name]) {
    const file = expandUser(config.credentials.env_file);
    try {
      env[name] = readEnvKey(file, name);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

export function redact(value, secret) {
  if (typeof value === 'string') return secret ? value.split(secret).join('[REDACTED]') : value;
  if (Array.isArray(value)) return value.map(item => redact(item, secret));
  if (isTable(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, secret)]));
  }
  return value;
}

// Desktop bundles the CLI but does not necessarily expose it on PATH.
export function resolveCodex(env, { platform = process.platform, applicationDirs = [
  path.join(env.HOME || os.homedir(), 'Applications'), '/Applications',
] } = {}) {
  const binary = resolveExecutable('codex', { searchPath: env.PATH, platform, pathext: env.PATHEXT });
  if (binary || platform !== 'darwin') return binary;
  for (const directory of applicationDirs) {
    for (const app of ['Codex.app', 'ChatGPT.app']) {
      const bundled = resolveExecutable('codex', { searchPath: path.join(directory, app, 'Contents', 'Resources'), platform });
      if (bundled) return bundled;
    }
  }
  return undefined;
}

export function doctor(config, env, discoveryOptions) {
  const binary = resolveCodex(env, discoveryOptions);
  const report = { status: 'ready', codex: binary ?? null, api_key_present: Boolean(env.DEEPSEEK_API_KEY) };
  if (binary) {
    const timeout = config.limits.version_timeout_seconds * 1000;
    const version = probe([binary, '--version'], env, timeout);
    const help = probe([binary, 'exec', '--help'], env, timeout);
    report.version = version.stdout.trim();
    report.compatible_cli = version.status === 0 && help.status === 0
      && REQUIRED_CLI_FLAGS.every(flag => help.stdout.includes(flag));
  }
  const errors = [];
  if (!binary) errors.push('Codex CLI not found on PATH or in Codex.app/ChatGPT.app under ~/Applications or /Applications. Install Codex Desktop or add a compatible codex CLI to PATH.');
  else if (!report.compatible_cli) errors.push(`Codex CLI at ${binary} is incompatible; required exec flags: ${REQUIRED_CLI_FLAGS.join(', ')}. Update Codex Desktop or the CLI on PATH.`);
  if (!report.api_key_present) errors.push('DeepSeek API key is missing. Run deepcodex configure.');
  if (errors.length) {
    report.status = 'not_ready';
    report.errors = errors;
  }
  return report;
}

export function checkProjectConfig(cwd) {
  const userConfig = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'config.toml');
  for (const directory of ancestors(cwd)) {
    const candidate = path.join(directory, '.codex', 'config.toml');
    if (candidate === userConfig || !isFile(candidate)) continue;
    const data = parseToml(fs.readFileSync(candidate, 'utf8'));
    if (pythonTruthy(data?.mcp_servers)) {
      throw new Error(`Project MCP servers are not supported by this worker: ${candidate}`);
    }
  }
}

// Exclusive lock released by the kernel when the process dies, so a crashed worker cannot block the
// next one. The lock file lives in the per-user temporary directory and is opened owner-only, which
// private-files.js implements with POSIX bits and a Windows ACL. Windows has no uid, so its lock name
// is per-user anyway because the temporary directory already is. node:sqlite is loaded here so help
// and doctor stay free of its experimental warning.
export async function workerLock({ platform = process.platform, uid = process.getuid?.(), ...privateOptions } = {}) {
  const owner = platform === 'win32' ? 'user' : uid;
  const file = path.join(os.tmpdir(), `deepcodex-worker-${owner}.lock`);
  const fd = privateOpen(file, { ...privateOptions, platform, flags: fs.constants.O_CREAT | fs.constants.O_RDWR });
  fs.closeSync(fd);
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(file, { timeout: 0 });
  try {
    database.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    database.close();
    if (error.errcode === SQLITE_BUSY) throw new Error('Another DeepCodex worker is running; wait for it or cancel that run');
    throw error;
  }
  let closed = false;
  return {
    close() {
      if (closed) return;
      closed = true;
      try {
        if (database.isTransaction) database.exec('ROLLBACK');
      } catch {
        // Closing the handle releases the lock even when the transaction cannot be rolled back.
      }
      database.close();
    },
    [Symbol.dispose]() {
      this.close();
    },
  };
}

export function buildCommand(binary, config, cwd, write, runDir) {
  const metadata = { ...config.model_metadata };
  metadata.slug = config.codex.model;
  metadata.base_instructions = fs.readFileSync(path.join(ROOT, 'prompts/worker.md'), 'utf8');
  const catalog = path.join(runDir, 'models.json');
  fs.writeFileSync(catalog, JSON.stringify({ models: [metadata] }));
  const finalPath = path.join(runDir, 'final.txt');
  const args = [binary, 'exec', '--ignore-user-config', '--ephemeral', '--json', '--strict-config',
    '--skip-git-repo-check', '--color', 'never', '--cd', cwd,
    '--sandbox', write ? 'workspace-write' : 'read-only',
    '--output-last-message', finalPath];
  args.push(...configArgs(config.codex));
  args.push('-c', `model_catalog_json=${JSON.stringify(catalog)}`, '-');
  return { args, finalPath };
}

export function parseResult(stdout, stderr, finalText, returncode, stopReason, config) {
  let completed = false;
  let failed = false;
  const errors = [];
  let usage = null;
  let threadId = null;
  let malformed = false;
  for (const line of stdout.split(/\r\n|\r|\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
      if (!isTable(event)) throw new Error('event must be an object');
    } catch {
      malformed = true;
      continue;
    }
    if (event.type === 'thread.started') {
      threadId = event.thread_id ?? null;
    } else if (event.type === 'turn.completed') {
      completed = true;
      usage = event.usage ?? null;
      if (!failed) errors.length = 0;
    } else if (event.type === 'turn.failed' || event.type === 'error') {
      if (event.type === 'turn.failed') failed = true;
      errors.push(pick(event, 'error', pick(event, 'message', 'Worker error')));
    }
  }
  const status = stopReason
    || (returncode === 0 && completed && finalText.trim() && errors.length === 0 && !malformed ? 'completed' : 'failed');
  const result = {
    status,
    exit_code: returncode,
    thread_id: threadId,
    configured_model: config.codex.model,
    configured_provider: config.codex.model_provider,
    usage,
  };
  if (finalText) {
    const cap = config.limits.max_result_chars;
    result.result = head(finalText, cap);
    result.result_truncated = finalText.length > cap;
  }
  if (malformed) errors.push('Invalid JSONL from Codex');
  if (status !== 'completed') {
    if (errors.length === 0) errors.push('Worker did not produce a complete turn and a non-empty final response');
    result.errors = JSON.stringify(errors).slice(0, config.limits.max_error_chars);
    result.diagnostic = tail(stderr, config.limits.max_error_chars);
    result.partial_changes_possible = true;
  }
  return result;
}

// Kept as the worker's public name; the platform module owns the POSIX/Windows differences.
export const killGroup = killProcessTree;

export async function runWorker(binary, config, cwd, task, write, env) {
  checkProjectConfig(cwd);
  const started = monotonic();
  const { limits } = config;
  const lock = await workerLock();
  let runDir = null;
  try {
    runDir = ensurePrivateDirectory(fs.mkdtempSync(path.join(os.tmpdir(), 'deepcodex-run-')));
    const { args, finalPath } = buildCommand(binary, config, cwd, write, runDir);
    const taskPath = path.join(runDir, 'task.txt');
    const outPath = path.join(runDir, 'events.jsonl');
    const errPath = path.join(runDir, 'stderr.txt');
    const artifacts = [outPath, errPath, finalPath];
    fs.writeFileSync(taskPath, task);
    let stopReason = null;
    let child = null;
    const stdin = fs.openSync(taskPath, 'r');
    const stdout = fs.openSync(outPath, 'w');
    const stderr = fs.openSync(errPath, 'w');
    try {
      // spawn() supplies argv[0] itself, so args[0] (the binary) must not be repeated in the list.
      const plan = spawnPlan(binary, args.slice(1), { env });
      child = spawn(plan.file, plan.args, { cwd, env, detached: true, stdio: [stdin, stdout, stderr], ...plan.options });
      await waitForSpawn(child);
      process.stderr.write(`${JSON.stringify({ event: 'worker.started', pid: child.pid, cwd, model: config.codex.model })}\n`);
      while (child.exitCode === null && child.signalCode === null) {
        if (cancellationRequested) {
          stopReason = 'cancelled';
          break;
        }
        if (monotonic() - started >= limits.timeout_seconds) {
          stopReason = 'timeout';
          break;
        }
        if (artifactBytes(artifacts) > limits.max_output_bytes) {
          stopReason = 'output_limit';
          break;
        }
        await pause(limits.poll_interval_seconds * 1000);
      }
    } finally {
      try {
        // Also terminate descendants left behind after Codex exits.
        await killGroup(child);
      } finally {
        fs.closeSync(stdin);
        fs.closeSync(stdout);
        fs.closeSync(stderr);
      }
    }
    if (artifactBytes(artifacts) > limits.max_output_bytes) stopReason ??= 'output_limit';
    const returncode = child ? exitCodeOf(child) : null;
    const result = stopReason === 'output_limit'
      ? parseResult('', 'Worker output exceeded the configured limit', '', returncode, stopReason, config)
      : parseResult(readText(outPath), readText(errPath), readTextIfExists(finalPath), returncode, stopReason, config);
    result.duration_seconds = Math.round((monotonic() - started) * 100) / 100;
    result.worker_pid = child?.pid ?? null;
    result.cwd = cwd;
    result.sandbox = write ? 'workspace-write' : 'read-only';
    return result;
  } finally {
    if (runDir) fs.rmSync(runDir, { recursive: true, force: true });
    lock.close();
  }
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    process.stdout.write(parsed.text);
    return 0;
  }
  if (parsed.error) {
    process.stderr.write(`${USAGE}\n${parsed.error}\n`);
    return 2;
  }
  const env = workerEnvironment(process.env);
  const config = loadConfig();
  resetCancellation();
  process.on('SIGTERM', requestCancellation);
  process.on('SIGINT', requestCancellation);
  let report;
  try {
    loadCredentials(env, config);
    report = doctor(config, env);
    if (parsed.command === 'run' && report.status === 'ready') {
      const cwd = fs.realpathSync(expandUser(parsed.cwd));
      if (!isDirectory(cwd)) throw new Error('cwd must be a directory');
      const task = readTicket(parsed.taskFile, config.limits.max_task_bytes);
      if (!task.trim()) throw new Error('Ticket must not be empty');
      report = await runWorker(report.codex, config, cwd, task, parsed.write, env);
    }
    if (parsed.command === 'run' && report.status === 'not_ready') {
      report.error = 'Run doctor and resolve missing prerequisites before delegation';
    }
  } catch (error) {
    report = { status: 'failed', error: errorMessage(error) };
  } finally {
    process.off('SIGTERM', requestCancellation);
    process.off('SIGINT', requestCancellation);
  }
  process.stdout.write(`${JSON.stringify(redact(report, env.DEEPSEEK_API_KEY))}\n`);
  return report.status === 'ready' || report.status === 'completed' ? 0 : 1;
}

let cancellationRequested = false;
let wakeCancellable = null;

// main() registers these while it runs, so SIGINT/SIGTERM also cancel a worker started through the
// CLI, which imports main() instead of executing this file as the entrypoint.
export function requestCancellation() {
  cancellationRequested = true;
  const wake = wakeCancellable;
  wakeCancellable = null;
  if (wake) wake();
}

function resetCancellation() {
  cancellationRequested = false;
}

function parseArgs(argv) {
  const command = argv[0];
  const rest = argv.slice(1);
  if (command === undefined || command === '--help' || command === '-h') return { help: true, text: HELP };
  if (command !== 'doctor' && command !== 'run') return { error: `Unknown command: ${command}` };
  const options = { command, write: false };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--help' || arg === '-h') return { help: true, text: HELP };
    if (command !== 'run') return { error: `Unexpected argument for doctor: ${arg}` };
    if (arg === '--write') {
      options.write = true;
      continue;
    }
    const separator = arg.indexOf('=');
    const flag = separator === -1 ? arg : arg.slice(0, separator);
    if (flag !== '--cwd' && flag !== '--task-file') return { error: `Unknown option: ${arg}` };
    let value;
    if (separator === -1) {
      index += 1;
      value = rest[index];
    } else {
      value = arg.slice(separator + 1);
    }
    if (value === undefined) return { error: `Option ${flag} requires a value` };
    if (flag === '--cwd') options.cwd = value;
    else options.taskFile = value;
  }
  if (command === 'run' && options.cwd === undefined) return { error: 'Option --cwd is required' };
  if (command === 'run' && options.taskFile === undefined) return { error: 'Option --task-file is required' };
  return options;
}

function readTicket(file, maxTaskBytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(maxTaskBytes + 1);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (read > maxTaskBytes) throw new Error('Ticket exceeds max_task_bytes');
    // Strict UTF-8 like Python's bytes.decode, keeping a BOM instead of stripping it.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
}

function probe(args, env, timeout) {
  const plan = spawnPlan(args[0], args.slice(1), { env });
  const result = spawnSync(plan.file, plan.args, { env, timeout, encoding: 'utf8', ...plan.options });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? '' };
}

function waitForSpawn(child) {
  return new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
}

function pause(milliseconds) {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      wakeCancellable = null;
      resolve();
    }, Math.max(milliseconds, 0));
    wakeCancellable = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

function exitCodeOf(child) {
  if (typeof child.exitCode === 'number') return child.exitCode;
  const signal = child.signalCode ? os.constants.signals[child.signalCode] : undefined;
  return signal === undefined ? null : -signal;
}

function artifactBytes(files) {
  let total = 0;
  for (const file of files) {
    try {
      total += fs.statSync(file).size;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return total;
}

function ancestors(cwd) {
  const directories = [];
  let directory = cwd;
  while (directory !== path.dirname(directory)) {
    directories.push(directory);
    directory = path.dirname(directory);
  }
  directories.push(directory);
  return directories;
}

// Windows keeps HOME only in POSIX-style shells, so the profile is resolved there the same way the
// credentials writer and the Codex CLI resolve it.
function homeDirectory() {
  return process.platform === 'win32' ? os.homedir() : process.env.HOME ?? os.homedir();
}

function expandUser(file) {
  if (file === '~') return homeDirectory();
  if (file.startsWith('~/')) return path.join(homeDirectory(), file.slice(2));
  return file;
}

function isTable(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value);
}

function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function readText(file) {
  return fs.readFileSync(file, 'utf8');
}

function readTextIfExists(file) {
  return fs.existsSync(file) ? readText(file) : '';
}

function monotonic() {
  return Number(process.hrtime.bigint()) / 1e9;
}

function pick(object, key, fallback) {
  return Object.hasOwn(object, key) ? object[key] : fallback;
}

function head(text, cap) {
  return cap > 0 ? text.slice(0, cap) : '';
}

function tail(text, cap) {
  return cap > 0 ? text.slice(-cap) : '';
}

function pythonTruthy(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (isTable(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}

function errorMessage(error) {
  return error && typeof error.message === 'string' ? error.message : String(error);
}

// POSIX shlex.split(text, comments=True): quotes and escapes only, never shell expansion.
function shlexSplit(text) {
  const tokens = [];
  let current = '';
  let word = false;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f' || char === '\v') {
      if (word) {
        tokens.push(current);
        current = '';
        word = false;
      }
      index += 1;
      continue;
    }
    // shlex also comments out '#' inside an unquoted word, keeping the word read so far.
    if (char === '#') {
      if (word) {
        tokens.push(current);
        current = '';
        word = false;
      }
      break;
    }
    if (char === '\\') {
      if (index + 1 >= text.length) throw new Error('No escaped character');
      current += text[index + 1];
      word = true;
      index += 2;
      continue;
    }
    if (char === "'") {
      const end = text.indexOf("'", index + 1);
      if (end === -1) throw new Error('No closing quotation');
      current += text.slice(index + 1, end);
      word = true;
      index = end + 1;
      continue;
    }
    if (char === '"') {
      let cursor = index + 1;
      let closed = false;
      while (cursor < text.length) {
        const quoted = text[cursor];
        if (quoted === '"') {
          closed = true;
          cursor += 1;
          break;
        }
        if (quoted === '\\') {
          const next = text[cursor + 1];
          if (next === undefined) throw new Error('No escaped character');
          // shlex escapes only the quote and the backslash here; every other backslash stays literal.
          current += next === '"' || next === '\\' ? next : `\\${next}`;
          cursor += 2;
          continue;
        }
        current += quoted;
        cursor += 1;
      }
      if (!closed) throw new Error('No closing quotation');
      word = true;
      index = cursor;
      continue;
    }
    current += char;
    word = true;
    index += 1;
  }
  if (word) tokens.push(current);
  return tokens;
}

function isEntrypoint() {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return pathToFileURL(fs.realpathSync(invoked)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main().then(code => {
    process.exitCode = code;
  }, error => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
