// Owner-only permissions for private files and directories.
//
// POSIX keeps mode 0700/0600, the current uid and O_NOFOLLOW. Windows mode bits
// and getuid() do not restrict other users, so the same guarantee is implemented
// there with an ACL for the current user SID: inherited entries are removed, only
// that SID keeps access, and the ACL is read back and verified. The Windows steps
// fail closed: when the identity, icacls or the verification cannot prove
// owner-only access, the call throws before content is written.
//
// options is the test seam: platform, exec and identity can be injected.

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

// whoami writes CSV in the active console code page, so the fields are parsed by
// hand instead of by splitting on commas.
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

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// icacls echoes the target path in front of the first access entry, so that path
// is dropped before the trustee is read. A path printed in another form fails
// verification instead of being mistaken for an allowed principal.
function aclEntries(output, target) {
  const prefix = escapeRegExp(String(target).replaceAll('\\', '/')).replaceAll('/', '[\\\\/]');
  const printed = new RegExp(`^${prefix}[\\\\/]?\\s+`);
  return String(output ?? '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .flatMap(line => {
      const match = printed.exec(line);
      const entry = match ? line.slice(match[0].length) : line;
      // icacls lists (I)(OI)(CI)(F) and also accepts the plain right in a grant.
      const parsed = /^(.*?):\s*((?:(?:\([^)]*\))+[A-Z]*))$/.exec(entry);
      return parsed ? [{ trustee: parsed[1].trim(), flags: parsed[2] }] : [];
    });
}

function sameIdentity(trustee, identity) {
  const value = trustee.toLowerCase();
  return value === identity.sid.toLowerCase() || value === identity.name.toLowerCase();
}

function restrictWindows(target, kind, identity, options) {
  const exec = commandOf(options);
  const grant = kind === 'directory' ? `*${identity.sid}:(OI)(CI)F` : `*${identity.sid}:F`;
  const applied = exec('icacls', [target, '/inheritance:r', '/grant:r', grant]);
  if (applied.error || applied.status !== 0) commandFailure('icacls', applied);
  const listed = exec('icacls', [target]);
  if (listed.error || listed.status !== 0) commandFailure('icacls', listed);
  const entries = aclEntries(listed.stdout, target);
  if (!entries.length) throw new Error(`Cannot verify owner-only permissions for ${target}: no access entries reported.`);
  const foreign = entries.filter(entry => !sameIdentity(entry.trustee, identity));
  if (foreign.length) {
    throw new Error(`Cannot verify owner-only permissions for ${target}: access remains for ${foreign.map(entry => entry.trustee).join(', ')}.`);
  }
  if (!entries.some(entry => entry.flags.includes('F'))) {
    throw new Error(`Cannot verify owner-only permissions for ${target}: full access for the current user is missing.`);
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

// Windows has no O_NOFOLLOW: the path is inspected before the open and the handle
// is compared with that inspection afterwards, so a path swapped in between the
// two steps fails the open.
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

// Atomic: the temporary file is written owner-only and replaces the target with a
// rename. It is always created exclusively, so an existing file is never
// truncated before its permissions could be checked.
export function privateWrite(filename, content, options = {}) {
  const temporary = options.temporary ?? `${filename}.tmp`;
  const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY;
  const fd = privateOpen(temporary, { ...options, flags, mode: 0o600 });
  try {
    try { fs.writeFileSync(fd, content); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temporary, filename);
    return filename;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
