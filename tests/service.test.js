import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { systemdUnit, windowsLauncherScript, windowsServiceScript, userService } from '../scripts/service.js';

const config = {
  service_label: 'com.deepcodex.router', service_throttle_seconds: 10,
  startup_timeout_seconds: 10, windows_restart_count: 3, windows_restart_seconds: 60,
};

test('systemd escapes executable paths and preserves environment values', () => {
  const state = { node: '/Node $dir/100%/node', runtime: '/a "quoted"/runtime', config };
  const unit = systemdUnit(state, { PATH: '/a/$path:100%' });
  assert.match(unit, /ExecStart=:"\/Node \$dir\/100%%\/node"/);
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

test('Windows registers a console-free supervised logon task with literal paths', () => {
  const state = { node: 'C:\\Program Files\\node.exe', runtime: "C:\\Users\\O'Brien $x\\runtime", config };
  const env = { SystemRoot: 'C:\\Windows', PATH: 'C:\\some & dir' };
  const script = windowsServiceScript('install', state);
  assert.match(script, /-OutputType WindowsApplication/);
  assert.match(script, /UseShellExecute = false/);
  assert.match(script, /CreateNoWindow = true/);
  assert.match(script, /child.WaitForExit\(\);\s+return child.ExitCode;/);
  assert.match(script, /-LogonType Interactive -RunLevel Limited/);
  const taskIdentity = script.split('\n')[1];
  assert.match(taskIdentity, /WindowsIdentity.*User.Value/);
  for (const action of ['stop', 'remove']) {
    assert.equal(windowsServiceScript(action, state).split('\n')[1], taskIdentity);
  }
  assert.match(script, /New-ScheduledTaskTrigger -AtLogOn -User \$user/);
  assert.match(script, /ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/);
  assert.ok(script.indexOf('Stop-ScheduledTask') < script.indexOf('Register-ScheduledTask'));
  assert.ok(script.indexOf('Stop-ScheduledTask') < script.indexOf('Remove-Item -LiteralPath $launcher'));
  assert.ok(script.indexOf('Add-Type') < script.indexOf('Register-ScheduledTask'));
  assert.ok(script.includes("$launcher = 'C:\\Users\\O''Brien $x\\runtime\\DeepCodex.Service.exe'"));
  assert.ok(script.includes('New-ScheduledTaskAction -Execute $launcher'));
  assert.ok(script.includes(`-Argument '"C:\\Program Files\\node.exe" "C:\\Users\\O''Brien $x\\runtime\\scripts\\desktop.js"'`));
  assert.ok(script.includes("-WorkingDirectory 'C:\\Users\\O''Brien $x\\runtime'"));
  assert.doesNotMatch(script, /WindowStyle|powershell\.exe/);
  assert.doesNotMatch(script, /cmd.exe|& 'C:/);
  const calls = [];
  userService('install', state, env, { platform: 'win32', spawn: (command, args) => { calls.push([command, args]); return { status: 0 }; } });
  assert.equal(calls[0][0], 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(Buffer.from(calls[0][1].at(-1), 'base64').toString('utf16le'), script);
  assert.match(windowsServiceScript('remove', state), /Unregister-ScheduledTask/);
  assert.doesNotMatch(windowsServiceScript('stop', state), /Unregister-ScheduledTask/);
});

test('Windows builds a GUI supervisor that waits for Node and propagates its exit code', { skip: process.platform !== 'win32' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deepcodex-service-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, "O'Brien & $x 日本語");
  fs.mkdirSync(path.join(runtime, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(runtime, 'scripts/desktop.js'), `
    setTimeout(() => {
      require('node:fs').writeFileSync('result.json', JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));
      process.exit(42);
    }, 100);
  `);
  const state = { node: process.execPath, runtime, config };
  const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const buildScript = "$ErrorActionPreference = 'Stop'\n" + windowsLauncherScript(state);
  const build = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(buildScript, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(build.error, undefined);
  assert.equal(build.status, 0, build.stderr);
  const launcher = path.join(runtime, 'DeepCodex.Service.exe');
  const binary = fs.readFileSync(launcher);
  const peHeader = binary.readUInt32LE(0x3c);
  assert.equal(binary.readUInt16LE(peHeader + 4 + 20 + 68), 2, 'the PE subsystem must be Windows GUI, not console');
  const result = spawnSync(launcher, [state.node, path.join(runtime, 'scripts/desktop.js')], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 42, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runtime, 'result.json'), 'utf8')), { args: ['serve'], cwd: runtime });
  const failure = spawnSync(launcher, [path.join(root, 'missing.exe'), path.join(runtime, 'scripts/desktop.js')], { encoding: 'utf8', timeout: 15000 });
  assert.equal(failure.error, undefined);
  assert.equal(failure.status, 1, failure.stderr);
});

test('Windows scheduled task reinstall and stop terminate the supervised Node process', { skip: process.platform !== 'win32' }, async t => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'deepcodex-task-'));
  const state = { node: process.execPath, runtime, config: {
    ...config, service_label: `deepcodex-test-${process.pid}-${Date.now()}`, service_throttle_seconds: 1,
  } };
  const pidFile = path.join(runtime, 'child.pid');
  const alive = pid => {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  };
  t.after(() => {
    try { userService('remove', state); }
    finally {
      if (fs.existsSync(pidFile)) {
        const pid = Number(fs.readFileSync(pidFile, 'utf8'));
        if (alive(pid)) process.kill(pid);
      }
      fs.rmSync(runtime, { recursive: true, force: true });
    }
  });
  fs.mkdirSync(path.join(runtime, 'scripts'));
  fs.writeFileSync(path.join(runtime, 'scripts/desktop.js'), `
    const fs = require('node:fs');
    fs.writeFileSync('child.pid.tmp', String(process.pid));
    fs.renameSync('child.pid.tmp', 'child.pid');
    setInterval(() => {}, 1000);
  `);
  userService('install', state);
  const startedBy = Date.now() + 15000;
  while (!fs.existsSync(pidFile) && Date.now() < startedBy) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(fs.existsSync(pidFile), 'the scheduled task must start Node');
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(alive(pid));
  fs.unlinkSync(pidFile);
  userService('install', state);
  const restartedBy = Date.now() + 15000;
  while (!fs.existsSync(pidFile) && Date.now() < restartedBy) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(fs.existsSync(pidFile), 'reinstall must rebuild the launcher and start Node');
  const restartedPid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.notEqual(restartedPid, pid);
  assert.equal(alive(pid), false, 'reinstall must terminate the previous Node process');
  assert.ok(alive(restartedPid));
  userService('stop', state);
  const stoppedBy = Date.now() + 5000;
  while (alive(restartedPid) && Date.now() < stoppedBy) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(alive(restartedPid), false, 'stopping the task must also terminate Node');
});

test('Windows propagates service failures and requires SystemRoot', () => {
  const state = { config };
  assert.throws(() => userService('stop', state, {}, { platform: 'win32' }), /SystemRoot/);
  assert.throws(() => userService('stop', state, { SystemRoot: 'C:\\Windows' }, {
    platform: 'win32', spawn: () => ({ status: 1, stderr: 'Access denied' }),
  }), /Access denied/);
});
