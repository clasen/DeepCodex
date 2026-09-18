import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { copyRuntime } from '../scripts/desktop.js';
import { parseToml } from '../scripts/toml.js';
import { ROOT } from '../scripts/worker.js';

function fixture(t, healthy, { marketplace = false, bundled = false, incompatible = false, pluginFailure = false, noPluginSupport = false, stopFailure = false, startFailure = false, registrationFailure = false, instructions, customCodexHome = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deepcodex-install-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home & user's");
  const source = path.join(root, 'source');
  const bin = path.join(root, 'bin');
  const codexHome = path.join(home, customCodexHome ? 'custom-codex' : '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  if (instructions !== undefined) fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), instructions);
  fs.mkdirSync(bin);
  copyRuntime(ROOT, source);
  const desktopFile = path.join(source, 'config/desktop.json');
  const desktop = JSON.parse(fs.readFileSync(desktopFile));
  desktop.startup_timeout_seconds = 0;
  fs.writeFileSync(desktopFile, JSON.stringify(desktop));
  const original = '# Preserve this\nmodel="gpt-6-astra"\n[mcp_servers.example]\ncommand="example"\n';
  const configPath = path.join(codexHome, 'config.toml');
  fs.writeFileSync(configPath, original);
  if (marketplace) {
    fs.mkdirSync(path.join(home, '.agents/plugins'), { recursive: true });
    fs.writeFileSync(path.join(home, '.agents/plugins/marketplace.json'), JSON.stringify({
      name: 'personal', interface: { displayName: 'My plugins' }, plugins: [
        { name: 'unrelated', source: { source: 'local', path: './plugins/unrelated' } },
      ],
    }));
  }
  fs.writeFileSync(path.join(bin, 'codex'), `#!${process.execPath}
    const args = process.argv.slice(2);
    if (args[0] === '--version') console.log('codex fixture');
    else if (args.join(' ') === 'exec --help') console.log('--ignore-user-config --ephemeral --json --strict-config');
    else if (args.join(' ') === 'debug models --bundled') console.log(JSON.stringify({models:[{slug:'gpt-6-astra'}]}));
    else if (args.join(' ') === 'plugin add --help') process.exit(${noPluginSupport ? 9 : 0});
    else if (args[0] === 'plugin' && args[1] === 'add') {
      if (${pluginFailure}) process.exit(9);
      const fs = require('node:fs');
      const file = ${JSON.stringify(configPath)};
      const config = fs.readFileSync(file, 'utf8');
      if (!config.includes('[plugins."' + args[2] + '"]')) fs.appendFileSync(file, '\\n[plugins."' + args[2] + '"]\\nenabled = true\\n');
      console.log(JSON.stringify({pluginId:args[2]}));
    }
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
    if (${stopFailure} && process.argv[2] === 'bootout') {
      console.error('Boot-out failed: 1: Operation not permitted');
      process.exit(1);
    }
    if (${startFailure} && process.argv[2] === 'bootstrap') {
      console.error('Bootstrap failed: 5: Input/output error');
      process.exit(5);
    }
  `, { mode: 0o700 });
  const preload = path.join(root, 'health.js');
  fs.writeFileSync(preload, `
    import childProcess from 'node:child_process';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const spawnSync = childProcess.spawnSync;
    childProcess.spawnSync = (command, args, options) => {
      if (command.endsWith('/lsregister')) {
        fs.appendFileSync(${JSON.stringify(path.join(root, 'registration.jsonl'))}, JSON.stringify(args) + '\\n');
        return { status: ${registrationFailure ? 1 : 0}, stderr: ${JSON.stringify(registrationFailure ? 'fixture registration failure' : '')} };
      }
      return spawnSync(command, args, options);
    };
    syncBuiltinESMExports();
    globalThis.fetch = async () => { ${healthy ? "return new Response(JSON.stringify({status:'ready',pid:123}));" : "throw new Error('fixture unhealthy');"} };
  `);
  const run = () => spawnSync(process.execPath, ['--import', preload, path.join(source, 'scripts/desktop.js'), 'install'], {
    env: { HOME: home, PATH: bin, DEEPSEEK_API_KEY: 'fixture-key', ...(customCodexHome ? { CODEX_HOME: codexHome } : {}) }, encoding: 'utf8',
  });
  const result = run();
  return { home, source, configPath, original, result, run, calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse) : [] };
}

test('installation associates the LaunchAgent with a branded app that runs the copied runtime', t => {
  const { home, source, configPath, original, result, calls } = fixture(t, true);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /✓ DeepCodex installed successfully/);
  assert.match(result.stdout, /local service is running and the Codex plugin is installed/);
  assert.match(result.stdout, /DeepSeek Flash is configured for delegated tasks/);
  assert.match(result.stdout, /fully quit and reopen Codex Desktop, then start a new task/);
  assert.match(result.stdout, /deepcodex status/);
  assert.doesNotMatch(result.stdout, /"status"|"pid"|"restart_desktop_required"/);
  assert.match(fs.readFileSync(path.join(home, '.codex/AGENTS.md'), 'utf8'), /deepcodex:delegate-flash/);
  const parsed = parseToml(fs.readFileSync(configPath, 'utf8'));
  assert.equal(parsed.model, 'gpt-6-astra');
  assert.equal(parsed.mcp_servers.example.command, 'example');
  assert.equal(parsed.model_provider, 'deepcodex');
  assert.equal(parsed.plugins['deepcodex@personal'].enabled, true);
  const plugin = path.join(home, 'plugins/deepcodex');
  const manifest = JSON.parse(fs.readFileSync(path.join(plugin, '.codex-plugin/plugin.json')));
  assert.deepEqual(fs.readFileSync(path.join(plugin, manifest.interface.logo)), fs.readFileSync(path.join(ROOT, manifest.interface.logo)));
  assert.equal(fs.readFileSync(path.join(home, '.config/deepcodex/desktop/config.before.toml'), 'utf8'), original);
  assert.deepEqual(calls.map(args => args[0]), ['bootout', 'bootstrap']);
  const plist = path.join(home, 'Library/LaunchAgents/com.deepcodex.router.plist');
  const converted = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' });
  assert.equal(converted.status, 0, converted.stderr);
  const definition = JSON.parse(converted.stdout);
  const app = path.join(home, '.local/share/deepcodex/runtime/DeepCodex.app');
  const info = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Contents/Info.plist')], { encoding: 'utf8' });
  assert.equal(info.status, 0, info.stderr);
  const bundle = JSON.parse(info.stdout);
  assert.deepEqual(definition.AssociatedBundleIdentifiers, [bundle.CFBundleIdentifier]);
  assert.equal(bundle.CFBundleDisplayName, 'DeepCodex');
  const executable = path.join(app, 'Contents/MacOS', bundle.CFBundleExecutable);
  assert.deepEqual(definition.ProgramArguments, [executable, 'serve']);
  const icon = spawnSync('/usr/bin/sips', ['-g', 'format', '-g', 'pixelWidth', path.join(app, 'Contents/Resources', bundle.CFBundleIconFile)], { encoding: 'utf8' });
  assert.equal(icon.status, 0, icon.stderr);
  assert.match(icon.stdout, /format: icns/);
  assert.match(icon.stdout, /pixelWidth: 512/);
  const registrations = fs.readFileSync(path.join(path.dirname(home), 'registration.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(registrations, [['-f', app]]);
  fs.rmSync(source, { recursive: true });
  const runtime = spawnSync(executable, ['--help'], {
    env: { HOME: home, PATH: '' }, encoding: 'utf8',
  });
  assert.equal(runtime.status, 0, runtime.stderr);
  assert.match(runtime.stdout, /Usage: deepcodex/);
});

test('app registration failure prevents service startup and configuration changes', t => {
  const { result, configPath, original, calls } = fixture(t, true, { registrationFailure: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot register DeepCodex app: fixture registration failure/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  assert.deepEqual(calls, []);
});

test('installation uses the Desktop CLI without a codex command on PATH', t => {
  const { result, calls } = fixture(t, true, { bundled: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /DeepCodex installed successfully/);
  assert.deepEqual(calls.map(args => args[0]), ['bootout', 'bootstrap']);
});

test('installation stops the current service before starting it', t => {
  const { home, result, calls } = fixture(t, true);
  assert.equal(result.status, 0, result.stderr);
  const domain = `gui/${process.getuid()}`;
  assert.deepEqual(calls, [
    ['bootout', `${domain}/com.deepcodex.router`],
    ['bootstrap', domain, path.join(home, 'Library/LaunchAgents/com.deepcodex.router.plist')],
  ]);
});

test('a failed service stop prevents bootstrap and reports the launchctl error', t => {
  const { result, configPath, original, calls } = fixture(t, true, { stopFailure: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot stop com.deepcodex.router: Boot-out failed: 1: Operation not permitted/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  assert.deepEqual(calls.map(args => args[0]), ['bootout']);
});

test('a failed bootstrap reports its actual error and preserves configuration', t => {
  const { result, configPath, original } = fixture(t, true, { startFailure: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot start DeepCodex LaunchAgent: Bootstrap failed: 5: Input\/output error/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
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
  assert.doesNotMatch(result.stdout, /installed successfully/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  assert.equal(fs.existsSync(path.join(path.dirname(configPath), 'AGENTS.md')), false);
  assert.deepEqual(calls.map(args => args[0]), ['bootout', 'bootstrap', 'bootout']);
});

test('missing plugin support fails before starting a service or changing user config', t => {
  const { result, configPath, original, calls } = fixture(t, true, { noPluginSupport: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must support plugin add/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  assert.deepEqual(calls, []);
});

test('plugin install failure is reported and stops the attempted service', t => {
  const { result, configPath, original, calls } = fixture(t, true, { pluginFailure: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot add Codex plugin/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  assert.equal(fs.existsSync(path.join(path.dirname(configPath), 'AGENTS.md')), false);
  assert.deepEqual(calls.map(args => args[0]), ['bootout', 'bootstrap', 'bootout']);
});

test('installation preserves unrelated marketplace entries', t => {
  const { home, result } = fixture(t, true, { marketplace: true });
  assert.equal(result.status, 0, result.stderr);
  const marketplace = JSON.parse(fs.readFileSync(path.join(home, '.agents/plugins/marketplace.json')));
  assert.equal(marketplace.interface.displayName, 'My plugins');
  assert.deepEqual(marketplace.plugins.map(plugin => plugin.name), ['unrelated', 'deepcodex']);
  assert.deepEqual(marketplace.plugins[0], { name: 'unrelated', source: { source: 'local', path: './plugins/unrelated' } });
});

test('reinstallation refreshes plugin content without a package version change or duplicate entries', t => {
  const { home, source, configPath, result, run } = fixture(t, true);
  assert.equal(result.status, 0, result.stderr);
  const relative = '.codex-plugin/plugin.json';
  const destination = path.join(home, 'plugins/deepcodex');
  const firstVersion = JSON.parse(fs.readFileSync(path.join(destination, relative))).version;
  const manifest = JSON.parse(fs.readFileSync(path.join(source, relative)));
  manifest.interface.shortDescription = 'Updated description';
  fs.writeFileSync(path.join(source, relative), JSON.stringify(manifest));
  const icon = path.join(source, manifest.interface.logo);
  fs.appendFileSync(icon, 'updated fixture image');
  const repeated = run();
  assert.equal(repeated.status, 0, repeated.stderr);
  const installed = JSON.parse(fs.readFileSync(path.join(destination, relative)));
  assert.equal(installed.interface.shortDescription, manifest.interface.shortDescription);
  assert.notEqual(installed.version, firstVersion);
  assert.equal(installed.version.split('+')[0], manifest.version);
  assert.deepEqual(fs.readFileSync(path.join(destination, manifest.interface.logo)), fs.readFileSync(icon));
  const marketplace = JSON.parse(fs.readFileSync(path.join(home, '.agents/plugins/marketplace.json')));
  assert.equal(marketplace.plugins.length, 1);
  assert.equal(parseToml(fs.readFileSync(configPath, 'utf8')).plugins['deepcodex@personal'].enabled, true);
});

function removeInstallation(fixture) {
  return spawnSync(process.execPath, ['--import', path.join(path.dirname(fixture.home), 'health.js'), path.join(fixture.source, 'scripts/desktop.js'), 'uninstall'], {
    env: { HOME: fixture.home, PATH: path.join(path.dirname(fixture.home), 'bin') }, encoding: 'utf8',
  });
}

test('global instructions respect CODEX_HOME, preserve edits on reinstall, and remove only the managed block', t => {
  const original = '# My rules\nPreserve my settings.';
  const installed = fixture(t, true, { instructions: original, customCodexHome: true });
  assert.equal(installed.result.status, 0, installed.result.stderr);
  const filename = path.join(path.dirname(installed.configPath), 'AGENTS.md');
  const instructions = fs.readFileSync(filename, 'utf8');
  assert.ok(instructions.endsWith(original));
  assert.match(instructions, /deepcodex:delegate-flash/);
  assert.equal(fs.existsSync(path.join(installed.home, '.codex/AGENTS.md')), false);
  const customized = instructions.replace('Small or inseparable tasks', 'Simple tasks') + '\n# Later user edit\n';
  fs.writeFileSync(filename, customized);
  const repeated = installed.run();
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(fs.readFileSync(filename, 'utf8'), customized);
  const removed = removeInstallation(installed);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(fs.readFileSync(filename, 'utf8'), original + '\n# Later user edit\n');
});

test('malformed instruction markers stop installation before changing config or starting the service', t => {
  const instructions = '# My rules\n<!-- DEEPCODEX_START -->\n';
  const { result, configPath, original, calls } = fixture(t, true, { instructions });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid DeepCodex instruction markers/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  assert.equal(fs.readFileSync(path.join(path.dirname(configPath), 'AGENTS.md'), 'utf8'), instructions);
  assert.deepEqual(calls, []);
});

test('uninstall restores config, removes runtime and service, preserves credentials and is repeatable', t => {
  const installed = fixture(t, true);
  assert.equal(installed.result.status, 0, installed.result.stderr);
  const credentials = path.join(installed.home, '.config/deepcodex/.env');
  fs.writeFileSync(credentials, 'fixture-credential');
  const result = removeInstallation(installed);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'uninstalled');
  assert.equal(fs.readFileSync(installed.configPath, 'utf8'), installed.original);
  assert.equal(fs.readFileSync(path.join(installed.home, '.codex/AGENTS.md'), 'utf8'), '');
  assert.equal(fs.readFileSync(credentials, 'utf8'), 'fixture-credential');
  const registrations = fs.readFileSync(path.join(path.dirname(installed.home), 'registration.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(registrations.map(args => args[0]), ['-f', '-u']);
  assert.equal(registrations[0][1], registrations[1][1]);
  for (const relative of ['.config/deepcodex/desktop', '.local/share/deepcodex/runtime', 'Library/LaunchAgents/com.deepcodex.router.plist']) {
    assert.equal(fs.existsSync(path.join(installed.home, relative)), false);
  }
  const repeated = removeInstallation(installed);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(JSON.parse(repeated.stdout).status, 'not_installed');
});

test('uninstall refuses changed config before stopping the service or deleting files', t => {
  const installed = fixture(t, true);
  const changed = fs.readFileSync(installed.configPath, 'utf8') + '\n# New user setting\n';
  fs.writeFileSync(installed.configPath, changed);
  const result = removeInstallation(installed);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /configuration changed/);
  assert.equal(fs.readFileSync(installed.configPath, 'utf8'), changed);
  assert.equal(fs.existsSync(path.join(installed.home, '.local/share/deepcodex/runtime')), true);
  const calls = fs.readFileSync(path.join(path.dirname(installed.home), 'launchctl.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(args => args[0]), ['bootout', 'bootstrap']);
});

test('failed service stop retains runtime and permits retry after config restoration', t => {
  const installed = fixture(t, true);
  const launchctl = path.join(path.dirname(installed.home), 'bin/launchctl');
  fs.writeFileSync(launchctl, '#!/bin/sh\nexit 1\n');
  const failed = removeInstallation(installed);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Cannot stop/);
  assert.equal(fs.readFileSync(installed.configPath, 'utf8'), installed.original);
  assert.equal(fs.existsSync(path.join(installed.home, '.local/share/deepcodex/runtime')), true);
  fs.writeFileSync(launchctl, '#!/bin/sh\nexit 3\n');
  const retried = removeInstallation(installed);
  assert.equal(retried.status, 0, retried.stderr);
});
