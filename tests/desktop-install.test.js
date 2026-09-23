import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import nodeTest from 'node:test';
const test = (name, fn) => nodeTest(name, { skip: process.platform === 'win32' }, fn);
const macTest = (name, fn) => nodeTest(name, { skip: process.platform !== 'darwin' }, fn);
import { copyRuntime } from '../scripts/desktop.js';
import { parseToml } from '../scripts/toml.js';
import { ROOT } from '../scripts/worker.js';

// The installer asks launchd for the service state before bootstrapping, so the service
// transitions are the bootout and bootstrap calls.
const serviceCommands = calls => calls.map(args => args[0]).filter(name => name !== 'print');

// launchd reports a booted-out job as registered until its process exits, so this stub keeps the
// label present while its drain counter runs out. stuck keeps it registered indefinitely.
function drainingLaunchd(calls, state, stuck) {
  return `#!${process.execPath}
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
    const file = ${JSON.stringify(state)};
    const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { loaded: true, draining: 2 }; } };
    const write = value => fs.writeFileSync(file, JSON.stringify(value));
    if (args[0] === 'bootout') {
      if (!read().loaded) {
        console.error('Boot-out failed: 3: No such process');
        process.exit(3);
      }
      write({ loaded: true, draining: 2 });
      process.exit(0);
    }
    if (args[0] === 'print') {
      const current = read();
      if (!current.loaded) {
        console.error('Could not find service in domain for user gui: 501');
        process.exit(113);
      }
      if (${stuck}) process.exit(0);
      if (current.draining > 0) {
        write({ loaded: true, draining: current.draining - 1 });
        process.exit(0);
      }
      write({ loaded: false, draining: 0 });
      console.error('Could not find service in domain for user gui: 501');
      process.exit(113);
    }
    if (args[0] === 'bootstrap') {
      if (read().loaded) {
        console.error('Bootstrap failed: 5: Input/output error');
        process.exit(5);
      }
      write({ loaded: true, draining: 0 });
      process.exit(0);
    }
    process.exit(9);
  `;
}

