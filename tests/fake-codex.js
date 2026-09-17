#!/usr/bin/env node
// Codex process fixture; never connects to a provider.

import fs from 'node:fs';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const emit = text => fs.writeSync(1, text);

if (argv.includes('--version')) {
  emit('codex-cli test\n');
  process.exit(0);
}
if (argv.includes('--help')) {
  emit('--ignore-user-config --ephemeral --json --strict-config\n');
  process.exit(0);
}

const task = fs.readFileSync(0, 'utf8');
const mode = task.trim();
const final = argv[argv.indexOf('--output-last-message') + 1];
if (mode === 'sleep') await delay(30000);
if (mode.startsWith('descendant:')) {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  fs.writeFileSync(mode.slice('descendant:'.length), String(child.pid));
  await delay(30000);
}
if (mode === 'output_limit') {
  emit('x'.repeat(20000));
  await delay(30000);
}
if (mode === 'malformed') emit('not JSON\n');
emit(`${JSON.stringify({ type: 'thread.started', thread_id: 'test-thread' })}\n`);
if (mode === 'failed') emit(`${JSON.stringify({ type: 'turn.failed', error: { message: 'provider failed' } })}\n`);
else if (mode !== 'incomplete') emit(`${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 3 } })}\n`);
if (mode !== 'empty') {
  fs.writeFileSync(final, JSON.stringify({ task, cwd: process.cwd(), argv,
    parent_secret: process.env.PARENT_SECRET ?? null, api_key: process.env.DEEPSEEK_API_KEY ?? null }));
}
if (mode === 'nonzero') process.exitCode = 2;
