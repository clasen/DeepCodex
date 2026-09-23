import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { compactionRequest, createStore, estimateTokens, expandReferences, referenceText,
  retainRecentOnly, selectHistory, stripCompactionInstruction, toolExchanges } from '../scripts/compaction.js';
import { completedOutput, sseEvents, startPilot } from '../scripts/pilot-router.js';
import { createJevAsker } from '../scripts/jev-openrouter.js';

const PILOT_CONFIG = JSON.parse(fs.readFileSync(new URL('../config/pilot.json', import.meta.url), 'utf8'));
const NATIVE_MODEL = PILOT_CONFIG.parent_model;
const CAPABILITY = 'capability-under-test-9f2';
const DEEPSEEK_KEY = 'deepseek-key-under-test-4b7';
const REFERENCE = 'deepcodex-jev-v1:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COMPACTION_METADATA = JSON.stringify({ request_kind: 'compaction', turn_id: 'turn_under_test' });
const INSTRUCTION = 'You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.';
const SUMMARY_PREAMBLE = 'Another language model started to solve this problem and produced a summary of its thinking process.';

const exchange = (callId, text, result) => [
  { type: 'function_call', call_id: callId, name: 'exec_command', arguments: JSON.stringify({ cmd: text }) },
  { type: 'function_call_output', call_id: callId, output: result },
];
const conversation = ({ calls }) => [
  { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first question' }] },
  { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'first reasoning' }] },
  ...calls.flatMap(([callId, text, result]) => exchange(callId, text, result)),
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'first answer' }] },
  { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'closing question' }] },
];
const instruction = { type: 'message', role: 'user', content: [{ type: 'input_text', text: INSTRUCTION }] };
// The client stores the reference inside its own summary preamble and re-sends it after the
// messages it kept from the compacted prefix.
const summary = reference => ({ type: 'message', role: 'user',
  content: [{ type: 'input_text', text: `${SUMMARY_PREAMBLE}\n${reference}` }] });
const keepEverything = ({ exchanges }) => exchanges.map(() => ({ keepCall: true, keepResult: true }));

function storeDirectory(t) {
  const directory = path.join(os.tmpdir(), `deepcodex-compaction-test-${randomUUID()}`);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('tool exchanges pair a call with its result and leave other items alone', () => {
  const items = [
    { type: 'message', role: 'user' },
    ...exchange('call_a', 'run a', 'a out'),
    { type: 'reasoning', content: [] },
    ...exchange('call_b', 'run b', 'b out'),
    { type: 'function_call', call_id: 'call_c', name: 'exec_command', arguments: '{}' },
  ];
  assert.deepEqual(toolExchanges(items).map(entry => [entry.callId, entry.callIndex, entry.resultIndex]),
    [['call_a', 1, 2], ['call_b', 4, 5]]);
});

test('selection drops decided exchanges and keeps every other item verbatim', async () => {
  const items = conversation({ calls: [
    ['call_a', 'run a', 'a out'], ['call_b', 'run b', 'b out'], ['call_c', 'run c', 'c out'],
  ] });
  const asker = ({ exchanges }) => {
    assert.deepEqual(exchanges.map(entry => entry.callId), ['call_a', 'call_b']);
    return [{ keepCall: true, keepResult: true }, { keepCall: false, keepResult: false }];
  };
  const pruned = await selectHistory(items, { asker, retainRecent: 4 });
  assert.deepEqual(pruned, items.filter(item => !JSON.stringify(item).startsWith('{"type":"function_call","call_id":"call_b"')
    && !JSON.stringify(item).includes('b out')));
  const calls = pruned.filter(item => item.type === 'function_call').map(item => item.call_id);
  assert.deepEqual(calls, ['call_a', 'call_c']);
  assert.deepEqual(pruned.filter(item => item.type.endsWith('_call_output')).map(item => item.call_id), calls);
});

test('a broken decision contract is rejected instead of guessing', async () => {
  const items = conversation({ calls: [['call_a', 'run a', 'a out'], ['call_b', 'run b', 'b out']] });
  await assert.rejects(selectHistory(items, { asker: () => [{ keepCall: true, keepResult: true }], retainRecent: 0 }),
    /2 candidate exchanges/);
  await assert.rejects(selectHistory(items, { asker: () => [null, null], retainRecent: 0 }),
    /must be an object/);
  await assert.rejects(selectHistory(items, { asker: () => [{ keepCall: true }, { keepCall: true }], retainRecent: 0 }),
    /boolean keepCall and keepResult/);
  await assert.rejects(selectHistory(items, { asker: retainRecentOnly, retainRecent: -1 }), /retain_recent/);
});

test('only the client compaction marker and its instruction are recognised', () => {
  assert.equal(compactionRequest(COMPACTION_METADATA), true);
  assert.equal(compactionRequest(JSON.stringify({ request_kind: 'turn' })), false);
  assert.equal(compactionRequest('not json'), false);
  assert.equal(compactionRequest(undefined), false);
  const items = [...conversation({ calls: [['call_a', 'run a', 'a out']] }), instruction];
  assert.deepEqual(stripCompactionInstruction(items), items.slice(0, -1));
  const question = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'real question' }] };
  assert.deepEqual(stripCompactionInstruction([question]), [question]);
  const marked = { type: 'message', role: 'user',
    content: [{ type: 'input_text', text: 'CONTEXT CHECKPOINT COMPACTION please' }] };
  assert.deepEqual(stripCompactionInstruction([question, marked]), [question]);
});

