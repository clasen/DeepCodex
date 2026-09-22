import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Readable } from 'node:stream';
import { completedOutput, nativeHeaders, plaintextHandoffs, prepareDeepseek, safeErrorCode, sseEvents,
  startPilot } from '../scripts/pilot-router.js';
import { NamespaceToolCallTransform } from '../vendor/codex-router/namespace-relay.js';

const PILOT_CONFIG = JSON.parse(fs.readFileSync(new URL('../config/pilot.json', import.meta.url), 'utf8'));
const NATIVE_MODEL = PILOT_CONFIG.parent_model;
const CAPABILITY = 'capability-under-test-9f2';
const DEEPSEEK_KEY = 'deepseek-key-under-test-4b7';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const sseBody = events => events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
const completedEvents = model => {
  const response = { id: 'resp_test', object: 'response', created_at: 0, model, status: 'completed', output: [],
    usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } };
  return [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.completed', response }];
};

// Real HTTP on loopback: the router under test relays to this fixture upstream, and every assertion
// reads the receipts file the router itself wrote.
async function harness(t, behave, { config = {}, key = DEEPSEEK_KEY } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deepcodex-router-test-')));
  const receipts = path.join(dir, 'receipts.jsonl');
  const servers = [];
  t.after(async () => {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const upstream = http.createServer(behave);
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  servers.push(upstream);
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/responses`;
  const router = await startPilot({
    ...PILOT_CONFIG, child_model: 'deepseek-flash', native_models: [NATIVE_MODEL],
    native_url: upstreamUrl, deepseek_url: upstreamUrl, receipts, markers: [], request_timeout_ms: 2000,
    ...config,
  }, key, CAPABILITY);
  servers.push(router);
  const entries = () => fs.existsSync(receipts)
    ? fs.readFileSync(receipts, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    : [];
  return {
    receipts, entries,
    // A cancelled or timed-out request ends without a client read, so wait for its receipt on disk.
    waitFor: async predicate => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const found = entries().find(predicate);
        if (found) return found;
        await delay(10);
      }
      throw new Error(`receipt not observed: ${JSON.stringify(entries())}`);
    },
    request: (options = {}) => fetch(`http://127.0.0.1:${router.address().port}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer native-test-token',
        'x-deepcodex-pilot': CAPABILITY },
      body: JSON.stringify({ model: NATIVE_MODEL, input: [] }),
      ...options,
    }),
  };
}

test('native credential forwarding excludes local capabilities and unrelated headers', () => {
  assert.deepEqual(nativeHeaders({ authorization: 'Bearer test', 'chatgpt-account-id': 'account',
    'x-deepcodex-pilot': 'local-secret', cookie: 'private-cookie', host: 'localhost' }), {
    'content-type': 'application/json', accept: 'text/event-stream',
    authorization: 'Bearer test', 'chatgpt-account-id': 'account',
  });
});

test('plaintext child replies become readable handoffs without modifying encrypted native tasks', () => {
  const items = [{ type: 'agent_message', content: [
    { type: 'encrypted_content', encrypted_content: 'child result' },
    { type: 'encrypted_content', encrypted_content: 'gAAAAAtoken_123=' },
  ] }];
  assert.deepEqual(plaintextHandoffs(items)[0].content, [
    { type: 'input_text', text: 'child result' }, items[0].content[1],
  ]);
  assert.equal(items[0].content[0].type, 'encrypted_content');
});

test('DeepSeek receives native task text, reasoning, shell and patch tools', () => {
  const input = [{ type: 'agent_message', content: [{ type: 'input_text', text: 'Read first.txt' }] },
    { type: 'reasoning', content: 'prior reasoning' }];
  const { payload: body } = prepareDeepseek({ reasoning: { effort: 'xhigh' }, tools: [
    { type: 'function', name: 'exec_command' }, { type: 'custom', name: 'apply_patch' },
    { type: 'namespace', name: 'collaboration', tools: [] },
  ] }, input);
  assert.equal(body.input[0].type, 'message');
  assert.equal(body.input[0].content[0].text, 'Read first.txt');
  assert.deepEqual(body.input[1].content, [{ type: 'reasoning_text', text: 'prior reasoning' }]);
  assert.deepEqual(body.tools.map(tool => tool.name), ['exec_command', 'apply_patch']);
  assert.equal(body.reasoning.effort, 'high');
  const { payload: custom } = prepareDeepseek({ tools: [{ type: 'custom', name: 'exec' }] }, []);
  assert.equal(custom.tools[0].type, 'function');
  assert.deepEqual(custom.tools[0].parameters.required, ['input']);
});

