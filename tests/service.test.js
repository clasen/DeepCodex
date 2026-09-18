import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { systemdUnit, windowsServiceScript, userService } from '../scripts/service.js';

const config = {
  service_label: 'com.deepcodex.router', service_throttle_seconds: 10,
  startup_timeout_seconds: 10, windows_restart_count: 3, windows_restart_seconds: 60,
};

test('systemd escapes executable paths and preserves environment values', () => {
  const state = { node: '/Node $dir/100%/node', runtime: '/a "quoted"/runtime', config };
  const unit = systemdUnit(state, { PATH: '/a/$path:100%' });
  assert.match(unit, /ExecStart="\/Node \$\$dir\/100%%\/node"/);
  assert.ok(unit.includes('WorkingDirectory="/a \\"quoted\\"/runtime"'));
  assert.ok(unit.includes('"PATH=/a/$path:100%%"'));
  assert.match(unit, /Restart=always\nRestartSec=10\nUMask=0077/);
});

test('Linux installs, stops and removes a user unit without root', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deepcodex-service-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const state = { node: process.execPath, runtime: path.join(home, 'runtime'), config };
  const calls = [];
  const options = { platform: 'linux', home, spawn: (command, args) => { calls.push([command, ...args]); return { status: 0 }; } };
  const env = { PATH: '/bin', XDG_CONFIG_HOME: path.join(home, 'custom-config') };
  userService('install', state, env, options);
  const filename = path.join(env.XDG_CONFIG_HOME, 'systemd/user/com.deepcodex.router.service');
  assert.match(fs.readFileSync(filename, 'utf8'), /scripts\/desktop.js" serve/);
  assert.deepEqual(calls, [
    ['systemctl', '--user', 'daemon-reload'],
    ['systemctl', '--user', 'stop', 'com.deepcodex.router.service'],
    ['systemctl', '--user', 'enable', '--now', 'com.deepcodex.router.service'],
  ]);
  userService('stop', state, env, options);
  assert.ok(fs.existsSync(filename));
  userService('remove', state, env, options);
  assert.equal(fs.existsSync(filename), false);
  assert.deepEqual(calls.at(-1), ['systemctl', '--user', 'daemon-reload']);
});

test('Linux fails immediately when the user service manager is unavailable', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deepcodex-service-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const calls = [];
  assert.throws(() => userService('install', { node: process.execPath, runtime: home, config }, { PATH: '/bin' }, {
    platform: 'linux', home, spawn: (command, args) => { calls.push(args); return { status: 1, stderr: 'No user bus' }; },
  }), /No user bus/);
  assert.equal(calls.length, 1);
});

test('Windows registers a limited logon task using an encoded action and literal paths', () => {
  const state = { node: 'C:\\Program Files\\node.exe', runtime: "C:\\Users\\O'Brien $x\\runtime", config };
  const env = { SystemRoot: 'C:\\Windows', PATH: 'C:\\some & dir' };
  const script = windowsServiceScript('install', state, env);
  assert.match(script, /-LogonType Interactive -RunLevel Limited/);
  assert.match(script, /New-ScheduledTaskTrigger -AtLogOn -User \$user/);
  assert.match(script, /ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/);
  assert.ok(script.indexOf('Stop-ScheduledTask') < script.indexOf('Register-ScheduledTask'));
  const encoded = script.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)[1];
  const runner = Buffer.from(encoded, 'base64').toString('utf16le');
  assert.ok(runner.includes("& 'C:\\Program Files\\node.exe' 'C:\\Users\\O''Brien $x\\runtime\\scripts\\desktop.js' serve"));
  assert.ok(runner.includes("$env:PATH = 'C:\\some & dir'"));
  assert.match(runner, /exit \$LASTEXITCODE/);
  const calls = [];
  userService('install', state, env, { platform: 'win32', spawn: (command, args) => { calls.push([command, args]); return { status: 0 }; } });
  assert.equal(calls[0][0], 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(Buffer.from(calls[0][1].at(-1), 'base64').toString('utf16le'), script);
  assert.match(windowsServiceScript('remove', state, env), /Unregister-ScheduledTask/);
  assert.doesNotMatch(windowsServiceScript('stop', state, env), /Unregister-ScheduledTask/);
});

test('Windows propagates service failures and requires SystemRoot', () => {
  const state = { config };
  assert.throws(() => userService('stop', state, {}, { platform: 'win32' }), /SystemRoot/);
  assert.throws(() => userService('stop', state, { SystemRoot: 'C:\\Windows' }, {
    platform: 'win32', spawn: () => ({ status: 1, stderr: 'Access denied' }),
  }), /Access denied/);
});
