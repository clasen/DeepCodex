import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { executableCandidates, killProcessTree, resolveExecutable, spawnPlan } from '../scripts/platform.js';

test('Windows command names follow PATHEXT and skip the extension-less POSIX shim', () => {
  assert.deepEqual(executableCandidates('codex', { platform: 'darwin' }), ['codex']);
  assert.deepEqual(executableCandidates('codex', { platform: 'win32', pathext: '.COM;.EXE;.BAT;.CMD' }),
    ['codex.com', 'codex.exe', 'codex.bat', 'codex.cmd']);
  assert.deepEqual(executableCandidates('codex', { platform: 'win32', pathext: '.EXE;.VBS;.JS;.PS1;.EXE' }),
    ['codex.exe'], 'only types node or cmd.exe can run are considered');
  assert.deepEqual(executableCandidates('codex.exe', { platform: 'win32', pathext: '.CMD' }), ['codex.exe']);
});

test('executable lookup honours PATHEXT and quoted PATH entries', (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deepcodex-platform-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const shim = path.join(dir, 'codex');
  const command = path.join(dir, 'codex.cmd');
  fs.writeFileSync(shim, '#!/bin/sh\n');
  fs.chmodSync(shim, 0o700);
  fs.writeFileSync(command, '@echo off\r\n');
  assert.equal(resolveExecutable('codex', { searchPath: dir, platform: 'linux' }), shim);
  assert.equal(resolveExecutable('codex', { searchPath: dir, platform: 'win32' }), command);
  assert.equal(resolveExecutable('codex', { searchPath: `"${dir}"`, platform: 'win32' }), command);
  const native = path.join(dir, 'codex.exe');
  fs.writeFileSync(native, 'MZ');
  assert.equal(resolveExecutable('codex', { searchPath: dir, platform: 'win32' }), native,
    'a real executable wins over the shim because PATHEXT is searched in order');
  assert.equal(resolveExecutable('codex', { searchPath: `${dir}${path.delimiter}${dir}`, platform: 'win32' }), native);
  assert.equal(resolveExecutable('missing', { searchPath: dir, platform: 'win32' }), undefined);
});

// Windows has no executable bit: a file with a known extension is startable there.
test('a candidate without the executable bit stays unusable', { skip: process.platform === 'win32' && 'POSIX executable bit' }, (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deepcodex-platform-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const shim = path.join(dir, 'codex');
  fs.writeFileSync(shim, '#!/bin/sh\n');
  fs.chmodSync(shim, 0o600);
  assert.equal(resolveExecutable('codex', { searchPath: dir, platform: 'linux' }), undefined);
});

test('only a Windows command shim goes through cmd.exe', () => {
  assert.deepEqual(spawnPlan('/usr/local/bin/codex', ['exec'], { platform: 'linux' }),
    { file: '/usr/local/bin/codex', args: ['exec'], options: {} });
  assert.deepEqual(spawnPlan('C:\\npm\\codex.exe', ['exec'], { platform: 'win32' }),
    { file: 'C:\\npm\\codex.exe', args: ['exec'], options: { windowsHide: true } });
});

// Expected text derived from cross-spawn 7.0.6: the shim re-expands %* before node.exe splits argv,
// so cmd.exe meta characters are escaped twice.
test('a Windows command shim runs through cmd.exe with escaped arguments', () => {
  const plan = spawnPlan('C:\\npm\\codex.cmd', ['exec', 'a & b'], { platform: 'win32', env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' } });
  assert.equal(plan.file, 'C:\\Windows\\system32\\cmd.exe');
  assert.deepEqual(plan.args, ['/d', '/s', '/c', '"C:\\npm\\codex.cmd ^^^"exec^^^" ^^^"a^^^ ^^^&^^^ b^^^""']);
  assert.deepEqual(plan.options, { windowsHide: true, windowsVerbatimArguments: true });
  const fallback = spawnPlan('codex.cmd', ['exec'], { platform: 'win32', env: {} });
  assert.equal(fallback.file, 'cmd.exe', 'a filtered environment without ComSpec still runs cmd.exe');
});

test('the shim escapes every character cmd.exe treats as syntax', () => {
  const plan = spawnPlan('codex.cmd', ['value=50 & echo (own) | more < in > out; "x"'], { platform: 'win32', env: {} });
  const line = plan.args.at(-1).slice(1, -1);
  for (const meta of ['&', '|', '<', '>', '(', ')', ';', '"']) {
    const bare = [...line].filter((character, index) => character === meta && line[index - 1] !== '^');
    assert.deepEqual(bare, [], `${meta} must stay escaped`);
  }
});

// npm-installed CLIs are wrappers that start node themselves with a %dp0%-relative entry, so that
// entry runs directly. The round trip needs no cmd.exe and runs on every host: the args below,
// including the % that cmd.exe expands, must reach the entry unchanged.
test('an npm shim runs its node entry directly and keeps every argument', (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deepcodex-npm-shim-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'npm');
  const entry = path.join(bin, 'node_modules/pkg/bin/cli.js');
  const received = path.join(dir, 'argv.json');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, [
    "import fs from 'node:fs';",
    'fs.writeFileSync(process.env.DEEPCODEX_ARGV_FILE, JSON.stringify(process.argv.slice(2)));',
    '',
  ].join('\n'));
  const shim = path.join(bin, 'codex.cmd');
  fs.writeFileSync(shim, [
    '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL',
    'CALL :find_dp0', '',
    'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=%;', ')', '',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\pkg\\bin\\cli.js" %*',
    '',
  ].join('\r\n'));
  const values = ['plain', 'C:\\work dir\\ticket file.md', 'a & b', '100% of %PATH%', 'quote " here',
    'back\\slash\\', 'key="value"\\n[section]\\nlist=[1, 2]', 'caret ^ pipe | less <in> >out; semi'];
  const plan = spawnPlan(shim, values, { platform: 'win32' });
  assert.equal(plan.file, process.execPath);
  assert.deepEqual(plan.args, [entry, ...values]);
  const result = spawnSync(plan.file, plan.args,
    { encoding: 'utf8', env: { ...process.env, DEEPCODEX_ARGV_FILE: received }, ...plan.options });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(received, 'utf8')), values);
});

