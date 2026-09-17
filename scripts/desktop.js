import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { ROOT, loadConfig, workerEnvironment, loadCredentials, doctor } from './worker.js';
import { parseToml } from './toml.js';
import { startPilot } from './pilot-router.js';

const STATE = path.join(os.homedir(), '.config/opencodex/desktop');
const readJson = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const expandHome = filename => filename.startsWith('~/') ? path.join(os.homedir(), filename.slice(2)) : filename;

export function privateWrite(filename, content) {
  const temporary = filename + '.tmp';
  const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, content);
  } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, filename);
}

export function mergeConfig(text, sections) {
  const expected = parseToml(text);
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
  if (lines.length && !lines.at(-1).endsWith('\n')) lines[lines.length - 1] += '\n';
  for (const [section, values] of Object.entries(sections)) {
    let target = expected;
    for (const key of section ? section.split('.') : []) {
      if (!Object.hasOwn(target, key)) target[key] = {};
      target = target[key];
    }
    Object.assign(target, values);
    let start = 0;
    if (section) {
      const match = lines.findIndex(line => line.trim() === `[${section}]`);
      if (match < 0) {
        lines.push(`\n[${section}]\n`);
        start = lines.length;
      } else start = match + 1;
    }
    let end = lines.findIndex((line, i) => i >= start && line.trimStart().startsWith('['));
    if (end < 0) end = lines.length;
    const block = lines.slice(start, end);
    for (const [key, value] of Object.entries(values)) {
      const assignment = `${key} = ${JSON.stringify(value)}\n`;
      const indices = block.flatMap((line, i) => line.trimStart().startsWith(key) && line.trimStart().slice(key.length).trimStart().startsWith('=') ? [i] : []);
      if (indices.length > 1) throw new Error(`Duplicate managed field: ${section}.${key}`);
      if (indices.length) block[indices[0]] = assignment;
      else block.push(assignment);
    }
    lines.splice(start, end - start, ...block);
  }
  const result = lines.join('');
  if (!isDeepStrictEqual(parseToml(result), expected)) throw new Error('Configuration merge changed unrelated settings');
  return result;
}

function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

export function plistDocument(value) {
  const encode = item => {
    if (typeof item === 'boolean') return item ? '<true/>' : '<false/>';
    if (typeof item === 'number' && Number.isInteger(item)) return `<integer>${item}</integer>`;
    if (typeof item === 'string') return `<string>${xml(item)}</string>`;
    if (Array.isArray(item)) return `<array>${item.map(encode).join('')}</array>`;
    if (item && typeof item === 'object') return `<dict>${Object.entries(item).map(([key, entry]) => `<key>${xml(key)}</key>${encode(entry)}`).join('')}</dict>`;
    throw new Error('Unsupported LaunchAgent value');
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${encode(value)}</plist>\n`;
}

export function copyRuntime(root, runtime) {
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  for (const directory of ['scripts', 'config', 'prompts', 'vendor']) {
    fs.cpSync(path.join(root, directory), path.join(runtime, directory), { recursive: true,
      filter: source => !['__pycache__', '.env', '.DS_Store'].includes(path.basename(source)) && !/\.py[cod]?$/.test(source) });
  }
  fs.copyFileSync(path.join(root, 'package.json'), path.join(runtime, 'package.json'));
  const dependency = path.dirname(path.dirname(fileURLToPath(import.meta.resolve('smol-toml'))));
  fs.cpSync(dependency, path.join(runtime, 'node_modules/smol-toml'), { recursive: true });
}

export async function health(state) {
  const response = await fetch(`http://127.0.0.1:${state.config.port}/health`, {
    headers: { 'x-opencodex-pilot': state.capability },
    signal: AbortSignal.timeout(state.config.startup_timeout_seconds * 1000),
  });
  if (!response.ok) throw new Error(`Router health HTTP ${response.status}`);
  return response.json();
}

