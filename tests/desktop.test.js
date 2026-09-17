import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { mergeConfig, privateWrite, plistDocument, copyRuntime } from '../scripts/desktop.js';
import { parseToml } from '../scripts/toml.js';
import { ROOT } from '../scripts/worker.js';

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencodex-desktop-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('merging preserves unrelated settings, comments and is idempotent', () => {
  const original = '# User settings\nmodel="gpt-6-astra"\n[features]\nmemories=true\n[features.context_management]\nexperimental_mode=true\n[mcp_servers.example]\ncommand="example"\n';
  const result = mergeConfig(original, { '': { model_provider: 'opencodex' }, features: { multi_agent: true }, agents: { default_subagent_model: 'deepseek-flash' } });
  const data = parseToml(result);
  assert.equal(data.mcp_servers.example.command, 'example');
  assert.equal(data.features.memories, true);
  assert.equal(data.features.context_management.experimental_mode, true);
  assert.equal(data.model, 'gpt-6-astra');
  assert.match(result, /# User settings/);
  assert.equal(mergeConfig(result, { '': { model_provider: 'opencodex' } }), result);
});

test('merging without a trailing newline preserves the preceding value', () => {
  assert.deepEqual(parseToml(mergeConfig('model="native"', { '': { model_provider: 'opencodex' } })), {
    model: 'native', model_provider: 'opencodex',
  });
});

test('ambiguous inline and multiline TOML changes fail without disclosing content', () => {
  assert.throws(() => mergeConfig('features={memories=true}\n', { features: { multi_agent: true } }));
  assert.throws(() => mergeConfig('model="""private\nvalue"""\n', { '': { model: 'new' } }));
  assert.throws(() => parseToml('private="secret'), error => !error.message.includes('secret'));
});

test('private writes replace atomically with restricted permissions and reject symlinks', t => {
  const dir = temporary(t);
  const file = path.join(dir, 'config.toml');
  fs.writeFileSync(file, 'before', { mode: 0o644 });
  privateWrite(file, 'after');
  assert.equal(fs.readFileSync(file, 'utf8'), 'after');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const victim = path.join(dir, 'victim');
  fs.writeFileSync(victim, 'preserved');
  fs.symlinkSync(victim, file + '.tmp');
  assert.throws(() => privateWrite(file, 'bad'));
  assert.equal(fs.readFileSync(victim, 'utf8'), 'preserved');
});

test('LaunchAgent plist preserves escaped paths and native value types', t => {
  const dir = temporary(t);
  const definition = { Label: 'example', ProgramArguments: ['/a & b/<node>', '"quoted"'], RunAtLoad: true, KeepAlive: false, ThrottleInterval: 10 };
  const file = path.join(dir, 'agent.plist');
  fs.writeFileSync(file, plistDocument(definition));
  const result = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), definition);
});

test('copied runtime resolves its bundled TOML parser without the source installation', t => {
  const runtime = path.join(temporary(t), 'runtime');
  copyRuntime(ROOT, runtime);
  const code = `const { mergeConfig } = await import(${JSON.stringify(pathToFileURL(path.join(runtime, 'scripts/desktop.js')).href)}); console.log(mergeConfig('', {'': {model:'native'}}));`;
  const result = spawnSync(process.execPath, ['--no-experimental-detect-module', '--input-type=module', '-e', code], { cwd: runtime, env: { HOME: runtime, PATH: '' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(parseToml(result.stdout).model, 'native');
  assert.equal(fs.existsSync(path.join(runtime, 'scripts/desktop.py')), false);
});
