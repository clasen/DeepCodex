// Owner-only permissions for private files and directories.
//
// POSIX keeps mode 0700/0600, the current uid and O_NOFOLLOW. Windows mode bits
// and getuid() do not restrict other users, so the same guarantee is implemented
// there with an explicit ACL for the current user SID: inherited entries are
// removed, only that SID keeps access, and the resulting ACL is read back and
// verified. Every Windows step fails closed: when the identity, icacls or the
// verification cannot prove owner-only access, the call throws before content is
// written. Symlinks and other reparse points are refused before and after
// opening, so a private path is never redirected somewhere else.

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const WINDOWS = 'win32';

function platformOf(options) {
  return options.platform ?? process.platform;
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error };
}

function commandOf(options) {
  return options.exec ?? run;
}

function commandFailure(command, result) {
  const detail = result.error?.message || String(result.stderr ?? '').trim() || `${command} exited with status ${result.status}`;
  throw new Error(`Cannot restrict permissions: ${detail}`);
}

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

function assertOwner(stat, label) {
  const uid = currentUid();
  if (uid !== undefined && stat.uid !== uid) throw new Error(`${label} must be owned by this user.`);
}

function csvFields(line) {
  const fields = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (character === ',' && !quoted) {
      fields.push(value);
      value = '';
    } else value += character;
  }
  fields.push(value);
  return fields.map(field => field.trim());
}

// whoami reads its output in the active console code page, so CSV parsing keeps
// working when account or machine names are not ASCII.
export function currentWindowsIdentity(options = {}) {
  const exec = commandOf(options);
  const result = exec('whoami', ['/user', '/fo', 'csv', '/nh']);
  if (result.error || result.status !== 0) commandFailure('whoami', result);
  const line = String(result.stdout ?? '').split(/\r?\n/).find(text => text.trim() !== '');
  const fields = line === undefined ? [] : csvFields(line);
  const sid = fields.find(field => /^S-\d+(?:-\d+)+$/.test(field));
  const name = fields.find(field => field !== sid);
  if (!sid || !name) throw new Error('Cannot determine the current Windows user SID.');
  return { name, sid };
}

function identityOf(options) {
  return options.identity ?? currentWindowsIdentity(options);
}

function aclEntries(output) {
  return String(output ?? '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .flatMap(line => {
      // icacls lists <trustee>:(I)(OI)(CI)(F) and also accepts the unparenthesized
      // simple right in a grant, so both forms have to parse here.
      const match = /^(.*?):\s*((?:(?:\([^)]*\))+[A-Z]*))$/.exec(line);
      return match ? [{ trustee: match[1].trim(), flags: match[2] }] : [];
    });
}

function sameIdentity(trustee, identity) {
  const value = trustee.toLowerCase();
  return value === identity.sid.toLowerCase() || value === identity.name.toLowerCase();
}

// icacls replaces the inherited entries with a single grant for the current SID
// and the ACL is then read back: anything still reachable by another principal
// aborts the operation instead of leaving a readable secret behind.
function restrictWindows(target, kind, identity, options) {
  const exec = commandOf(options);
  const grant = kind === 'directory' ? `*${identity.sid}:(OI)(CI)F` : `*${identity.sid}:F`;
  const applied = exec('icacls', [target, '/inheritance:r', '/grant:r', grant]);
  if (applied.error || applied.status !== 0) commandFailure('icacls', applied);
  const listed = exec('icacls', [target]);
  if (listed.error || listed.status !== 0) commandFailure('icacls', listed);
  const entries = aclEntries(listed.stdout);
  if (!entries.length) throw new Error(`Cannot verify owner-only permissions for ${target}: no access entries reported.`);
  const foreign = entries.filter(entry => !sameIdentity(entry.trustee, identity));
  if (foreign.length) {
    throw new Error(`Cannot verify owner-only permissions for ${target}: access remains for ${foreign.map(entry => entry.trustee).join(', ')}.`);
  }
  return entries;
}

export function ensurePrivateDirectory(directory, options = {}) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink()) throw new Error('A private directory cannot be a symlink.');
  if (!stat.isDirectory()) throw new Error('A private directory must be a directory.');
  if (platformOf(options) === WINDOWS) {
    restrictWindows(directory, 'directory', identityOf(options), options);
    return directory;
  }
  assertOwner(stat, 'The private directory');
  fs.chmodSync(directory, 0o700);
  return directory;
}

// Windows has no O_NOFOLLOW, so the path is inspected before the open and the
// handle is compared with that inspection afterwards. A reparse point, or a file
// swapped in between the two steps, fails the open.
export function privateOpen(filename, options = {}) {
  const platform = platformOf(options);
  const flags = options.flags ?? fs.constants.O_RDONLY;
  const mode = options.mode ?? 0o600;
  if (platform === WINDOWS) {
    let before = null;
    try {
      before = fs.lstatSync(filename);
    } catch (error) {
      if (error?.code !== 'ENOENT' || !(flags & fs.constants.O_CREAT)) throw error;
    }
    if (before?.isSymbolicLink()) throw new Error('A private file cannot be a symlink.');
    if (before && !before.isFile()) throw new Error('A private file must be a regular file.');
    const fd = fs.openSync(filename, flags, mode);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw new Error('A private file must be a regular file.');
      if (before && (before.dev !== stat.dev || before.ino !== stat.ino)) {
        throw new Error('The private file was replaced while it was being opened.');
      }
      restrictWindows(filename, 'file', identityOf(options), options);
      return fd;
    } catch (error) {
      fs.closeSync(fd);
      if (!before && flags & fs.constants.O_CREAT) fs.rmSync(filename, { force: true });
      throw error;
    }
  }
  const fd = fs.openSync(filename, flags | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, mode);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('A private file must be a regular file.');
    assertOwner(stat, 'The private file');
    if ((stat.mode & 0o777) !== 0o600) fs.fchmodSync(fd, 0o600);
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

export function privateRead(filename, options = {}) {
  let fd;
  try {
    fd = privateOpen(filename, { ...options, flags: fs.constants.O_RDONLY });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  try {
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

// Atomic private write: the temporary file is created owner-only, receives the
// content and replaces the target with a rename. options.temporary keeps the
// caller's own temporary name and options.exclusive refuses to truncate a file
// that is already there.
export function privateWrite(filename, content, options = {}) {
  const temporary = options.temporary ?? `${filename}.tmp`;
  const exclusive = options.exclusive === true;
  const create = exclusive ? fs.constants.O_CREAT | fs.constants.O_EXCL : fs.constants.O_CREAT | fs.constants.O_TRUNC;
  const fd = privateOpen(temporary, { ...options, flags: create | fs.constants.O_WRONLY, mode: 0o600 });
  try {
    fs.writeFileSync(fd, content);
  } catch (error) {
    fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  fs.closeSync(fd);
  fs.renameSync(temporary, filename);
  return filename;
}
