import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { copyRuntime } from '../scripts/desktop.js';
import { parseToml } from '../scripts/toml.js';
import { ROOT } from '../scripts/worker.js';

function fixture(t, healthy, { bundled = false, incompatible = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'opencodex-install-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const source = path.join(root, 'source');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.mkdirSync(bin);
  copyRuntime(ROOT, source);
  const desktopFile = path.join(source, 'config/desktop.json');
  const desktop = JSON.parse(fs.readFileSync(desktopFile));
  desktop.startup_timeout_seconds = 0;
  fs.writeFileSync(desktopFile, JSON.stringify(desktop));
  const original = '# Preserve this\nmodel="gpt-6-astra"\n[mcp_servers.example]\ncommand="example"\n';
  const configPath = path.join(home, '.codex/config.toml');
  fs.writeFileSync(configPath, original);
  fs.writeFileSync(path.join(bin, 'codex'), `#!${process.execPath}
    const args = process.argv.slice(2);
    if (args[0] === '--version') console.log('codex fixture');
    else if (args.join(' ') === 'exec --help') console.log('--ignore-user-config --ephemeral --json --strict-config');
    else if (args.join(' ') === 'debug models --bundled') console.log(JSON.stringify({models:[{slug:'gpt-6-astra'}]}));
    else process.exit(9);
  `, { mode: 0o700 });
  if (incompatible) fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\necho incompatible\n');
  if (bundled) {
    const resources = path.join(home, 'Applications/ChatGPT.app/Contents/Resources');
    fs.mkdirSync(resources, { recursive: true });
    fs.renameSync(path.join(bin, 'codex'), path.join(resources, 'codex'));
  }
  const calls = path.join(root, 'launchctl.jsonl');
  fs.writeFileSync(path.join(bin, 'launchctl'), `#!${process.execPath}
    require('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');
  `, { mode: 0o700 });
  const preload = path.join(root, 'health.js');
  fs.writeFileSync(preload, `globalThis.fetch = async () => { ${healthy ? "return new Response(JSON.stringify({status:'ready',pid:123}));" : "throw new Error('fixture unhealthy');"} };`);
  const result = spawnSync(process.execPath, ['--import', preload, path.join(source, 'scripts/desktop.js'), 'install'], {
    env: { HOME: home, PATH: bin, DEEPSEEK_API_KEY: 'fixture-key' }, encoding: 'utf8',
  });
  return { home, source, configPath, original, result, calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse) : [] };
}

test('installation builds a Node LaunchAgent and preserves unrelated configuration', t => {
  const { home, source, configPath, original, result, calls } = fixture(t, true);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'ready');
  const parsed = parseToml(fs.readFileSync(configPath, 'utf8'));
  assert.equal(parsed.model, 'gpt-6-astra');
  assert.equal(parsed.mcp_servers.example.command, 'example');
  assert.equal(parsed.model_provider, 'opencodex');
  assert.equal(fs.readFileSync(report.backup, 'utf8'), original);
  assert.deepEqual(calls.map(args => args[0]), ['bootout', 'bootstrap']);
  const plist = path.join(home, 'Library/LaunchAgents/com.deepcodex.router.plist');
  const converted = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' });
  assert.equal(converted.status, 0, converted.stderr);
  const definition = JSON.parse(converted.stdout);
  assert.deepEqual(definition.ProgramArguments, [process.execPath, path.join(report.cwd, 'scripts/desktop.js'), 'serve']);
  fs.rmSync(source, { recursive: true });
  const runtime = spawnSync(process.execPath, [path.join(report.cwd, 'scripts/desktop.js'), '--help'], {
    env: { HOME: home, PATH: '' }, encoding: 'utf8',
  });
  assert.equal(runtime.status, 0, runtime.stderr);
});

test('installation uses the Desktop CLI without a codex command on PATH', t => {
  const { result, calls } = fixture(t, true, { bundled: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'ready');
  assert.deepEqual(calls.map(args => args[0]), ['bootout', 'bootstrap']);
});

test('incompatible CLI explains the prerequisite failure before modifying configuration', t => {
  const { configPath, original, result, calls } = fixture(t, true, { incompatible: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /DeepCodex prerequisites are not ready:.*incompatible.*--strict-config/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  assert.deepEqual(calls, []);
});

test('unhealthy service leaves user configuration unchanged and stops the attempted service', t => {
  const { configPath, original, result, calls } = fixture(t, false);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /did not become healthy/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  assert.deepEqual(calls.map(args => args[0]), ['bootout', 'bootstrap', 'bootout']);
});
