import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { emitKeypressEvents } from 'node:readline';
import { ROOT, loadConfig, readEnvKey } from './worker.js';
import { ensurePrivateDirectory, privateRead, privateWrite } from './private-files.js';
import { loadPilotConfig, saveJevCompactionEnabled } from './pilot-config.js';

export function readSecret(input = process.stdin, output = process.stderr, { label = 'DeepSeek API key (hidden)', optional = false, echo = false } = {}) {
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
        return finish(secret || optional ? null : new Error('The key cannot be empty.'));
      }
      if (key.name === 'backspace') {
        if (echo && secret) output.write('\b \b');
        secret = secret.slice(0, -1);
      }
      else if (text && !key.ctrl && !key.meta) {
        if (!/^[\x21-\x7e]+$/.test(text)) return finish(new Error('The key must contain only printable characters without spaces.'));
        secret += text;
        if (echo) output.write(text);
      }
    };
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.on('keypress', onKey);
    input.once('end', onEnd);
    input.once('error', onError);
    output.write(`${label}: `);
    input.resume();
  });
}

export function saveCredentials(file, name, secret, options = {}) {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || !/^[\x21-\x7e]+$/.test(secret)) {
    throw new Error('Invalid credential name or key.');
  }
  const directory = path.dirname(file);
  try {
    ensurePrivateDirectory(directory, options);
  } catch (error) {
    throw new Error('Credentials directory must be owned by this user and cannot be a symlink.', { cause: error });
  }
  let existing;
  try {
    existing = privateRead(file, options) ?? '';
  } catch (error) {
    throw new Error('Cannot safely open the credentials file.', { cause: error });
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
  privateWrite(file, lines.join('\n'), { ...options, temporary });
}

function savedKey(file, name) {
  const existing = privateRead(file);
  return existing?.split(/\r\n|\r|\n/).some(line => new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(line))
    ? readEnvKey(file, name) : null;
}

export async function configureCredentials(file, name, input = process.stdin, output = process.stderr, { environment = process.env } = {}) {
  const currentEnabled = loadPilotConfig(ROOT, file).jev_compaction.enabled === true;
  const environmentKey = environment[name];
  const existingKey = environmentKey || savedKey(file, name);
  const enteredKey = await readSecret(input, output, {
    label: existingKey
      ? `DeepSeek API key (hidden; Enter to use ${environmentKey ? 'environment' : 'saved'} key)`
      : 'DeepSeek API key (hidden)',
    optional: Boolean(existingKey),
  });
  const deepseekKey = enteredKey || existingKey;
  const answer = (await readSecret(input, output,
    { label: `Enable Jev compaction? [${currentEnabled ? 'Y/n' : 'y/N'}]`, optional: true, echo: true })).toLowerCase();
  if (!['', 'y', 'yes', 'n', 'no'].includes(answer)) throw new Error('Answer y or n to enable Jev compaction.');
  const jevEnabled = answer === '' ? currentEnabled : ['y', 'yes'].includes(answer);
  let openrouterKey = '';
  if (jevEnabled) {
    openrouterKey = await readSecret(input, output,
      { label: 'OpenRouter API key for Jev compaction (Enter to reuse saved key)', optional: true });
    if (!openrouterKey && !savedKey(file, 'OPENROUTER_API_KEY')) {
      throw new Error('A saved OpenRouter API key is required to enable Jev compaction.');
    }
  }
  saveCredentials(file, name, deepseekKey);
  if (openrouterKey) saveCredentials(file, 'OPENROUTER_API_KEY', openrouterKey);
  saveJevCompactionEnabled(file, jevEnabled);
  return { openrouterSaved: Boolean(openrouterKey), jevEnabled };
}

export async function main(args) {
  if (args.length === 2 && ['--help', '-h'].includes(args[1])) {
    console.log('Usage: deepcodex configure\nEnter the DeepSeek key or press Enter to use an environment or saved key. Choose whether to enable Jev compaction, then enter an OpenRouter key if enabled. Saves private files outside the repository.');
    return 0;
  }
  if (args.length !== 1 || args[0] !== 'configure') throw new Error('Usage: deepcodex configure (no key arguments accepted)');
  const config = loadConfig();
  const name = config.codex.model_providers[config.codex.model_provider].env_key;
  const configured = config.credentials.env_file;
  const file = configured.startsWith('~/') ? path.join(os.homedir(), configured.slice(2)) : configured;
  const { openrouterSaved, jevEnabled } = await configureCredentials(file, name);
  console.log(`${openrouterSaved ? 'DeepSeek and OpenRouter keys' : 'DeepSeek key'} saved with owner-only permissions. Jev compaction ${jevEnabled ? 'enabled' : 'disabled'}. Run deepcodex install to apply the setting or reload an existing router.`);
  return 0;
}