test('a stored history round-trips owner-only and an unusable reference is rejected', t => {
  const directory = storeDirectory(t);
  const store = createStore(directory);
  const items = conversation({ calls: [['call_a', 'run a', 'a out']] });
  const id = store.save(items);
  assert.match(id, UUID);
  assert.deepEqual(store.load(id), items);
  assert.equal(fs.statSync(path.join(directory, `${id}.json`)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.throws(() => store.load('../../etc/passwd'), /Invalid local compaction reference/);
  assert.throws(() => store.load(randomUUID()), /Unknown local compaction reference/);
  fs.writeFileSync(path.join(directory, `${id}.json`), '{not json');
  assert.throws(() => store.load(id), /Unreadable local compaction reference/);
  fs.writeFileSync(path.join(directory, `${id}.json`), JSON.stringify({ version: 99, items: [] }));
  assert.throws(() => store.load(id), /Unreadable local compaction reference/);
});

test('a summary reference replaces the whole prefix it stands for, exactly once', t => {
  const store = createStore(storeDirectory(t));
  const stored = conversation({ calls: [['call_a', 'run a', 'a out']] });
  const id = store.save(stored);
  const reference = summary(referenceText(id));
  const after = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'next' }] }];
  assert.deepEqual(expandReferences([...stored.slice(0, 2), reference, ...after], store), [...stored, ...after]);
  assert.deepEqual(expandReferences(after, store), after);
  assert.throws(() => expandReferences([reference], null), /Invalid local compaction reference/);
  const truncated = { type: 'message', role: 'user', content: [{ type: 'input_text', text: `${SUMMARY_PREAMBLE}\n${REFERENCE}not-a-uuid` }] };
  assert.throws(() => expandReferences([truncated], store), /Invalid local compaction reference/);
  assert.equal(estimateTokens(stored), Math.ceil(JSON.stringify(stored).length / 4));
});

const completedEvents = model => {
  const response = { id: 'resp_upstream', object: 'response', created_at: 0, model, status: 'completed',
    output: [{ id: 'msg_upstream', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'upstream answer', annotations: [] }] }],
    usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } };
  return [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.completed', response },
  ];
};
const sse = events => events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');