test('Desktop namespaces survive the provider round trip and retain their history identity', async () => {
  const prepared = prepareDeepseek({ tools: [{ type: 'namespace', name: 'app', tools: [
    { type: 'function', name: 'read', parameters: { type: 'object', properties: {} } },
  ] }] }, [{ type: 'function_call', name: 'read', namespace: 'app', call_id: 'prior', arguments: '{}' }]);
  const name = prepared.payload.tools[0].name;
  assert.equal(prepared.payload.input[0].name, name);
  const item = { id: 'fc_test', call_id: 'test', type: 'function_call', name, arguments: '{}' };
  const events = [{ type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'resp_test', status: 'completed', output: [item] } }];
  const source = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  const output = [];
  for await (const chunk of Readable.from(source).pipe(new NamespaceToolCallTransform(prepared.namespaces, 'text/event-stream'))) output.push(chunk);
  const rewritten = completedOutput(sseEvents(Buffer.concat(output.map(part => Buffer.from(part))).toString()));
  assert.equal(rewritten[0].name, 'read');
  assert.equal(rewritten[0].namespace, 'app');
});

test('SSE parsing accepts CRLF, comments and multiline data but rejects malformed events', () => {
  assert.deepEqual(sseEvents(': heartbeat\r\n\r\ndata: {"type":\r\ndata: "response.completed"}\r\n\r\ndata: [DONE]\r\n\r\n'),
    [{ type: 'response.completed' }]);
  assert.throws(() => sseEvents('data: invalid\n\n'), SyntaxError);
});

test('native item completion survives an empty final response output', () => {
  const item = { id: 'fc_test', type: 'function_call', name: 'relay_external_agent_payload', arguments: '{"payload":"task"}' };
  assert.deepEqual(completedOutput([
    { type: 'response.output_item.done', item },
    { type: 'response.completed', response: { output: [] } },
  ]), [item]);
  assert.equal(completedOutput([
    { type: 'response.output_item.done', item },
    { type: 'response.completed', response: { output: [item] } },
  ]).length, 1);
});

test('error codes come from an allowlist instead of upstream messages or objects', () => {
  const terminated = Object.assign(new TypeError('terminated'),
    { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });
  assert.equal(safeErrorCode(terminated), 'UND_ERR_SOCKET');
  assert.equal(safeErrorCode({ code: 'Z_DATA_ERROR', message: 'incorrect header check' }), 'Z_DATA_ERROR');
  assert.equal(safeErrorCode(new DOMException('This operation was aborted', 'AbortError')), 'ABORT_ERR');
  assert.equal(safeErrorCode(new Error('Response size limit exceeded')), 'unknown');
  assert.equal(safeErrorCode(undefined), 'unknown');
  assert.equal(safeErrorCode({ message: 'leak', code: 'SECRET_CODE',
    cause: { code: 'ALSO_SECRET', message: 'Bearer secret', headers: { authorization: 'Bearer secret' } } }), 'unknown');
});

test('a completed relay records bounded request telemetry', async t => {
  const box = await harness(t, (request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(sseBody(completedEvents(NATIVE_MODEL)));
  });
  const response = await box.request();
  assert.equal(response.status, 200);
  assert.ok((await response.text()).includes('response.completed'));
  const [entry] = box.entries();
  assert.equal(entry.route, 'native');
  assert.equal(entry.model, NATIVE_MODEL);
  assert.equal(entry.response_model, NATIVE_MODEL);
  assert.equal(entry.http_status, 200);
  assert.equal(entry.completed, true);
  assert.equal(entry.outcome, undefined);
  assert.ok(entry.bytes_sent > 0);
  assert.ok(Number.isInteger(entry.duration_ms) && entry.duration_ms >= 0);
  assert.equal(new Date(entry.timestamp).toISOString(), entry.timestamp);
  assert.match(entry.request_id, UUID);
});

