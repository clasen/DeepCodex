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

test('credential creation and rotation preserve unrelated entries and private permissions', t => {
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

test('symlink files and directories cannot redirect credential writes', t => {
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