export async function install() {
  if (process.platform !== 'darwin') throw new Error('The Desktop installer requires macOS');
  const config = { ...readJson(path.join(ROOT, 'config/pilot.json')), ...readJson(path.join(ROOT, 'config/desktop.json')) };
  const original = loadConfig();
  const env = workerEnvironment(process.env);
  loadCredentials(env, original);
  const diagnosis = doctor(original, env);
  if (diagnosis.status !== 'ready') throw new Error('OpenCodex worker doctor must be ready before installation');
  const configPath = path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
  const before = fs.readFileSync(configPath, 'utf8');
  const parsed = parseToml(before);
  if (!['openai', 'opencodex'].includes(parsed.model_provider ?? 'openai')) throw new Error('An unrelated custom provider is active; refusing to replace it');
  if (parsed.openai_base_url || parsed.chatgpt_base_url) throw new Error('An existing endpoint override needs an explicit integration plan');
  fs.mkdirSync(STATE, { recursive: true, mode: 0o700 });
  fs.chmodSync(STATE, 0o700);
  const runtime = path.join(os.homedir(), '.local/share/opencodex/runtime');
  copyRuntime(ROOT, runtime);
  let catalog;
  if (parsed.model_catalog_json && path.resolve(expandHome(parsed.model_catalog_json)) !== path.join(STATE, 'models.json')) {
    catalog = readJson(expandHome(parsed.model_catalog_json));
  } else {
    const result = spawnSync(diagnosis.codex, ['debug', 'models', '--bundled'], { encoding: 'utf8' });
    if (result.error || result.status !== 0) throw new Error('Cannot read the bundled Codex model catalog');
    catalog = JSON.parse(result.stdout);
  }
  const nativeModels = catalog.models.filter(entry => entry.slug !== original.codex.model);
  const child = { ...original.model_metadata, slug: original.codex.model, multi_agent_version: 'v2',
    base_instructions: fs.readFileSync(path.join(ROOT, 'prompts/worker.md'), 'utf8') };
  privateWrite(path.join(STATE, 'models.json'), JSON.stringify({ models: [...nativeModels, child] }));
  Object.assign(config, { native_models: nativeModels.map(entry => entry.slug), child_model: child.slug,
    deepseek_url: original.codex.model_providers['opencodex-deepseek'].base_url + '/responses',
    receipts: path.join(STATE, 'receipts.jsonl'), markers: [] });
  const statePath = path.join(STATE, 'state.json');
  const capability = fs.existsSync(statePath) ? readJson(statePath).capability : randomBytes(32).toString('base64url');
  const state = { config, capability, node: process.execPath, runtime };
  const sections = {
    '': { model_provider: 'opencodex', model_catalog_json: path.join(STATE, 'models.json') },
    agents: { enabled: true, default_subagent_model: child.slug, default_subagent_reasoning_effort: 'high' },
    features: { multi_agent: true, multi_agent_v2: true },
    'model_providers.opencodex': { name: 'OpenCodex', base_url: `http://127.0.0.1:${config.port}`, wire_api: 'responses',
      requires_openai_auth: true, supports_websockets: false, request_max_retries: 0, stream_max_retries: 0, stream_idle_timeout_ms: config.request_timeout_ms },
    'model_providers.opencodex.http_headers': { 'x-opencodex-pilot': capability },
  };
  const updated = mergeConfig(before, sections);
  privateWrite(path.join(STATE, 'config.proposed.toml'), updated);
  if (!fs.existsSync(path.join(STATE, 'config.before.toml'))) privateWrite(path.join(STATE, 'config.before.toml'), before);
  privateWrite(statePath, JSON.stringify(state));
  const label = config.service_label;
  const plist = path.join(os.homedir(), 'Library/LaunchAgents', label + '.plist');
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  privateWrite(plist, plistDocument({ Label: label, ProgramArguments: [process.execPath, path.join(runtime, 'scripts/desktop.js'), 'serve'],
    WorkingDirectory: runtime, RunAtLoad: true, KeepAlive: true, ThrottleInterval: config.service_throttle_seconds,
    StandardOutPath: path.join(STATE, 'service.log'), StandardErrorPath: path.join(STATE, 'service-errors.log'),
    EnvironmentVariables: { HOME: os.homedir(), PATH: env.PATH } }));
  const domain = `gui/${process.getuid()}`;
  spawnSync('launchctl', ['bootout', `${domain}/${label}`]);
  const bootstrap = spawnSync('launchctl', ['bootstrap', domain, plist]);
  if (bootstrap.error || bootstrap.status !== 0) throw new Error('Cannot start OpenCodex LaunchAgent');
  const deadline = Date.now() + config.startup_timeout_seconds * 1000;
  let report;
  while (!report) {
    try { report = await health(state); }
    catch {
      if (Date.now() >= deadline) {
        spawnSync('launchctl', ['bootout', `${domain}/${label}`]);
        throw new Error('Desktop router did not become healthy; user config unchanged');
      }
      await sleep(original.limits.poll_interval_seconds * 1000);
    }
  }
  if (fs.readFileSync(configPath, 'utf8') !== before) throw new Error('Codex config changed during installation; proposed config was not applied');
  privateWrite(configPath, updated);
  console.log(JSON.stringify({ ...report, service: label, port: config.port, cwd: runtime, owner: 'OpenCodex LaunchAgent',
    native_models: nativeModels.length, subagent_model: child.slug, backup: path.join(STATE, 'config.before.toml'), restart_desktop_required: true }));
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: opencodex <install|status>\nActivate or inspect the local macOS Desktop router.');
    return 0;
  }
  if (args.length !== 1 || !['install', 'serve', 'status'].includes(args[0])) throw new Error('Expected install, serve or status');
  if (args[0] === 'install') await install();
  else {
    const state = readJson(path.join(STATE, 'state.json'));
    if (args[0] === 'status') console.log(JSON.stringify({ ...await health(state), port: state.config.port, cwd: state.runtime }));
    else {
      const env = workerEnvironment(process.env);
      loadCredentials(env, loadConfig());
      if (!env.DEEPSEEK_API_KEY) throw new Error('DeepSeek credential unavailable');
      const server = await startPilot(state.config, env.DEEPSEEK_API_KEY, state.capability);
      console.log(JSON.stringify({ status: 'ready', pid: process.pid, port: server.address().port }));
    }
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
