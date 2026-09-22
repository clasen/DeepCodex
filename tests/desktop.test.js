import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { mergeConfig, mergeAgentInstructions, privateWrite, plistDocument, copyRuntime } from '../scripts/desktop.js';
import { parseToml } from '../scripts/toml.js';
import { ROOT } from '../scripts/worker.js';

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deepcodex-desktop-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('global instructions refresh the managed block on reinstall and preserve user content', () => {
  const block = '<!-- DEEPCODEX_START -->\n## DeepCodex\n\n' +
    'Keep the orchestrator on the user\'s selected model.\n' +
    'Prefer DeepSeek Flash for bounded execution tasks through\n' +
    'the `deepcodex:delegate-flash` skill.\n' +
    '<!-- DEEPCODEX_END -->';
  for (const original of ['', '# My rules\nKeep changes narrow.\n', '# My rules\r\nNo trailing newline']) {
    const installed = mergeAgentInstructions(original);
    assert.equal(installed, block + '\n\n' + original);
    assert.ok(installed.endsWith(original));
    assert.equal(mergeAgentInstructions(installed), installed);
    const customized = installed.replace('Keep the orchestrator on the user\'s selected model.', 'Coordinate and review the results.');
    assert.equal(mergeAgentInstructions(customized), installed);
    assert.equal(mergeAgentInstructions(customized, { remove: true }), original);
    assert.equal(mergeAgentInstructions(original, { remove: true }), original);
    const laterEdits = '# Added before\n' + installed + '\n# Added after';
    assert.equal(mergeAgentInstructions('# Added before\n' + customized + '\n# Added after'), laterEdits);
    assert.equal(mergeAgentInstructions(laterEdits, { remove: true }), '# Added before\n' + original + '\n# Added after');
  }
});

test('updating an old instruction block preserves surrounding CRLF text and its position', () => {
  const before = '# User instructions\r\nKeep this.\r\n\r\n';
  const after = '\r\n\r\n# More instructions\r\nNo trailing newline';
  const old = '<!-- DEEPCODEX_START -->\r\n## DeepCodex\r\nOld delegation instructions.\r\n<!-- DEEPCODEX_END -->';
  const current = mergeAgentInstructions('').trimEnd();
  const updated = mergeAgentInstructions(before + old + after);
  assert.equal(updated, before + current + after);
  assert.equal(mergeAgentInstructions(updated), updated);
});

test('incomplete, reversed or duplicate instruction markers fail without returning modified content', () => {
  const start = '<!-- DEEPCODEX_START -->';
  const end = '<!-- DEEPCODEX_END -->';
  for (const text of [start, end, end + start, start + start + end, start + end + end]) {
    assert.throws(() => mergeAgentInstructions(text), /Invalid DeepCodex instruction markers/);
    assert.throws(() => mergeAgentInstructions(text, { remove: true }), /Invalid DeepCodex instruction markers/);
  }
});

test('merging preserves unrelated settings, comments and is idempotent', () => {
  const original = '# User settings\nmodel="gpt-6-astra"\n[features]\nmemories=true\n[features.context_management]\nexperimental_mode=true\n[mcp_servers.example]\ncommand="example"\n';
  const result = mergeConfig(original, { '': { model_provider: 'deepcodex' }, features: { multi_agent: true }, agents: { default_subagent_model: 'deepseek-flash' } });
  const data = parseToml(result);
  assert.equal(data.mcp_servers.example.command, 'example');
  assert.equal(data.features.memories, true);
  assert.equal(data.features.context_management.experimental_mode, true);
  assert.equal(data.model, 'gpt-6-astra');
  assert.match(result, /# User settings/);
  assert.equal(mergeConfig(result, { '': { model_provider: 'deepcodex' } }), result);
});

test('merging without a trailing newline preserves the preceding value', () => {
  assert.deepEqual(parseToml(mergeConfig('model="native"', { '': { model_provider: 'deepcodex' } })), {
    model: 'native', model_provider: 'deepcodex',
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
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  if (process.platform === 'win32') return;
  const victim = path.join(dir, 'victim');
  fs.writeFileSync(victim, 'preserved');
  fs.symlinkSync(victim, file + '.tmp');
  assert.throws(() => privateWrite(file, 'bad'));
  assert.equal(fs.readFileSync(victim, 'utf8'), 'preserved');
});

test('LaunchAgent plist preserves escaped paths and native value types', { skip: process.platform !== 'darwin' }, t => {
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
