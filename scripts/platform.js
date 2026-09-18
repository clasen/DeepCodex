// Platform differences the worker and the pilot depend on: resolving the Codex CLI, starting a
// Windows command shim and terminating a whole process tree.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Windows resolves a bare command through PATHEXT, but node cannot start a .cmd/.bat shim directly,
// so only the types CreateProcess or cmd.exe can run are considered. The extension-less name is
// skipped on purpose: npm also writes a POSIX shim next to every Windows one.
const WINDOWS_COMMAND_EXTENSIONS = new Set(['.com', '.exe', '.cmd', '.bat']);
const WINDOWS_DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
const WINDOWS_COMMAND = /\.(?:com|exe|cmd|bat)$/i;
const WINDOWS_SHIM = /\.(?:cmd|bat)$/i;

// Windows spells the variables Path/ComSpec/SystemRoot with mixed case and a child inherits only the
// names it is given, so every lookup is case-insensitive.
export function environmentValue(env, name) {
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env).find(candidate => candidate.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

export function executableCandidates(command, { platform = process.platform, pathext } = {}) {
  if (platform !== 'win32' || WINDOWS_COMMAND.test(command)) return [command];
  const configured = pathext ?? environmentValue(process.env, 'PATHEXT') ?? WINDOWS_DEFAULT_PATHEXT;
  const extensions = String(configured)
    .split(';')
    .map(extension => extension.trim().toLowerCase())
    .filter(extension => WINDOWS_COMMAND_EXTENSIONS.has(extension));
  return [...new Set(extensions)].map(extension => command + extension);
}

// PATH lookup that follows PATHEXT, tolerates quoted PATH entries and checks the executable bit only
// where the platform has one.
export function resolveExecutable(command, { searchPath, platform = process.platform, pathext, delimiter = path.delimiter } = {}) {
  const names = executableCandidates(command, { platform, pathext });
  for (const entry of String(searchPath ?? environmentValue(process.env, 'PATH') ?? '').split(delimiter)) {
    const directory = entry.replace(/^"(.*)"$/, '$1');
    for (const name of names) {
      const candidate = path.join(directory || '.', name);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        if (platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // Not a usable candidate; keep searching.
      }
    }
  }
  return undefined;
}

// cmd.exe escaping adapted from cross-spawn 7.0.6, https://github.com/moxystudio/node-cross-spawn,
// whose argument algorithm follows https://qntm.org/cmd. The adaptation applies the meta-character
// escape twice for every shim, because our arguments reach node.exe through the shim's own %* line.
//
// The MIT License (MIT)
//
// Copyright (c) 2018 Made With MOXY Lda <hello@moxy.studio>
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
const CMD_META_CHARACTERS = /([()\][%!^"`<>&|;, *?])/g;

function escapeCommand(value) {
  return String(value).replace(CMD_META_CHARACTERS, '^$1');
}

function escapeArgument(value, doubleEscape) {
  // Double every backslash that precedes a quote or the end of the argument, then quote the whole
  // argument so the sequence survives until the C runtime of the child splits argv.
  let text = `${value}`;
  text = text.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  text = text.replace(/(?=(\\+?)?)\1$/, '$1$1');
  const quoted = `"${text}"`.replace(CMD_META_CHARACTERS, '^$1');
  return doubleEscape ? quoted.replace(CMD_META_CHARACTERS, '^$1') : quoted;
}

// A .cmd/.bat wrapper cannot be started by CreateProcess. An npm wrapper runs through the node entry
// point it names; anything else has to go through cmd.exe, where every argument is escaped twice
// because the wrapper re-expands them through %* before node.exe parses argv.
export function spawnPlan(file, args, { platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32') return { file, args, options: {} };
  const options = { windowsHide: true };
  if (!WINDOWS_SHIM.test(file)) return { file, args, options };
  // npm installs a wrapper that starts node itself, so its entry point runs directly and every
  // argument survives; that is the only way to carry %, which cmd.exe expands even inside quotes.
  const entry = npmEntryPoint(file, { platform });
  if (entry) return { file: process.execPath, args: [entry, ...args], options };
  if ([file, ...args].some(value => String(value).includes('%'))) {
    throw new Error(`Cannot pass an argument containing "%" through the Windows command wrapper ${file}: `
      + 'cmd.exe expands it before the wrapper sees it. Install the Codex CLI as codex.exe, or through npm '
      + 'so its shim can be started directly.');
  }
  const line = [escapeCommand(path.win32.normalize(file)), ...args.map(arg => escapeArgument(arg, true))].join(' ');
  return {
    file: environmentValue(env, 'ComSpec') ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    options: { ...options, windowsVerbatimArguments: true },
  };
}

// npm's wrapper names the node launcher %_prog% and starts a quoted .js entry below the shim
// directory (%dp0%), which is the only shape worth reading: the entry is resolved next to the wrapper
// and must be an existing file, so a wrapper that only looks similar keeps the cmd.exe path.
const NPM_SHIM_ENTRY = /"%_prog%"[ \t]+"%dp0%[\\/]([^"\r\n]+?\.js)"[ \t]+%\*[ \t]*$/im;

export function npmEntryPoint(file, { platform = process.platform } = {}) {
  if (platform !== 'win32' || !WINDOWS_SHIM.test(file)) return undefined;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const entry = NPM_SHIM_ENTRY.exec(text);
  if (!entry) return undefined;
  const target = path.join(path.dirname(file), ...entry[1].split(/[\\/]+/));
  try {
    return fs.statSync(target).isFile() ? target : undefined;
  } catch {
    return undefined;
  }
}

// Codex runs in its own process group, so signalling the group also reaches descendants it left
// behind. Windows has no process groups: the tree is terminated with taskkill while the Codex parent
// still exists, and once that parent is gone there is no handle left to reach descendants it may have
// left behind. That limit is why a taskkill failure on a dead parent is not reported, while a failure
// with the parent still alive is.
export async function killProcessTree(child, { platform = process.platform, spawn = spawnSync } = {}) {
  if (!child || child.pid === undefined) return;
  if (platform === 'win32') {
    const killed = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    // taskkill exits with 128 once the process is already gone, which is the normal case after Codex
    // finished and must not look like a failed cleanup.
    if ((!killed.error && killed.status === 0) || !isRunning(child)) return waitForExit(child);
    try {
      child.kill('SIGKILL');
    } catch {
       // Already gone; the exit check below decides whether to wait.
    }
    await waitForExit(child);
    throw new Error(`Could not terminate the Codex process tree: ${killed.error?.message ?? `taskkill exited with ${killed.status}`}. Descendant processes may still be running.`);
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
    await waitForExit(child);
  }
}

function waitForExit(child) {
  if (isRunning(child)) {
    return new Promise(resolve => child.once('close', resolve));
  }
  return Promise.resolve();
}

function isRunning(child) {
  return child.exitCode === null && child.signalCode === null;
}
