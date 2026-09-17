import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/opencodex.js', import.meta.url));

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'opencodex-cli-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ['bin', 'scripts', 'work dir', 'empty-path']) fs.mkdirSync(path.join(root, dir));
  fs.copyFileSync(CLI, path.join(root, 'bin/opencodex.js'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.2.3', type: 'module' }));
  for (const name of ['desktop', 'worker', 'pilot', 'credentials']) {
    fs.writeFileSync(path.join(root, `scripts/${name}.js`), `
      export async function main(args) {
        console.log(JSON.stringify({ name: '${name}', args, cwd: process.cwd() }));
        return 7;
      }
      export async function run() { return main([]); }
    `);
  }
  return args => spawnSync(process.execPath, [path.join(root, 'bin/opencodex.js'), ...args], {
    cwd: path.join(root, 'work dir'), env: { HOME: root, PATH: path.join(root, 'empty-path') }, encoding: 'utf8',
  });
}

test('help and version work with no external executables', t => {
  const run = fixture(t);
  for (const args of [[], ['--help'], ['-h'], ['pilot', '--help']]) {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:/);
  }
  for (const flag of ['--version', '-v']) {
    const result = run([flag]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '1.2.3');
  }
});

test('commands dispatch Node modules preserving arguments, cwd and exit status', t => {
  const run = fixture(t);
  for (const [command, module] of [['configure', 'credentials'], ['install', 'desktop'], ['status', 'desktop'], ['doctor', 'worker'], ['run', 'worker'], ['pilot', 'pilot']]) {
    const args = command === 'run' ? ['--cwd', 'a b', '--task-file', 'ticket file.md'] : [];
    const result = run([command, ...args]);
    assert.equal(result.status, 7, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.name, module);
    assert.deepEqual(report.args, command === 'pilot' ? [] : [command, ...args]);
    assert.equal(path.basename(report.cwd), 'work dir');
  }
});

test('invalid commands and pilot arguments cannot launch a module', t => {
  const run = fixture(t);
  for (const args of [['unknown'], ['pilot', '--invalid']]) {
    const result = run(args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
  }
});