test('a partial upstream cut records the socket cause and the streamed byte count', async t => {
  const box = await harness(t, (request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('event: response.created\ndata: {"type":"response.created"}\n\n');
    setTimeout(() => response.socket.destroy(), 30);
  });
  await assert.rejects(box.request().then(response => response.text()), /terminated/);
  const failure = await box.waitFor(entry => entry.route === 'error');
  assert.equal(failure.message, 'terminated');
  assert.equal(failure.phase, 'upstream');
  assert.equal(failure.outcome, 'upstream_error');
  assert.equal(failure.error_code, 'UND_ERR_SOCKET');
  assert.equal(failure.upstream_route, 'native');
  assert.equal(failure.model, NATIVE_MODEL);
  assert.equal(failure.http_status, 200);
  assert.ok(failure.bytes_sent > 0);
  assert.ok(Number.isInteger(failure.duration_ms) && failure.duration_ms >= 0);
  assert.equal(new Date(failure.timestamp).toISOString(), failure.timestamp);
  assert.match(failure.request_id, UUID);
  assert.ok(!('cause' in failure) && !('headers' in failure));
});

test('a client disconnect is recorded apart from an upstream failure', async t => {
  const box = await harness(t, (request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('event: response.created\ndata: {"type":"response.created"}\n\n');
  });
  const controller = new AbortController();
  const response = await box.request({ signal: controller.signal });
  assert.equal(response.status, 200);
  await delay(50);
  controller.abort();
  const cancelled = await box.waitFor(entry => entry.route === 'cancelled');
  assert.equal(cancelled.reason, 'codex_disconnected');
  assert.equal(cancelled.phase, 'upstream');
  assert.equal(cancelled.outcome, 'client_disconnect');
  assert.equal(cancelled.upstream_route, 'native');
  assert.equal(typeof cancelled.bytes_sent, 'number');
  assert.ok(Number.isInteger(cancelled.duration_ms) && cancelled.duration_ms >= 0);
  assert.equal(new Date(cancelled.timestamp).toISOString(), cancelled.timestamp);
  assert.match(cancelled.request_id, UUID);
});

test('the router deadline records a timeout instead of an upstream error', async t => {
  const box = await harness(t, (request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('event: response.created\ndata: {"type":"response.created"}\n\n');
  }, { config: { request_timeout_ms: 150 } });
  await assert.rejects(box.request().then(response => response.text()));
  const failure = await box.waitFor(entry => entry.route === 'error');
  assert.equal(failure.phase, 'upstream');
  assert.equal(failure.outcome, 'timeout');
  assert.equal(failure.error_code, 'ABORT_ERR');
  assert.equal(failure.upstream_route, 'native');
  assert.equal(failure.http_status, 200);
  assert.equal(new Date(failure.timestamp).toISOString(), failure.timestamp);
  assert.match(failure.request_id, UUID);
});

test('an upstream that ends cleanly without a terminal event keeps the completed flag honest', async t => {
  const box = await harness(t, (request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('event: response.created\ndata: {"type":"response.created"}\n\n');
  });
  const response = await box.request();
  assert.equal(response.status, 200);
  await response.text();
  const [entry] = box.entries();
  assert.equal(entry.route, 'native');
  assert.equal(entry.completed, false);
  assert.equal(entry.outcome, undefined);
  assert.ok(entry.bytes_sent > 0);
});

