import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { emitKeypressEvents } from 'node:readline';
import { loadConfig } from './worker.js';

export function readSecret(input = process.stdin, output = process.stderr) {
  if (!input.isTTY || !output.isTTY) throw new Error('Configure requires an interactive terminal; do not pass the key as an argument.');
  return new Promise((resolve, reject) => {
    let secret = '';
    const wasRaw = Boolean(input.isRaw);
    const finish = error => {
      input.removeListener('keypress', onKey);
      input.removeListener('end', onEnd);
      input.removeListener('error', onError);
      input.setRawMode(wasRaw);
      input.pause();
      output.write('\n');
      if (error) reject(error);
      else resolve(secret);
      secret = '';
    };
    const onEnd = () => finish(new Error('Key entry cancelled.'));
    const onError = () => finish(new Error('Unable to read the key from the terminal.'));
    const onKey = (text, key = {}) => {
      if ((key.ctrl && ['c', 'd'].includes(key.name)) || key.name === 'escape') return onEnd();
      if (key.name === 'return' || key.name === 'enter') {
        return finish(secret ? null : new Error('The key cannot be empty.'));
      }
      if (key.name === 'backspace') secret = secret.slice(0, -1);
      else if (text && !key.ctrl && !key.meta) {
        if (!/^[\x21-\x7e]+$/.test(text)) return finish(new Error('The key must contain only printable characters without spaces.'));
        secret += text;
      }
    };
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.on('keypress', onKey);
    input.once('end', onEnd);
    input.once('error', onError);
    output.write('DeepSeek API key (hidden): ');
    input.resume();
  });
}

export function saveCredentials(file, name, secret) {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || !/^[\x21-\x7e]+$/.test(secret)) {
    throw new Error('Invalid credential name or key.');
  }
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.uid !== process.getuid()) {
    throw new Error('Credentials directory must be owned by this user and cannot be a symlink.');
  }
  fs.chmodSync(directory, 0o700);
  let existing = '';
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid()) throw new Error('Credentials must be a regular file owned by this user.');
    existing = fs.readFileSync(fd, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Cannot safely open the credentials file.');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  const assignment = `${name}=${JSON.stringify(secret)}`;
  const lines = existing.split(/\r\n|\r|\n/);
  const matches = lines.flatMap((line, index) => new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(line) ? [index] : []);
  if (matches.length > 1) throw new Error('Duplicate key entries in the credentials file; resolve them before configuring.');
  if (matches.length) lines[matches[0]] = assignment;
  else {
    if (lines.at(-1) === '') lines.pop();
    lines.push(assignment, '');
  }
  const temporary = path.join(directory, `.credentials-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, lines.join('\n'), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export async function main(args) {
  if (args.length === 2 && ['--help', '-h'].includes(args[1])) {
    console.log('Usage: opencodex configure\nEnter the DeepSeek key in a hidden terminal prompt. Saves a private plaintext file outside the repository.');
    return 0;
  }
  if (args.length !== 1 || args[0] !== 'configure') throw new Error('Usage: opencodex configure (no key arguments accepted)');
  const config = loadConfig();
  const name = config.codex.model_providers[config.codex.model_provider].env_key;
  const configured = config.credentials.env_file;
  const file = configured.startsWith('~/') ? path.join(os.homedir(), configured.slice(2)) : configured;
  const secret = await readSecret();
  saveCredentials(file, name, secret);
  console.log('DeepSeek key saved with owner-only permissions. Run opencodex install to activate it or reload an existing router.');
  return 0;
}
