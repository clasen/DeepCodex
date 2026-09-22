import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { startPilot } from '../scripts/pilot-router.js';
import { buildCommand, killGroup, loadConfig, parseResult, workerEnvironment } from '../scripts/worker.js';

const realCodex = { skip: !process.env.DEEPCODEX_TEST_CODEX
  || (process.platform === 'win32' && 'recovery fixtures use a POSIX shell command and process groups'), timeout: 90000 };
const frame = event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

async function recover(t, failure, { childRoute = false, persistent = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deepcodex-recovery-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const home = path.join(root, 'codex-home');
  fs.mkdirSync(workspace);
  fs.mkdirSync(home);
  const requests = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks));
    requests.push(payload);
    const fail = persistent || requests.length === 1;
    if (fail && (failure === 'http' || failure === 'unauthorized')) {
      response.writeHead(failure === 'http' ? 503 : 401, { 'content-type': 'application/json', 'retry-after': '0' });
      response.end(JSON.stringify({ error: { message: 'fixture unavailable' } }));
      return;
    }
    const hasToolResult = payload.input.some(item => item.type === 'function_call_output');
    const item = ['tool', 'partial_tool'].includes(failure) && !hasToolResult
      ? { id: 'fc_recovery', type: 'function_call', call_id: 'call_recovery', name: 'exec_command',
        arguments: JSON.stringify({ cmd: 'printf x >> invocations.txt', workdir: workspace, max_output_tokens: 100 }) }
      : { id: 'msg_recovery', type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'recovered', annotations: [] }] };
    const result = { id: `resp_${requests.length}`, object: 'response', created_at: 0, model: payload.model,
      status: 'completed', output: [item], usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } };
    response.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': `fixture-${requests.length}` });
    response.write(frame({ type: 'response.created', response: { ...result, status: 'in_progress', output: [] } }));
    if (fail && failure === 'deadline') return;
    response.write(frame({ type: 'response.output_item.added', output_index: 0, item }));
    if (fail && ['partial', 'partial_tool'].includes(failure)) {
      response.write('event: response.output_text.delta\ndata: {"type":');
    } else {
      response.write(frame({ type: 'response.output_item.done', output_index: 0, item }));
    }
    if (fail) {
      const timer = setTimeout(() => response.destroy(), 40);
      response.on('close', () => clearTimeout(timer));
      return;
    }
    response.end(frame({ type: 'response.completed', response: result }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => { upstream.closeAllConnections(); return new Promise(resolve => upstream.close(resolve)); });
  const config = loadConfig();
  if (!childRoute) config.codex.model = 'gpt-6-astra';
  const routerConfig = {
    ...JSON.parse(fs.readFileSync(new URL('../config/pilot.json', import.meta.url))),
    native_url: `http://127.0.0.1:${upstream.address().port}/responses`,
    deepseek_url: `http://127.0.0.1:${upstream.address().port}/responses`,
    native_models: ['gpt-6-astra'], child_model: 'deepseek-flash', max_requests: null,
    request_timeout_ms: failure === 'deadline' ? 500 : 30000,
    receipts: path.join(root, 'receipts.jsonl'), markers: [],
  };
  const router = await startPilot(routerConfig, 'fixture-provider-key', 'fixture-capability');
  t.after(() => { router.closeAllConnections(); return new Promise(resolve => router.close(resolve)); });
  const provider = config.codex.model_providers[config.codex.model_provider];
  provider.base_url = `http://127.0.0.1:${router.address().port}`;
  provider.http_headers = { 'x-deepcodex-pilot': 'fixture-capability' };
  config.codex.features.enable_request_compression = false;
  const env = workerEnvironment({ ...process.env, CODEX_HOME: home, DEEPSEEK_API_KEY: 'fixture-client-key' });
  const { args, finalPath } = buildCommand(process.env.DEEPCODEX_TEST_CODEX, config, workspace, true, root);
  const child = spawn(args[0], args.slice(1), { cwd: workspace, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => killGroup(child));
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.end('Follow the fixture instructions and report completion.');
  const timer = setTimeout(() => void killGroup(child), 80000);
  const [code] = await once(child, 'close');
  clearTimeout(timer);
  const result = parseResult(stdout, stderr, fs.existsSync(finalPath) ? fs.readFileSync(finalPath, 'utf8') : '', code, null, config);
  const receipts = fs.readFileSync(routerConfig.receipts, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  return { result, requests, receipts, stdout, workspace, provider };
}

for (const failure of ['http', 'partial', 'tool', 'partial_tool', 'deadline']) {
  test(`real Codex recovers from ${failure} failure through the router`, realCodex, async t => {
    const box = await recover(t, failure);
    assert.equal(box.result.status, 'completed', JSON.stringify(box.result) + '\n' + box.stdout);
    assert.equal(box.result.result, 'recovered');
    assert.equal(box.requests.length, failure === 'partial_tool' ? 3 : 2);
    assert.ok(box.receipts.some(entry => entry.completed));
    if (['tool', 'partial_tool'].includes(failure)) {
      assert.equal(fs.readFileSync(path.join(box.workspace, 'invocations.txt'), 'utf8'), 'x');
      assert.equal(box.requests.at(-1).input.filter(item => item.type === 'function_call_output').length, 1);
    }
  });
}

test('real Codex recovers a truncated DeepSeek stream through the namespace transform', realCodex, async t => {
  const box = await recover(t, 'partial', { childRoute: true });
  assert.equal(box.result.status, 'completed', JSON.stringify(box.result));
  assert.equal(box.requests.length, 2);
  assert.ok(box.receipts.some(entry => entry.route === 'deepseek' && entry.completed));
});

test('real Codex stops retrying a persistently truncated stream', realCodex, async t => {
  const box = await recover(t, 'partial', { persistent: true });
  assert.equal(box.result.status, 'failed');
  assert.equal(box.requests.length, box.provider.stream_max_retries + 1);
  assert.ok(box.receipts.every(entry => !entry.completed));
});

test('real Codex bounds HTTP retries and preserves a final provider failure', realCodex, async t => {
  const box = await recover(t, 'http', { persistent: true });
  assert.equal(box.result.status, 'failed');
  assert.equal(box.requests.length, (box.provider.request_max_retries + 1) * (box.provider.stream_max_retries + 1));
  assert.ok(box.receipts.every(entry => entry.http_status === 503));
});

test('real Codex preserves authentication failures after bounded stream retries', realCodex, async t => {
  const box = await recover(t, 'unauthorized', { persistent: true });
  assert.equal(box.result.status, 'failed');
  assert.equal(box.requests.length, box.provider.stream_max_retries + 1);
  assert.ok(box.receipts.every(entry => entry.http_status === 401));
});
