import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { currentWindowsIdentity, ensurePrivateDirectory, privateOpen, privateRead, privateWrite } from '../scripts/private-files.js';

const SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
const ACCOUNT = 'DESKTOP-TEST\\tester';

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deepcodex-private-files-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// Simulates whoami and icacls so the Windows branch runs on any host. A path
// that was granted an inheritable ACL passes it on to its children, like Windows
// does, and anything else inherits the permissive profile ACL.
function windowsHarness({ identityStatus = 0, applyStatus = 0, foreign = new Map() } = {}) {
  const acl = new Map();
  const calls = [];
  const exec = (command, args = []) => {
    calls.push([command, ...args]);
    if (command === 'whoami') {
      return identityStatus === 0
        ? { status: 0, stdout: `"${ACCOUNT}","${SID}"\r\n`, stderr: '' }
        : { status: identityStatus, stdout: '', stderr: 'Unable to determine the current user.' };
    }
    if (command === 'icacls') {
      const [target, ...rest] = args;
      if (rest.length) {
        if (applyStatus !== 0) return { status: applyStatus, stdout: '', stderr: 'Access is denied.' };
        const grant = rest.at(-1);
        acl.set(target, [`${ACCOUNT}:${grant.slice(grant.indexOf(':') + 1)}`]);
        return { status: 0, stdout: `processed file: ${target}\r\n`, stderr: '' };
      }
      const inherited = acl.get(target) ?? (acl.get(path.dirname(target))?.some(entry => entry.includes('(OI)'))
        ? [`${ACCOUNT}:(I)(OI)(CI)F`]
        : [`${ACCOUNT}:(I)(F)`, 'BUILTIN\\Users:(I)(F)']);
      const entries = [...inherited, ...(foreign.get(target) ?? [])];
      const listed = [entries[0], ...entries.slice(1).map(entry => `        ${entry}`)].join('\r\n');
      return { status: 0, stdout: `${target} ${listed}\r\n`, stderr: '' };
    }
    throw new Error(`Unexpected command: ${command}`);
  };
  return { exec, calls, acl };
}

test('POSIX private directories are created owner-only and reject symlinks', t => {
  const root = temporary(t);
  const directory = path.join(root, 'nested/private');
  ensurePrivateDirectory(directory);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  fs.chmodSync(directory, 0o755);
  ensurePrivateDirectory(directory);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  const link = path.join(root, 'link');
  fs.symlinkSync(directory, link);
  assert.throws(() => ensurePrivateDirectory(link), /symlink/);
});

test('POSIX private writes replace atomically with 0600 and reject symlinks', t => {
  const root = temporary(t);
  const file = path.join(root, 'state.json');
  fs.writeFileSync(file, 'before', { mode: 0o644 });
  privateWrite(file, 'after');
  assert.equal(fs.readFileSync(file, 'utf8'), 'after');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(root), ['state.json']);
  const victim = path.join(root, 'victim');
  fs.writeFileSync(victim, 'preserved');
  fs.symlinkSync(victim, `${file}.tmp`);
  assert.throws(() => privateWrite(file, 'leaked'));
  assert.equal(fs.readFileSync(victim, 'utf8'), 'preserved');
  assert.equal(fs.readFileSync(file, 'utf8'), 'after');
});

test('POSIX private writes can refuse to reuse an existing temporary file', t => {
  const root = temporary(t);
  const file = path.join(root, 'state.json');
  fs.writeFileSync(file, 'before');
  const scratch = path.join(root, 'state.json.exclusive');
  fs.writeFileSync(scratch, 'stale');
  assert.throws(() => privateWrite(file, 'after', { temporary: scratch, exclusive: true }), error => error.code === 'EEXIST');
  assert.equal(fs.readFileSync(file, 'utf8'), 'before');
  assert.equal(fs.readFileSync(scratch, 'utf8'), 'stale');
});

test('POSIX private reads stay owner-only and refuse symlinks and directories', t => {
  const root = temporary(t);
  assert.equal(privateRead(path.join(root, 'missing.env')), null);
  const file = path.join(root, '.env');
  privateWrite(file, 'fixture-value');
  fs.chmodSync(file, 0o644);
  assert.equal(privateRead(file), 'fixture-value');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const victim = path.join(root, 'victim');
  fs.writeFileSync(victim, 'preserved', { mode: 0o600 });
  const link = path.join(root, 'linked.env');
  fs.symlinkSync(victim, link);
  assert.throws(() => privateRead(link));
  assert.equal(fs.readFileSync(victim, 'utf8'), 'preserved');
  assert.throws(() => privateRead(root), /regular file/);
  const fd = privateOpen(file);
  try {
    assert.equal(fs.readFileSync(fd, 'utf8'), 'fixture-value');
  } finally {
    fs.closeSync(fd);
  }
});

