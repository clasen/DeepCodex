import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { loadConfig, runWorker, workerEnvironment } from '../scripts/worker.js';

test('real Codex reads a file through a local provider fixture', { skip: !process.env.DEEPCODEX_TEST_CODEX }, async t => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deepcodex-transport-')));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const nonce = 'deepcodex-transport-fixture';
  fs.writeFileSync(path.join(cwd, 'nonce.txt'), nonce);
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const parts = [];
    for await (const chunk of request) parts.push(chunk);
    const payload = JSON.parse(Buffer.concat(parts));
    requests.push(payload);
    const item = requests.length === 1
      ? { id: 'fc_fixture', type: 'function_call', call_id: 'call_fixture', name: 'exec_command',
        arguments: JSON.stringify({ cmd: 'cat nonce.txt', workdir: cwd, max_output_tokens: 1000 }) }
      : { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'fixture completed', annotations: [] }] };
    const result = { id: `resp_${requests.length}`, object: 'response', created_at: 0, model: payload.model,
      status: 'completed', output: [item], usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } };
    const events = [
      { type: 'response.created', response: { ...result, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: result },
    ];
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  console.log(JSON.stringify({ fixture_server_pid: process.pid, cwd, port: server.address().port, owner: 'DeepCodex transport test' }));
  const config = loadConfig();
  config.codex.model_providers['deepcodex-deepseek'].base_url = `http://127.0.0.1:${server.address().port}`;
  config.codex.features.enable_request_compression = false;
  config.limits.timeout_seconds = 30;
  const env = workerEnvironment({ ...process.env, DEEPSEEK_API_KEY: 'local-test-key' });
  const result = await runWorker(process.env.DEEPCODEX_TEST_CODEX, config, cwd,
    'Read nonce.txt with the shell tool and report completion.', false, env);
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.result.trim(), 'fixture completed');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].model, 'deepseek-flash');
  assert.ok(requests[0].tools.some(tool => tool.name === 'exec_command'));
  assert.ok(JSON.stringify(requests[1].input).includes(nonce));
});