// Real HTTP on loopback: the router relays to this fixture upstream, and the assertions read the
// request bodies that upstream itself received.
async function harness(t, { config = {}, jevAsker = retainRecentOnly } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deepcodex-compaction-router-')));
  const store = `deepcodex-compaction-test-${randomUUID()}`;
  const servers = [];
  const received = [];
  t.after(async () => {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    fs.rmSync(path.join(os.tmpdir(), store), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const upstream = http.createServer(async (request, response) => {
    const parts = [];
    for await (const part of request) parts.push(part);
    received.push(Buffer.concat(parts).toString('utf8'));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(sse(completedEvents(NATIVE_MODEL)));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  servers.push(upstream);
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/responses`;
  const receipts = path.join(root, 'receipts.jsonl');
  const routerConfig = {
    ...PILOT_CONFIG, child_model: 'deepseek-flash', native_models: [NATIVE_MODEL],
    native_url: upstreamUrl, deepseek_url: upstreamUrl, receipts, markers: [], request_timeout_ms: 2000,
    ...config,
    jev_compaction: { ...PILOT_CONFIG.jev_compaction, ...config.jev_compaction, store },
  };
  const startRouter = async () => {
    const router = await startPilot(routerConfig, DEEPSEEK_KEY, CAPABILITY, { jevAsker });
    servers.push(router);
    return router;
  };
  const router = await startRouter();
  const url = () => `http://127.0.0.1:${router.address().port}/responses`;
  return {
    storeDirectory: path.join(os.tmpdir(), store), receipts, received, startRouter,
    entries: () => fs.existsSync(receipts)
      ? fs.readFileSync(receipts, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
      : [],
    request: (input, { headers = {}, ...options } = {}) => fetch(url(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer native-test-token',
        'x-deepcodex-pilot': CAPABILITY, ...headers },
      body: JSON.stringify({ model: NATIVE_MODEL, input }),
      ...options,
    }),
    compact: items => fetch(url(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer native-test-token',
        'x-deepcodex-pilot': CAPABILITY, 'x-codex-turn-metadata': COMPACTION_METADATA },
      body: JSON.stringify({ model: NATIVE_MODEL, input: [...items, instruction] }),
    }),
    // A resumed session talks to a router that was started later, with the same store.
    restartedRequest: async input => {
      const restarted = await startRouter();
      return fetch(`http://127.0.0.1:${restarted.address().port}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer native-test-token',
          'x-deepcodex-pilot': CAPABILITY },
        body: JSON.stringify({ model: NATIVE_MODEL, input }),
      });
    },
  };
}

const enabled = { jev_compaction: { ...PILOT_CONFIG.jev_compaction, enabled: true, retain_recent: 2 } };
const disabled = { jev_compaction: { ...PILOT_CONFIG.jev_compaction, enabled: false } };

async function referenceFrom(box, items) {
  const response = await box.compact(items);
  assert.equal(response.status, 200);
  const [item] = completedOutput(sseEvents(await response.text()));
  assert.equal(item.type, 'message');
  assert.equal(item.role, 'assistant');
  return item.content.map(part => part.text).join('');
}

test('an enabled router answers the compaction request locally and never relays it', async t => {
  const box = await harness(t, { config: enabled });
  const items = conversation({ calls: [['call_a', 'run a', 'a out'], ['call_b', 'run b', 'b out']] });
  const reference = await referenceFrom(box, items);
  assert.ok(reference.startsWith(REFERENCE));
  assert.deepEqual(box.received, []);
  const [entry] = box.entries();
  assert.equal(entry.route, 'compaction');
  assert.equal(entry.completed, true);
  assert.equal(entry.dropped_items, 4);
  assert.equal(entry.retained_items, items.length - 4);
  // The instruction is scaffolding: it is not part of the stored history.
  const store = createStore(box.storeDirectory);
  assert.deepEqual(store.load(reference.slice(REFERENCE.length)), [items[0], items[1], items[6], items[7]]);
});

test('the provider receives the expanded history and never the local reference', async t => {
  const asker = ({ exchanges }) => exchanges.map(entry =>
    ({ keepCall: entry.callId === 'call_a', keepResult: entry.callId === 'call_a' }));
  const box = await harness(t, { config: enabled, jevAsker: asker });
  const items = conversation({ calls: [['call_a', 'run a', 'a out'], ['call_b', 'run b', 'b out']] });
  const reference = await referenceFrom(box, items);
  const next = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'new instruction' }] };
  const response = await box.request([items[0], items[1], items[2], summary(reference), next]);
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(box.received.length, 1);
  const forwarded = JSON.parse(box.received[0]);
  assert.deepEqual(forwarded.input, [items[0], items[1], items[2], items[3], items[6], items[7], next]);
  assert.equal(forwarded.input.filter(item => JSON.stringify(item) === JSON.stringify(items[0])).length, 1);
  assert.equal(forwarded.input.filter(item => item.call_id === 'call_b').length, 0);
  assert.ok(!box.received[0].includes(REFERENCE) && !box.received[0].includes('CONTEXT CHECKPOINT COMPACTION'));
});

test('OpenRouter decisions compact and continue through the router without a native summary', async t => {
  let requests = 0;
  const jevAsker = createJevAsker(PILOT_CONFIG, 'fixture-openrouter-key', {
    fetchImpl: async (url, options) => {
      requests += 1;
      assert.equal(url, 'https://openrouter.ai/api/alpha/decisions');
      assert.equal(options.headers.authorization, 'Bearer fixture-openrouter-key');
      const payload = JSON.parse(options.body);
      return new Response(JSON.stringify({ answers: Object.fromEntries(
        Object.keys(payload.questions).map(key => [key, { noul: 0.1 }])) }));
    },
  });
  const box = await harness(t, { config: enabled, jevAsker });
  const items = conversation({ calls: [['call_a', 'run a', 'a out']] });
  const reference = await referenceFrom(box, items);
  assert.equal(requests, 1);
  assert.equal(box.received.length, 0);
  const response = await box.request([summary(reference)]);
  assert.equal(response.status, 200);
  await response.text();
  assert.deepEqual(JSON.parse(box.received[0]).input, items.filter(item => !item.call_id));
});

test('a reference saved by an earlier router survives a restart', async t => {
  const box = await harness(t, { config: enabled, jevAsker: keepEverything });
  const items = conversation({ calls: [['call_a', 'run a', 'a out']] });
  const reference = await referenceFrom(box, items);
  const response = await box.restartedRequest([summary(reference)]);
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(box.received.length, 1);
  assert.deepEqual(JSON.parse(box.received[0]).input, items);
  assert.ok(!box.received[0].includes(REFERENCE));
});

test('successive compactions keep the pruned history exactly once', async t => {
  const box = await harness(t, { config: enabled });
  const first = conversation({ calls: [['call_a', 'run a', 'a out'], ['call_b', 'run b', 'b out']] });
  const reference = await referenceFrom(box, first);
  const followUp = [first[0], summary(reference), ...exchange('call_c', 'run c', 'c out'),
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'newest instruction' }] }];
  const second = await referenceFrom(box, followUp);
  const response = await box.request([first[0], summary(second)]);
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(box.received.length, 1);
  const forwarded = JSON.parse(box.received[0]);
  assert.deepEqual(forwarded.input, [first[0], first[1], first[6], first[7], followUp.at(-1)]);
  assert.equal(forwarded.input.filter(item => item.call_id === 'call_a').length, 0);
  assert.ok(!box.received[0].includes(REFERENCE));
});

test('the option off keeps the native path and still expands stored history', async t => {
  const box = await harness(t, { config: disabled });
  const stored = conversation({ calls: [['call_a', 'run a', 'a out']] });
  const reference = referenceText(createStore(box.storeDirectory).save(stored));
  const relayed = await box.compact(stored);
  assert.equal(relayed.status, 200);
  await relayed.text();
  assert.ok(box.received[0].includes('CONTEXT CHECKPOINT COMPACTION'));
  assert.deepEqual(box.entries().map(entry => entry.route), ['native']);
  const next = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] };
  const response = await box.request([stored[0], summary(reference), next]);
  assert.equal(response.status, 200, JSON.stringify(box.entries()));
  await response.text();
  assert.deepEqual(JSON.parse(box.received[1]).input, [...stored, next]);
  assert.ok(!box.received[1].includes(REFERENCE));
});

test('an unusable reference fails before the provider sees an incomplete history', async t => {
  const box = await harness(t, { config: enabled });
  const response = await box.request([{ type: 'message', role: 'user' },
    summary(`${REFERENCE}${randomUUID()}`)]);
  assert.equal(response.status, 502);
  assert.deepEqual(box.received, []);
  const [failure] = box.entries();
  assert.equal(failure.route, 'error');
  assert.equal(failure.phase, 'request');
  assert.equal(failure.outcome, 'local_error');
  assert.equal(failure.message, 'Unknown local compaction reference');
  const truncated = await box.request([summary(`${REFERENCE}../../etc/passwd`)]);
  assert.equal(truncated.status, 502);
  assert.equal(box.entries().at(-1).message, 'Invalid local compaction reference');
  assert.deepEqual(box.received, []);
});