// Anything that is not a readable npm wrapper still goes through cmd.exe, which expands %VAR% even
// inside quotes; the argument is refused instead of being corrupted silently.
test('a non-npm wrapper refuses an argument cmd.exe would expand', (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deepcodex-wrapper-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const shim = path.join(dir, 'codex.cmd');
  fs.writeFileSync(shim, '@echo off\r\nnode "%dp0%\\cli.js" %*\r\n');
  assert.throws(() => spawnPlan(shim, ['100% of %PATH%'], { platform: 'win32' }), /cmd\.exe expands/);
  fs.writeFileSync(path.join(dir, 'cli.js'), '');
  fs.writeFileSync(shim, '@echo off\r\nrem %_prog%\r\nnode "%dp0%\\cli.js" %*\r\n');
  assert.throws(() => spawnPlan(shim, ['%PATH%'], { platform: 'win32' }), /cmd\.exe expands/);

  assert.throws(() => spawnPlan(path.join(dir, 'co%dex.cmd'), ['plain'], { platform: 'win32' }), /cmd\.exe expands/);
  const plan = spawnPlan(shim, ['plain'], { platform: 'win32' });
  assert.match(plan.file, /cmd(?:\.exe)?$/i);
  assert.equal(plan.options.windowsVerbatimArguments, true);
  assert.deepEqual(spawnPlan(shim, ['100%'], { platform: 'linux' }),
    { file: shim, args: ['100%'], options: {} }, 'POSIX keeps whatever the command receives');
});

// Only Windows executes a .cmd, so this round trip is skipped elsewhere. The shim expands %* into its
// own command line exactly like the npm shims do, and node then reports the argv it really received;
// comparing it with the requested argv is what proves the escaping for everything cmd.exe can carry.
test('a real .cmd shim forwards the escaped arguments to node', { skip: process.platform !== 'win32' && 'only Windows executes .cmd shims' }, (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deepcodex-shim-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const values = ['plain', 'C:\\work dir\\ticket file.md', 'a & b', 'quote " here', 'back\\slash\\',
    'key="value"\\n[section]\\nlist=[1, 2]', 'caret ^ pipe | less <in> >out; semi'];
  const received = path.join(dir, 'argv.json');
  const script = path.join(dir, 'argv.js');
  fs.writeFileSync(script, [
    "import fs from 'node:fs';",
    'fs.writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));',
    '',
  ].join('\n'));
  const shim = path.join(dir, 'codex.cmd');
  fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${script}" "${received}" %*\r\n`);
  const plan = spawnPlan(shim, values, { platform: 'win32' });
  assert.match(plan.file, /cmd\.exe$/i);
  const result = spawnSync(plan.file, plan.args, { encoding: 'utf8', ...plan.options });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(received, 'utf8')), values);
});

test('POSIX termination kills the process group', { skip: process.platform === 'win32' && 'POSIX signals' }, async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: 'ignore' });
  await killProcessTree(child, { spawn: () => { throw new Error('taskkill must not run outside Windows'); } });
  assert.equal(child.signalCode, 'SIGKILL');
});

test('Windows termination kills the tree with taskkill and reports an unconfirmed fallback', async () => {
  const calls = [];
  const spawnSyncStub = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0 };
  };
  const running = { pid: 4242, exitCode: null, signalCode: null, once: (event, resolve) => resolve() };
  await killProcessTree(running, { platform: 'win32', spawn: spawnSyncStub });
  assert.deepEqual(calls, [{ command: 'taskkill', args: ['/pid', '4242', '/t', '/f'],
    options: { stdio: 'ignore', windowsHide: true } }]);
  // taskkill exits with 128 once the parent already exited; that is not a failed cleanup.
  await killProcessTree({ pid: 9, exitCode: 0, signalCode: null }, { platform: 'win32', spawn: () => ({ status: 128 }) });
  const signals = [];
  const fallback = { pid: 7, exitCode: null, signalCode: null,
    kill: (signal) => { signals.push(signal); fallback.exitCode = 1; } };
  await assert.rejects(() => killProcessTree(fallback, { platform: 'win32', spawn: () => ({ status: 1 }) }),
    /Could not terminate the Codex process tree: taskkill exited with 1.*Descendant processes may still be running/);
  assert.deepEqual(signals, ['SIGKILL']);
  await killProcessTree(null, { platform: 'win32', spawn: spawnSyncStub });
  assert.equal(calls.length, 1, 'a worker that never spawned is not killed again');
});