test('an invalid upstream frame is reported generically instead of echoing the body', async t => {
  const sentinel = 'sentinel-2c9';
  const box = await harness(t, (request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`event: response.created\ndata: ${sentinel}\n\n`);
  });
  await assert.rejects(box.request().then(response => response.text()));
  const failure = await box.waitFor(entry => entry.route === 'error');
  assert.equal(failure.phase, 'upstream');
  assert.equal(failure.outcome, 'upstream_error');
  assert.equal(failure.message, 'Invalid JSON upstream response');
  assert.equal(failure.error_code, 'unknown');
  assert.ok(failure.bytes_sent > 0);
  const written = fs.readFileSync(box.receipts, 'utf8');
  assert.ok(!written.includes(sentinel) && !written.includes(DEEPSEEK_KEY) && !written.includes(CAPABILITY));
});

test('an invalid request body is attributed to the request phase without echoing it', async t => {
  const sentinel = 'sentinel-2c9';
  const box = await harness(t, (request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
  const response = await box.request({ body: `task:${sentinel}` });
  assert.equal(response.status, 502);
  const [failure] = box.entries();
  assert.equal(failure.route, 'error');
  assert.equal(failure.phase, 'request');
  assert.equal(failure.outcome, 'local_error');
  assert.equal(failure.message, 'Invalid JSON request body');
  assert.equal(failure.error_code, 'unknown');
  assert.equal(failure.upstream_route, undefined);
  assert.equal(failure.http_status, undefined);
  assert.ok(!fs.readFileSync(box.receipts, 'utf8').includes(sentinel));
});

test('a relay leg failure is attributed to the relay phase', async t => {
  const box = await harness(t, (request, response) => {
    response.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"relay unavailable"}');
  });
  const response = await box.request({ body: JSON.stringify({ model: 'deepseek-flash', input: [
    { type: 'agent_message', recipient: 'flash',
      content: [{ type: 'encrypted_content', encrypted_content: 'gAAAAAbcdef' }] },
  ] }) });
  assert.equal(response.status, 502);
  const entries = box.entries();
  const relay = entries.find(entry => entry.route === 'relay');
  const failure = entries.find(entry => entry.route === 'error');
  assert.equal(relay.http_status, 500);
  assert.equal(relay.request_id, failure.request_id);
  assert.equal(failure.route, 'error');
  assert.equal(failure.phase, 'relay');
  assert.equal(failure.outcome, 'upstream_error');
  assert.equal(failure.upstream_route, 'relay');
  // The relay leg never reached the main upstream call, so only the relay receipt carries its status.
  assert.equal(failure.http_status, undefined);
  assert.equal(failure.message, 'Native relay HTTP 500');
});

test('relay callbacks share the request id of the turn that triggered them', async t => {
  const relayCall = { id: 'fc_relay', type: 'function_call', call_id: 'call_relay',
    name: 'relay_external_agent_payload', arguments: JSON.stringify({ payload: 'relayed task' }) };
  const message = { id: 'msg_done', type: 'message', role: 'assistant',
    content: [{ type: 'output_text', text: 'child done' }] };
  const box = await harness(t, async (request, response) => {
    const parts = [];
    for await (const chunk of request) parts.push(chunk);
    const payload = JSON.parse(Buffer.concat(parts));
    const relayed = payload.tool_choice?.name === 'relay_external_agent_payload';
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(sseBody([
      { type: 'response.created', response: { id: 'resp_fixture', status: 'in_progress', output: [] } },
      { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', model: payload.model,
        output: [relayed ? relayCall : message], usage: { input_tokens: 1, output_tokens: 1 } } },
    ]));
  });
  const response = await box.request({ body: JSON.stringify({ model: 'deepseek-flash', input: [
    { type: 'agent_message', recipient: 'flash',
      content: [{ type: 'encrypted_content', encrypted_content: 'gAAAAAbcdef' }] },
  ] }) });
  assert.equal(response.status, 200);
  await response.text();
  const relay = await box.waitFor(entry => entry.route === 'relay');
  const child = await box.waitFor(entry => entry.route === 'deepseek');
  assert.equal(relay.http_status, 200);
  assert.equal(child.completed, true);
  assert.equal(relay.request_id, child.request_id);
  assert.match(relay.request_id, UUID);
  assert.equal(new Date(relay.timestamp).toISOString(), relay.timestamp);
});