function fixture(t, healthy, { marketplace = false, bundled = false, incompatible = false, pluginFailure = false, noPluginSupport = false, stopFailure = false, startFailure = false, registrationFailure = false, drainingStop = false, stuckStop = false, stopTimeoutSeconds, instructions, customCodexHome = false, platform = 'darwin', config, jevEnabled, ttyOutput = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deepcodex-install-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home & user's");
  if (jevEnabled !== undefined) {
    const settingsDir = path.join(home, '.config/deepcodex');
    fs.mkdirSync(settingsDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(settingsDir, 'settings.json'),
      JSON.stringify({ jev_compaction: { enabled: jevEnabled } }), { mode: 0o600 });
  }
  const source = path.join(root, 'source');
  const bin = path.join(root, 'bin');
  const codexHome = path.join(home, customCodexHome ? 'custom-codex' : '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'models_cache.json'), JSON.stringify({ models: [
    { slug: 'gpt-6-astra', visibility: 'list', priority: 1 },
    { slug: 'gpt-6-sol', visibility: 'list', priority: 2 },
    { slug: 'gpt-6-luna', visibility: 'list', priority: 3 },
  ] }));
  if (instructions !== undefined) fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), instructions);
  fs.mkdirSync(bin);
  copyRuntime(ROOT, source);
  const desktopFile = path.join(source, 'config/desktop.json');
  const desktop = JSON.parse(fs.readFileSync(desktopFile));
  desktop.startup_timeout_seconds = 0;
  if (stopTimeoutSeconds !== undefined) desktop.service_stop_timeout_seconds = stopTimeoutSeconds;
  fs.writeFileSync(desktopFile, JSON.stringify(desktop));
  const original = config ?? '# Preserve this\nmodel="gpt-6-astra"\n[mcp_servers.example]\ncommand="example"\n';
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
    else if (args[0] === 'debug' && args[1] === 'models') {
      import(${JSON.stringify(path.join(source, 'scripts/toml.js'))}).then(({ parseToml }) => {
        const fs = require('node:fs');
        const config = parseToml(fs.readFileSync(${JSON.stringify(configPath)}, 'utf8'));
        for (let i = 2; i < args.length; i += 2) {
          if (args[i] !== '-c') process.exit(9);
          Object.assign(config, parseToml(args[i + 1]));
        }
        if ((config.model_provider ?? 'openai') !== 'openai') process.exit(9);
        console.log(fs.readFileSync(config.model_catalog_json ?? ${JSON.stringify(path.join(codexHome, 'models_cache.json'))}, 'utf8'));
      });
    }
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
  fs.writeFileSync(path.join(bin, 'launchctl'), drainingStop || stuckStop
    ? drainingLaunchd(calls, path.join(root, 'launchd.json'), stuckStop)
    : `#!${process.execPath}
    require('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');
    if (${stopFailure} && process.argv[2] === 'bootout') {
      console.error('Boot-out failed: 1: Operation not permitted');
      process.exit(1);
    }
    if (${startFailure} && process.argv[2] === 'bootstrap') {
      console.error('Bootstrap failed: 5: Input/output error');
      process.exit(5);
    }
    if (process.argv[2] === 'print') {
      console.error('Could not find service in domain for user gui: 501');
      process.exit(113);
    }
  `, { mode: 0o700 });
  const preload = path.join(root, 'health.js');
  fs.writeFileSync(preload, `
    import childProcess from 'node:child_process';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
    if (${ttyOutput}) Object.defineProperty(process.stdout, 'isTTY', { value: true });
    const spawnSync = childProcess.spawnSync;
    childProcess.spawnSync = (command, args, options) => {
      if (command === 'systemctl') {
        fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
        return { status: 0, stderr: '' };
      }
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

test('installation preserves the current native catalog and refreshes it on reinstall', t => {
  const installed = fixture(t, true, { platform: 'linux', customCodexHome: true });
  assert.equal(installed.result.status, 0, installed.result.stderr);
  const stateDir = path.join(installed.home, '.config/deepcodex/desktop');
  const cachePath = path.join(path.dirname(installed.configPath), 'models_cache.json');
  const native = JSON.parse(fs.readFileSync(cachePath)).models;
  const verify = expected => {
    const models = JSON.parse(fs.readFileSync(path.join(stateDir, 'models.json'))).models;
    assert.deepEqual(models.filter(model => model.slug !== 'deepseek-flash'), expected);
    assert.equal(models.filter(model => model.slug === 'deepseek-flash').length, 1);
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json')));
    assert.deepEqual(state.config.native_models, expected.map(model => model.slug));
  };
  verify(native);
  const updated = [...native, { slug: 'new-native-model', visibility: 'list', priority: 4 }];
  fs.writeFileSync(cachePath, JSON.stringify({ models: updated }));
  const repeated = installed.run();
  assert.equal(repeated.status, 0, repeated.stderr);
  verify(updated);
});

test('installation applies the saved Jev compaction choice', t => {
  const installed = fixture(t, true, { platform: 'linux', jevEnabled: true });
  assert.equal(installed.result.status, 0, installed.result.stderr);
  const state = JSON.parse(fs.readFileSync(path.join(installed.home, '.config/deepcodex/desktop/state.json')));
  assert.equal(state.config.jev_compaction.enabled, true);
});

macTest('installation associates the LaunchAgent with a branded app that runs the copied runtime', t => {
  const { home, source, configPath, original, result, calls } = fixture(t, true);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /✓ DeepCodex installed successfully/);
  assert.match(result.stdout, /local service is running and the Codex plugin is installed/);
  assert.match(result.stdout, /DeepSeek Flash is configured for delegated tasks/);
  assert.match(result.stdout, /fully quit and reopen Codex Desktop, then start a new task/);
  assert.match(result.stdout, /deepcodex status/);
  assert.doesNotMatch(result.stdout, /"status"|"pid"|"restart_desktop_required"/);
  assert.match(fs.readFileSync(path.join(home, '.codex/AGENTS.md'), 'utf8'), /## DeepCodex\n\nBefore making code changes, read the `deepcodex:delegate-flash` skill\n/);
  const parsed = parseToml(fs.readFileSync(configPath, 'utf8'));
  assert.equal(parsed.model, 'gpt-6-astra');
  assert.equal(parsed.mcp_servers.example.command, 'example');
  assert.equal(parsed.model_provider, 'deepcodex');
  assert.equal(parsed.plugins['deepcodex@personal'].enabled, true);
  const plugin = path.join(home, 'plugins/deepcodex');
  const manifest = JSON.parse(fs.readFileSync(path.join(plugin, '.codex-plugin/plugin.json')));
  assert.deepEqual(fs.readFileSync(path.join(plugin, manifest.interface.logo)), fs.readFileSync(path.join(ROOT, manifest.interface.logo)));
  assert.equal(fs.readFileSync(path.join(home, '.config/deepcodex/desktop/config.before.toml'), 'utf8'), original);
  assert.deepEqual(serviceCommands(calls), ['bootout', 'bootstrap']);
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

macTest('app registration failure prevents service startup and configuration changes', t => {
  const { result, configPath, original, calls } = fixture(t, true, { registrationFailure: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot register DeepCodex app: fixture registration failure/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  assert.deepEqual(calls, []);
});

macTest('installation uses the Desktop CLI without a codex command on PATH', t => {
  const { result, calls } = fixture(t, true, { bundled: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /DeepCodex installed successfully/);
  assert.deepEqual(serviceCommands(calls), ['bootout', 'bootstrap']);
});

macTest('installation stops the current service before starting it', t => {
  const { home, result, calls } = fixture(t, true);
  assert.equal(result.status, 0, result.stderr);
  const domain = `gui/${process.getuid()}`;
  assert.deepEqual(calls, [
    ['bootout', `${domain}/com.deepcodex.router`],
    ['print', `${domain}/com.deepcodex.router`],
    ['bootstrap', domain, path.join(home, 'Library/LaunchAgents/com.deepcodex.router.plist')],
  ]);
});

macTest('a failed service stop prevents bootstrap and reports the launchctl error', t => {
  const { result, configPath, original, calls } = fixture(t, true, { stopFailure: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot stop com.deepcodex.router: Boot-out failed: 1: Operation not permitted/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  assert.deepEqual(calls.map(args => args[0]), ['bootout']);
});

macTest('a failed bootstrap reports its actual error and preserves configuration', t => {
  const { result, configPath, original } = fixture(t, true, { startFailure: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot start DeepCodex LaunchAgent: Bootstrap failed: 5: Input\/output error/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
});

macTest('reinstallation waits for the previous LaunchAgent to stop before bootstrapping again', t => {
  const { result, configPath, calls } = fixture(t, true, { drainingStop: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /DeepCodex installed successfully/);
  assert.equal(parseToml(fs.readFileSync(configPath, 'utf8')).model_provider, 'deepcodex');
  const commands = calls.map(args => args[0]);
  assert.equal(commands[0], 'bootout');
  assert.equal(commands.at(-1), 'bootstrap');
  assert.equal(commands.filter(name => name === 'bootstrap').length, 1);
  assert.ok(commands.slice(1, -1).length > 0 && commands.slice(1, -1).every(name => name === 'print'), commands.join(' '));
});

macTest('a LaunchAgent that never stops fails within the stop budget and preserves configuration', t => {
  const { result, configPath, original, calls } = fixture(t, true, { stuckStop: true, stopTimeoutSeconds: 1 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot start DeepCodex LaunchAgent: com\.deepcodex\.router did not stop within 1 seconds/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  const commands = calls.map(args => args[0]);
  assert.equal(commands[0], 'bootout');
  assert.equal(commands.includes('bootstrap'), false);
  assert.ok(commands.slice(1).length > 0 && commands.slice(1).every(name => name === 'print'), commands.join(' '));
});

macTest('incompatible CLI explains the prerequisite failure before modifying configuration', t => {
  const { configPath, original, result, calls } = fixture(t, true, { incompatible: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /DeepCodex prerequisites are not ready:.*incompatible.*--strict-config/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  assert.deepEqual(calls, []);
});

macTest('unhealthy service leaves user configuration unchanged and stops the attempted service', t => {
  const { configPath, original, result, calls } = fixture(t, false);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /did not become healthy/);
  assert.doesNotMatch(result.stdout, /installed successfully/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  assert.equal(fs.existsSync(path.join(path.dirname(configPath), 'AGENTS.md')), false);
  assert.deepEqual(serviceCommands(calls), ['bootout', 'bootstrap', 'bootout']);
});

macTest('missing plugin support fails before starting a service or changing user config', t => {
  const { result, configPath, original, calls } = fixture(t, true, { noPluginSupport: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must support plugin add/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  assert.deepEqual(calls, []);
});

macTest('plugin install failure is reported and stops the attempted service', t => {
  const { result, configPath, original, calls } = fixture(t, true, { pluginFailure: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot add Codex plugin/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  assert.equal(fs.existsSync(path.join(path.dirname(configPath), 'AGENTS.md')), false);
  assert.deepEqual(serviceCommands(calls), ['bootout', 'bootstrap', 'bootout']);
});

macTest('installation preserves unrelated marketplace entries', t => {
  const { home, result } = fixture(t, true, { marketplace: true });
  assert.equal(result.status, 0, result.stderr);
  const marketplace = JSON.parse(fs.readFileSync(path.join(home, '.agents/plugins/marketplace.json')));
  assert.equal(marketplace.interface.displayName, 'My plugins');
  assert.deepEqual(marketplace.plugins.map(plugin => plugin.name), ['unrelated', 'deepcodex']);
  assert.deepEqual(marketplace.plugins[0], { name: 'unrelated', source: { source: 'local', path: './plugins/unrelated' } });
});

macTest('reinstallation refreshes plugin content without a package version change or duplicate entries', t => {
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

macTest('global instructions respect CODEX_HOME, refresh the managed block on reinstall, and preserve outside edits', t => {
  const original = '# My rules\nPreserve my settings.';
  const installed = fixture(t, true, { instructions: original, customCodexHome: true });
  assert.equal(installed.result.status, 0, installed.result.stderr);
  const filename = path.join(path.dirname(installed.configPath), 'AGENTS.md');
  const instructions = fs.readFileSync(filename, 'utf8');
  assert.ok(instructions.endsWith(original));
  assert.match(instructions, /## DeepCodex\n\nBefore making code changes, read the `deepcodex:delegate-flash` skill\n/);
  assert.equal(fs.existsSync(path.join(installed.home, '.codex/AGENTS.md')), false);
  const customized = instructions.replace('Before making code changes', 'Before starting work') + '\n# Later user edit\n';
  fs.writeFileSync(filename, customized);
  const repeated = installed.run();
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(fs.readFileSync(filename, 'utf8'), instructions + '\n# Later user edit\n');
  const removed = removeInstallation(installed);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(fs.readFileSync(filename, 'utf8'), original + '\n# Later user edit\n');
});

macTest('malformed instruction markers stop installation before changing config or starting the service', t => {
  const instructions = '# My rules\n<!-- DEEPCODEX_START -->\n';
  const { result, configPath, original, calls } = fixture(t, true, { instructions });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid DeepCodex instruction markers/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  assert.equal(fs.readFileSync(path.join(path.dirname(configPath), 'AGENTS.md'), 'utf8'), instructions);
  assert.deepEqual(calls, []);
});

macTest('uninstall restores config, removes runtime and service, preserves credentials and is repeatable', t => {
  const installed = fixture(t, true);
  assert.equal(installed.result.status, 0, installed.result.stderr);
  const credentials = path.join(installed.home, '.config/deepcodex/.env');
  fs.writeFileSync(credentials, 'fixture-credential');
  const result = removeInstallation(installed);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /✓ DeepCodex uninstalled successfully/);
  assert.match(result.stdout, /local service and router runtime were removed/);
  assert.match(result.stdout, /Codex settings and global instructions were restored/);
  assert.match(result.stdout, /saved credentials were preserved/);
  assert.match(result.stdout, /fully quit and reopen Codex Desktop/);
  assert.doesNotMatch(result.stdout, /"status"|"restart_desktop_required"|"credentials_preserved"/);
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

macTest('uninstall preserves unrelated config edits made after installation', t => {
  const installed = fixture(t, true);
  const unrelated = '# New user setting\n';
  const configured = fs.readFileSync(installed.configPath, 'utf8')
    .replace('model="gpt-6-astra"', 'model="gpt-6-sol"')
    .replace('multi_agent = true', 'custom_feature = true\nmulti_agent = true') + '\n' + unrelated;
  fs.writeFileSync(installed.configPath, configured);
  const reinstalled = installed.run();
  assert.equal(reinstalled.status, 0, reinstalled.stderr);
  const result = removeInstallation(installed);
  assert.equal(result.status, 0, result.stderr);
  const restored = fs.readFileSync(installed.configPath, 'utf8');
  assert.equal(parseToml(restored).model, 'gpt-6-sol');
  assert.equal(parseToml(restored).model_provider, undefined);
  assert.equal(parseToml(restored).features.custom_feature, true);
  assert.match(restored, /# New user setting/);
  assert.equal(fs.existsSync(path.join(installed.home, '.local/share/deepcodex/runtime')), false);
});

macTest('uninstall accepts a comment appended to the managed plugin section', t => {
  const installed = fixture(t, true);
  assert.equal(installed.result.status, 0, installed.result.stderr);
  fs.appendFileSync(installed.configPath, '\n# Later note\n');
  const result = removeInstallation(installed);
  assert.equal(result.status, 0, result.stderr);
  const restored = fs.readFileSync(installed.configPath, 'utf8');
  assert.match(restored, /# Later note/);
  assert.doesNotMatch(restored, /\[plugins\."deepcodex@personal"\]/);
  assert.doesNotMatch(restored, /\[model_providers\.deepcodex\]/);
});

macTest('uninstall marks success red on a terminal', t => {
  const installed = fixture(t, true, { ttyOutput: true });
  assert.equal(installed.result.status, 0, installed.result.stderr);
  assert.match(installed.result.stdout, /\x1b\[32m✓\x1b\[0m DeepCodex installed successfully/);
  const result = removeInstallation(installed);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\x1b\[31m✓\x1b\[0m DeepCodex uninstalled successfully/);
});

macTest('uninstall refuses conflicting changes to managed config before stopping the service', t => {
  const installed = fixture(t, true);
  const changed = fs.readFileSync(installed.configPath, 'utf8').replace('model_provider = "deepcodex"', 'model_provider = "custom"');
  fs.writeFileSync(installed.configPath, changed);
  const result = removeInstallation(installed);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /managed setting changed/);
  assert.equal(fs.readFileSync(installed.configPath, 'utf8'), changed);
  assert.equal(fs.existsSync(path.join(installed.home, '.local/share/deepcodex/runtime')), true);
  const calls = fs.readFileSync(path.join(path.dirname(installed.home), 'launchctl.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(serviceCommands(calls), ['bootout', 'bootstrap']);
});

macTest('failed service stop retains runtime and permits retry after config restoration', t => {
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


test('Linux installation and removal use the user service manager and preserve config', t => {
  const installed = fixture(t, true, { platform: 'linux' });
  assert.equal(installed.result.status, 0, installed.result.stderr);
  assert.equal(parseToml(fs.readFileSync(installed.configPath, 'utf8')).model_provider, 'deepcodex');
  assert.deepEqual(installed.calls.map(args => args[1]), ['daemon-reload', 'stop', 'enable']);
  const unit = path.join(installed.home, '.config/systemd/user/com.deepcodex.router.service');
  assert.match(fs.readFileSync(unit, 'utf8'), /Restart=always/);
  assert.equal(fs.existsSync(path.join(installed.home, '.local/share/deepcodex/runtime/DeepCodex.app')), false);
  const removed = removeInstallation(installed);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(fs.readFileSync(installed.configPath, 'utf8'), installed.original);
  assert.equal(fs.existsSync(unit), false);
});

test('Linux unhealthy service is disabled before user configuration is changed', t => {
  const installed = fixture(t, false, { platform: 'linux' });
  assert.equal(installed.result.status, 1);
  assert.match(installed.result.stderr, /did not become healthy/);
  assert.equal(fs.readFileSync(installed.configPath, 'utf8'), installed.original);
  assert.deepEqual(installed.calls.at(-1), ['--user', 'disable', '--now', 'com.deepcodex.router.service']);
});

// An install that already ran once left the managed provider with retries disabled. Reinstalling
// must replace that policy with the canonical one from config/worker.json and keep every unrelated
// setting, including on a second run.
const RETRY_DISABLED_CONFIG = [
  '# Preserve this',
  'model = "gpt-6-astra"',
  'model_provider = "deepcodex"',
  'approval_policy = "on-request"',
  '',
  '[model_providers.deepcodex]',
  'name = "DeepCodex"',
  'base_url = "http://127.0.0.1:4207"',
  'wire_api = "responses"',
  'requires_openai_auth = true',
  'supports_websockets = false',
  'request_max_retries = 0',
  'stream_max_retries = 0',
  'stream_idle_timeout_ms = 120000',
  '',
  '[mcp_servers.example]',
  'command = "example"',
  '',
].join('\n');

test('reinstallation replaces the existing retry policy and preserves unrelated settings', t => {
  const installed = fixture(t, true, { platform: 'linux', config: RETRY_DISABLED_CONFIG });
  assert.equal(installed.result.status, 0, installed.result.stderr);
  const read = () => parseToml(fs.readFileSync(installed.configPath, 'utf8'));
  const first = read();
  assert.equal(first.model_providers.deepcodex.request_max_retries, 4);
  assert.equal(first.model_providers.deepcodex.stream_max_retries, 5);
  assert.equal(first.model_providers.deepcodex.wire_api, 'responses');
  assert.equal(first.model_providers.deepcodex.requires_openai_auth, true);
  assert.equal(first.model, 'gpt-6-astra');
  assert.equal(first.approval_policy, 'on-request');
  assert.equal(first.mcp_servers.example.command, 'example');
  const repeated = installed.run();
  assert.equal(repeated.status, 0, repeated.stderr);
  const second = read();
  assert.equal(second.model_providers.deepcodex.request_max_retries, 4);
  assert.equal(second.model_providers.deepcodex.stream_max_retries, 5);
  assert.equal(second.model_providers.deepcodex.wire_api, 'responses');
  assert.equal(second.model, 'gpt-6-astra');
  assert.equal(second.approval_policy, 'on-request');
  assert.equal(second.mcp_servers.example.command, 'example');
});
