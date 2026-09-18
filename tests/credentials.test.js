import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { readSecret, saveCredentials } from '../scripts/credentials.js';
import { readEnvKey } from '../scripts/worker.js';

const CLI = fileURLToPath(new URL('../bin/deepcodex.js', import.meta.url));
const NAME = 'DEEPSEEK_API_KEY';
const WINDOWS_SID = 'S-1-5-21-999999999-888888888-777777777-1001';
const WINDOWS_ACCOUNT = 'DESKTOP-TEST\\tester';
const POSIX = process.platform !== 'win32';
const SKIP_POSIX = POSIX ? false : 'POSIX permission bits do not apply on this platform';

function canSymlink() {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'deepcodex-symlink-probe-'));
  try {
    fs.symlinkSync(probe, path.join(probe, 'link'), 'dir');
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
}

const SKIP_SYMLINKS = canSymlink() ? false : 'creating symlinks is not permitted on this host';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deepcodex-credentials-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function terminal() {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = value => { input.isRaw = value; };
  let output = '';
  return { input, output: { isTTY: true, write: text => { output += text; } }, text: () => output };
}

// Simulates whoami and icacls so the Windows credential path runs on any host.
function windowsExec() {
  const acl = new Map();
  const calls = [];
  const exec = (command, args = []) => {
    calls.push([command, ...args]);
    if (command === 'whoami') return { status: 0, stdout: `"${WINDOWS_ACCOUNT}","${WINDOWS_SID}"\r\n`, stderr: '' };
    if (command === 'icacls') {
      const [target, ...rest] = args;
      if (rest.length) {
        const grant = rest.at(-1);
        const granted = grant.slice(grant.indexOf(':') + 1).replace(/([A-Z]+)$/, '($1)');
        acl.set(target, `${WINDOWS_ACCOUNT}:${granted}`);
        return { status: 0, stdout: `processed file: ${target}\r\n`, stderr: '' };
      }
      return { status: 0, stdout: `${target} ${acl.get(target) ?? `${WINDOWS_ACCOUNT}:(I)(F)`}\r\n`, stderr: '' };
    }
    throw new Error(`Unexpected command: ${command}`);
  };
  return { exec, calls };
}

test('hidden entry supports backspace without echo and restores terminal mode', async () => {
  const tty = terminal();
  const pending = readSecret(tty.input, tty.output);
  assert.equal(tty.input.isRaw, true);
  tty.input.write('fixture-keX\x7fy\r');
  assert.equal(await pending, 'fixture-key');
  assert.equal(tty.input.isRaw, false);
  assert.equal(tty.input.listenerCount('keypress'), 0);
  assert.equal(tty.text(), 'DeepSeek API key (hidden): \n');
});

test('cancelled, empty, or invalid entry fails without echoing the secret', async () => {
  for (const text of ['fixture-key\x03', '\x04', '\r', 'fixture-key ']) {
    const tty = terminal();
    const pending = readSecret(tty.input, tty.output);
    tty.input.write(text);
    await assert.rejects(pending, error => !error.message.includes('fixture-key'));
    assert.equal(tty.input.isRaw, false);
    assert.equal(tty.text(), 'DeepSeek API key (hidden): \n');
  }
});

test('credential creation and rotation preserve unrelated entries and private permissions', { skip: SKIP_POSIX }, t => {
  const root = fixture(t);
  const file = path.join(root, 'credentials/.env');
  saveCredentials(file, NAME, 'fixture-first');
  assert.equal(readEnvKey(file, NAME), 'fixture-first');
  fs.appendFileSync(file, '# retained\nUNRELATED=value\n');
  fs.chmodSync(file, 0o644);
  const secret = 'fixture-"\\$#value';
  saveCredentials(file, NAME, secret);
  assert.equal(readEnvKey(file, NAME), secret);
  assert.match(fs.readFileSync(file, 'utf8'), /# retained\nUNRELATED=value\n/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['.env']);
});

test('symlink files and directories cannot redirect credential writes', { skip: SKIP_SYMLINKS }, t => {
  const root = fixture(t);
  const target = path.join(root, 'target');
  fs.writeFileSync(target, 'unchanged');
  const file = path.join(root, 'credentials/.env');
  fs.mkdirSync(path.dirname(file));
  fs.symlinkSync(target, file);
  assert.throws(() => saveCredentials(file, NAME, 'fixture-key'), /safely open/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'unchanged');
  const link = path.join(root, 'linked');
  fs.symlinkSync(path.dirname(file), link);
  assert.throws(() => saveCredentials(path.join(link, '.env'), NAME, 'fixture-key'), /cannot be a symlink/);
});

test('Windows credential writes restrict the directory and the file to the current SID', t => {
  const root = fixture(t);
  const file = path.join(root, 'credentials/.env');
  const directory = path.dirname(file);
  const { exec, calls } = windowsExec();
  saveCredentials(file, NAME, 'fixture-windows', { platform: 'win32', exec });
  assert.equal(readEnvKey(file, NAME), 'fixture-windows');
  if (POSIX) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const icacls = calls.filter(([command]) => command === 'icacls');
  const grants = icacls.filter(call => call.includes('/inheritance:r')).map(call => [call[1], call.at(-1)]);
  assert.deepEqual(grants[0], [directory, `*${WINDOWS_SID}:(OI)(CI)F`]);
  assert.equal(path.dirname(grants[1][0]), directory);
  assert.match(path.basename(grants[1][0]), /^\.credentials-[\w-]+\.tmp$/);
  assert.equal(grants[1][1], `*${WINDOWS_SID}:F`);
  assert.ok(icacls.some(call => call.length === 2 && call[1] === grants[1][0]));
});

test('duplicate assignments and invalid secrets leave existing contents untouched', t => {
  const root = fixture(t);
  const file = path.join(root, '.env');
  const contents = `${NAME}=first\nexport ${NAME}=second\n`;
  fs.writeFileSync(file, contents);
  assert.throws(() => saveCredentials(file, NAME, 'fixture-key'), /Duplicate/);
  for (const secret of ['', 'line\nbreak', 'with space']) {
    assert.throws(() => saveCredentials(file, NAME, secret), /Invalid/);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), contents);
});

test('CLI rejects key arguments and piped input without disclosing or saving them', t => {
  const root = fixture(t);
  for (const args of [['configure', 'fixture-key'], ['configure']]) {
    const result = spawnSync(process.execPath, [CLI, ...args], {
      env: { HOME: root }, input: 'fixture-key\n', encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.ok(!`${result.stdout}${result.stderr}`.includes('fixture-key'));
    assert.equal(fs.existsSync(path.join(root, '.config/deepcodex/.env')), false);
  }
  const help = spawnSync(process.execPath, [CLI, 'configure', '--help'], { env: { HOME: root }, encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage: deepcodex configure/);
});