test('Windows identity parsing handles CSV output and refuses unknown identities', () => {
  assert.deepEqual(currentWindowsIdentity({ exec: windowsHarness().exec }), { name: ACCOUNT, sid: SID });
  assert.throws(() => currentWindowsIdentity({ exec: windowsHarness({ identityStatus: 1 }).exec }), /Cannot restrict permissions/);
  const unusable = () => ({ status: 0, stdout: 'no identity here\r\n', stderr: '' });
  assert.throws(() => currentWindowsIdentity({ exec: unusable }), /Cannot determine the current Windows user SID/);
});

test('Windows private directories are restricted to the current SID and verified', t => {
  const root = temporary(t);
  const directory = path.join(root, 'private');
  const harness = windowsHarness();
  ensurePrivateDirectory(directory, { platform: 'win32', exec: harness.exec });
  assert.deepEqual(harness.calls, [
    ['whoami', '/user', '/fo', 'csv', '/nh'],
    ['icacls', directory, '/inheritance:r', '/grant:r', `*${SID}:(OI)(CI)F`],
    ['icacls', directory],
  ]);
  const link = path.join(root, 'linked');
  fs.symlinkSync(directory, link);
  const untouched = windowsHarness();
  assert.throws(() => ensurePrivateDirectory(link, { platform: 'win32', exec: untouched.exec }), /symlink/);
  assert.deepEqual(untouched.calls, []);
});

test('Windows private writes grant only the current SID without POSIX calls', t => {
  const root = temporary(t);
  const file = path.join(root, '.env');
  const harness = windowsHarness();
  const chmod = fs.chmodSync;
  const fchmod = fs.fchmodSync;
  let chmods = 0;
  fs.chmodSync = () => { chmods += 1; };
  fs.fchmodSync = () => { chmods += 1; };
  t.after(() => { fs.chmodSync = chmod; fs.fchmodSync = fchmod; });
  privateWrite(file, 'fixture-value', { platform: 'win32', exec: harness.exec });
  assert.equal(fs.readFileSync(file, 'utf8'), 'fixture-value');
  assert.deepEqual(harness.calls, [
    ['whoami', '/user', '/fo', 'csv', '/nh'],
    ['icacls', `${file}.tmp`, '/inheritance:r', '/grant:r', `*${SID}:F`],
    ['icacls', `${file}.tmp`],
  ]);
  assert.equal(chmods, 0);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test('Windows helpers stay usable where process.getuid does not exist', t => {
  const root = temporary(t);
  const directory = path.join(root, 'getuid-free');
  const harness = windowsHarness();
  const descriptor = Object.getOwnPropertyDescriptor(process, 'getuid');
  Object.defineProperty(process, 'getuid', { value: undefined, configurable: true, writable: true });
  t.after(() => Object.defineProperty(process, 'getuid', descriptor));
  ensurePrivateDirectory(directory, { platform: 'win32', exec: harness.exec });
  const file = path.join(directory, '.env');
  privateWrite(file, 'fixture-value', { platform: 'win32', exec: harness.exec });
  assert.equal(fs.readFileSync(file, 'utf8'), 'fixture-value');
});

test('Windows helpers fail closed when owner-only access cannot be proven', t => {
  const root = temporary(t);
  const file = path.join(root, '.env');
  const denied = windowsHarness({ applyStatus: 1 });
  assert.throws(() => privateWrite(file, 'fixture-value', { platform: 'win32', exec: denied.exec }), /Cannot restrict permissions/);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
  const leftover = windowsHarness({ foreign: new Map([[`${file}.tmp`, ['BUILTIN\\Users:(F)']]]) });
  assert.throws(() => privateWrite(file, 'fixture-value', { platform: 'win32', exec: leftover.exec }), /access remains for BUILTIN\\Users/);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test('Windows private reads return null for missing files and refuse reparse points', t => {
  const root = temporary(t);
  const harness = windowsHarness();
  assert.equal(privateRead(path.join(root, 'missing.env'), { platform: 'win32', exec: harness.exec }), null);
  assert.deepEqual(harness.calls, []);
  const victim = path.join(root, 'victim');
  fs.writeFileSync(victim, 'preserved');
  const link = path.join(root, 'linked.env');
  fs.symlinkSync(victim, link);
  assert.throws(() => privateRead(link, { platform: 'win32', exec: harness.exec }), /symlink/);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'preserved');
  assert.deepEqual(harness.calls, []);
  assert.throws(() => privateRead(root, { platform: 'win32', exec: harness.exec }), /regular file/);
});
