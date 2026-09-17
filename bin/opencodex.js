#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const command = args.shift();
const help = `Usage: opencodex <command>

Commands:
  configure  Save the DeepSeek key using a hidden terminal prompt
  install  Activate the local macOS router and configure Codex
  status   Check the installed router without inference
  doctor   Check worker prerequisites without inference
  run      Run an isolated worker ticket (consumes DeepSeek usage)
  pilot    Test native delegation (consumes Codex and DeepSeek usage)

Requires macOS, Node.js >=22.15 and a compatible Codex CLI.
Run opencodex configure to save the DeepSeek key in ~/.config/opencodex/.env.
Installing this npm package does not activate the router or install the skill
in Codex. Install the plugin through a Codex marketplace to load its skill.
Use opencodex <command> --help for command options.
`;

if (!command || command === '--help' || command === '-h') {
  process.stdout.write(help);
} else if (command === '--version' || command === '-v') {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  console.log(manifest.version);
} else {
  const scripts = { configure: 'credentials.js', install: 'desktop.js', status: 'desktop.js', doctor: 'worker.js', run: 'worker.js', pilot: 'pilot.js' };
  if (!Object.hasOwn(scripts, command)) {
    console.error(`Unknown command: ${command}\n${help}`);
    process.exit(2);
  }
  if (command === 'pilot' && args.length) {
    if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
      console.log('Usage: opencodex pilot\nRuns a live native delegation test; consumes Codex and DeepSeek usage.');
      process.exit(0);
    }
    console.error('Usage: opencodex pilot (no arguments)');
    process.exit(2);
  }
  try {
    const script = await import(new URL(`../scripts/${scripts[command]}`, import.meta.url));
    process.exitCode = command === 'pilot' ? await script.run() : await script.main([command, ...args]);
  } catch (error) {
    console.error(`OpenCodex failed: ${error.message}`);
    process.exitCode = 1;
  }
}
