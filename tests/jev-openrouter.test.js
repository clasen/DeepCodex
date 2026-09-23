import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createJevAsker } from '../scripts/jev-openrouter.js';

const PILOT_CONFIG = JSON.parse(fs.readFileSync(new URL('../config/pilot.json', import.meta.url), 'utf8'));
const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
const API_KEY = 'openrouter-key-under-test-7c1';
// A string the provider never sends: it stands in for response bodies that must not surface.
const MARKER = 'provider-body-marker-3ab';

const ITEMS = [
  { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first question' }] },
  { type: 'function_call', call_id: 'call_a', name: 'exec_command', arguments: '{"cmd":"ls"}' },
  { type: 'function_call_output', call_id: 'call_a', output: 'a out' },
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'first answer' }] },
  { type: 'function_call', call_id: 'call_b', name: 'exec_command', arguments: '{"cmd":"pwd"}' },
  { type: 'function_call_output', call_id: 'call_b', output: 'b out' },
];
const EXCHANGES = [
  { callId: 'call_a', callIndex: 1, resultIndex: 2 },
  { callId: 'call_b', callIndex: 4, resultIndex: 5 },
];

function config(overrides = {}) {
  return {
    ...PILOT_CONFIG,
    ...overrides,
    jev_compaction: { ...PILOT_CONFIG.jev_compaction, ...overrides.jev_compaction },
  };
}

// One [call, result] pair per exchange, keyed the way the adapter asks for them.
function answers(pairs) {
  const decisions = {};
  pairs.forEach(([call, result], index) => {
    decisions[`call_${index}`] = { noul: call };
    decisions[`result_${index}`] = { noul: result };
  });
  return { model: 'typesafe/jev-1.13-20260917', answers: decisions, usage: { input_tokens: 40, output_tokens: 6 } };
}

function recordingFetch(reply) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return reply(url, options);
  };
  return { calls, fetchImpl };
}

function jsonReply(payload, status = 200) {
  return () => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

const okFetch = () => recordingFetch(jsonReply(answers([[0.7, 0.9], [0.2, 0.1]])));
// A result body is replaced by the size of the item that carried it.
const omitted = item => `${JSON.stringify(item).length} chars (omitted)`;

// One user message and `count` tool exchanges, every item with its own history index.
function history(count) {
  const items = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'start' }] }];
  const exchanges = [];
  for (let index = 0; index < count; index += 1) {
    items.push({ type: 'function_call', call_id: `call_${index}`, name: 'exec_command', arguments: '{}' });
    items.push({ type: 'function_call_output', call_id: `call_${index}`, output: 'out' });
    exchanges.push({ callId: `call_${index}`, callIndex: items.length - 2, resultIndex: items.length - 1 });
  }
  return { items, exchanges };
}

// Answers every question from the history index it names, so a merged decision list proves the
// per-batch answers came back in exchange order.
function scoringFetch() {
  return recordingFetch((url, options) => {
    const payload = JSON.parse(options.body);
    const decisions = {};
    for (const [id, question] of Object.entries(payload.questions)) {
      const index = Number(/History index (\d+)/.exec(question.instructions)[1]);
      decisions[id] = { noul: (index % 10) / 10 };
    }
    return new Response(JSON.stringify({ model: 'typesafe/jev-1.13', answers: decisions }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

const expectedDecisions = exchanges => exchanges.map(({ callIndex, resultIndex }) => ({
  keepCall: (callIndex % 10) / 10 >= PILOT_CONFIG.jev_compaction.keep_threshold,
  keepResult: (resultIndex % 10) / 10 >= PILOT_CONFIG.jev_compaction.keep_threshold,
}));

test('asks the fixed decisions route for a call and a result question per exchange', async () => {
  const { calls, fetchImpl } = okFetch();
  const decisions = await createJevAsker(config(), API_KEY, { fetchImpl })({ items: ITEMS, exchanges: EXCHANGES });

  assert.deepEqual(decisions, [
    { keepCall: true, keepResult: true },
    { keepCall: false, keepResult: false },
  ]);
  assert.equal(calls.length, 1);
  const { url, options } = calls[0];
  assert.equal(url, DECISIONS_URL);
  assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers['content-type'], 'application/json');
  assert.equal(options.headers.accept, 'application/json');
  assert.equal(options.headers.authorization, `Bearer ${API_KEY}`);
  assert.ok(options.signal instanceof AbortSignal);

  const body = JSON.parse(options.body);
  assert.equal(body.model, PILOT_CONFIG.jev_compaction.model);
  // The state is the same history index for index, with result bodies replaced by their size.
  assert.deepEqual(body.state, { items: [
    { type: 'message', role: 'user', text: 'first question' },
    { type: 'function_call', call_id: 'call_a', name: 'exec_command', arguments: '{"cmd":"ls"}' },
    { type: 'function_call_output', call_id: 'call_a', result: omitted(ITEMS[2]) },
    { type: 'message', role: 'assistant', text: 'first answer' },
    { type: 'function_call', call_id: 'call_b', name: 'exec_command', arguments: '{"cmd":"pwd"}' },
    { type: 'function_call_output', call_id: 'call_b', result: omitted(ITEMS[5]) },
  ] });
  assert.deepEqual(Object.keys(body.questions), ['call_0', 'result_0', 'call_1', 'result_1']);
  assert.deepEqual(body.questions.call_0, {
    type: 'noul',
    instructions: 'History index 1 holds the tool call of one tool exchange. Is that tool call still needed to continue the task?',
  });
  assert.deepEqual(body.questions.result_1, {
    type: 'noul',
    instructions: 'History index 5 holds the tool result of one tool exchange. Is that tool result still needed to continue the task?',
  });
});

test('keeps each half from the threshold upwards, independently', async () => {
  const { fetchImpl } = recordingFetch(jsonReply(answers([[0.5, 0.5], [0.4, 0.9], [1, 0]])));
  const decisions = await createJevAsker(config(), API_KEY, { fetchImpl })({
    items: ITEMS,
    exchanges: [EXCHANGES[0], EXCHANGES[1], { callId: 'call_c', callIndex: 1, resultIndex: 2 }],
  });
  assert.deepEqual(decisions, [
    { keepCall: true, keepResult: true },
    { keepCall: false, keepResult: true },
    { keepCall: true, keepResult: false },
  ]);
});

test('rejects a missing key on invocation without touching the network', async () => {
  const { calls, fetchImpl } = okFetch();
  const asker = createJevAsker(config(), '   ', { fetchImpl });
  await assert.rejects(asker({ items: ITEMS, exchanges: EXCHANGES }), /OpenRouter API key is required/);
  assert.equal(calls.length, 0);
});

test('rejects an HTTP error without echoing the provider body or the key', async () => {
  const { fetchImpl } = recordingFetch(() => new Response(MARKER, { status: 503 }));
  await assert.rejects(createJevAsker(config(), API_KEY, { fetchImpl })({ items: ITEMS, exchanges: EXCHANGES }),
    (error) => {
      assert.match(error.message, /HTTP 503/);
      assert.equal(error.message.includes(MARKER), false);
      assert.equal(error.message.includes(API_KEY), false);
      return true;
    });
});

test('rejects an unreadable body and reports a timeout without leaking the key', async () => {
  const notJson = recordingFetch(() => new Response(MARKER, { status: 200 }));
  await assert.rejects(createJevAsker(config(), API_KEY, { fetchImpl: notJson.fetchImpl })({ items: ITEMS, exchanges: EXCHANGES }),
    /not valid JSON/);

  const timeout = recordingFetch(() => {
    throw Object.assign(new Error('fetch failed'), { name: 'TimeoutError' });
  });
  await assert.rejects(createJevAsker(config(), API_KEY, { fetchImpl: timeout.fetchImpl })({ items: ITEMS, exchanges: EXCHANGES }),
    (error) => {
      assert.match(error.message, /timed out after 120000 ms/);
      assert.equal(error.message.includes(API_KEY), false);
      return true;
    });

  const transport = recordingFetch(() => {
    throw new Error(`${MARKER} while writing the request`);
  });
  await assert.rejects(createJevAsker(config(), API_KEY, { fetchImpl: transport.fetchImpl })({ items: ITEMS, exchanges: EXCHANGES }),
    (error) => {
      assert.equal(error.message, 'decisions request failed');
      assert.equal(error.message.includes(MARKER), false);
      return true;
    });
});

test('rejects missing, non-finite and out-of-range noul answers', async () => {
  const cases = [
    [{ call_0: { noul: 0.7 } }, /no usable noul for result_0/],
    [{ call_0: { noul: 'high' }, result_0: { noul: 0.7 } }, /no usable noul for call_0/],
    [{ call_0: { noul: 1.4 }, result_0: { noul: 0.7 } }, /no usable noul for call_0/],
    [{ call_0: { noul: -0.1 }, result_0: { noul: 0.7 } }, /no usable noul for call_0/],
    [{ call_0: {}, result_0: { noul: 0.7 } }, /no usable noul for call_0/],
  ];
  for (const [decisions, expected] of cases) {
    const { fetchImpl } = recordingFetch(jsonReply({ answers: decisions }));
    await assert.rejects(createJevAsker(config(), API_KEY, { fetchImpl })({ items: ITEMS, exchanges: [EXCHANGES[0]] }),
      expected);
  }
});

test('a long tool result still fits the request because result bodies are omitted', async () => {
  const items = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'long task' }] },
    { type: 'function_call', call_id: 'call_a', name: 'exec_command', arguments: JSON.stringify({ cmd: 'cat big.txt' }) },
    { type: 'function_call_output', call_id: 'call_a', output: 'x'.repeat(320000) },
  ];
  const { calls, fetchImpl } = okFetch();
  const decisions = await createJevAsker(config(), API_KEY, { fetchImpl })({
    items,
    exchanges: [{ callId: 'call_a', callIndex: 1, resultIndex: 2 }],
  });
  assert.deepEqual(decisions, [{ keepCall: true, keepResult: true }]);
  const request = JSON.parse(calls[0].options.body);
  assert.equal(request.state.items[2].type, 'function_call_output');
  assert.equal(request.state.items[2].call_id, 'call_a');
  assert.match(request.state.items[2].result, /^\d+ chars \(omitted\)$/);
  assert.ok(Number.parseInt(request.state.items[2].result, 10) >= 320000);
  assert.ok(!calls[0].options.body.includes('xxxx'));
  assert.ok(calls[0].options.body.length < PILOT_CONFIG.jev_compaction.max_state_chars);
});

test('clips a long tool input, including a custom call, at max_call_chars', async () => {
  const input = `*** Begin Patch\n${'+line\n'.repeat(2000)}`;
  const items = [
    { type: 'custom_tool_call', call_id: 'call_a', name: 'apply_patch', input },
    { type: 'custom_tool_call_output', call_id: 'call_a', output: 'done' },
  ];
  const { calls, fetchImpl } = okFetch();
  await createJevAsker(config(), API_KEY, { fetchImpl })({
    items,
    exchanges: [{ callId: 'call_a', callIndex: 0, resultIndex: 1 }],
  });
  const [call] = JSON.parse(calls[0].options.body).state.items;
  assert.equal(call.name, 'apply_patch');
  assert.equal(call.arguments, `${input.slice(0, PILOT_CONFIG.jev_compaction.max_call_chars)} (clipped)`);
});

test('an oversized state fails while an oversized request splits instead of truncating', async () => {
  const capture = scoringFetch();
  await createJevAsker(config(), API_KEY, { fetchImpl: capture.fetchImpl })({ items: ITEMS, exchanges: EXCHANGES });
  const body = capture.calls[0].options.body;
  const stateSize = JSON.stringify(JSON.parse(body).state).length;
  assert.ok(stateSize < body.length);

  const stateTight = scoringFetch();
  await assert.rejects(createJevAsker(config({ jev_compaction: { max_state_chars: stateSize - 1 } }), API_KEY,
    { fetchImpl: stateTight.fetchImpl })({ items: ITEMS, exchanges: EXCHANGES }),
  { message: /^Jev state is \d+ characters, above jev_compaction.max_state_chars/ });
  assert.equal(stateTight.calls.length, 0);

  // One character under the two-exchange request still fits one exchange, so the plan splits.
  const requestTight = scoringFetch();
  const decisions = await createJevAsker(config({ jev_compaction: { max_state_chars: body.length - 1 } }), API_KEY,
    { fetchImpl: requestTight.fetchImpl })({ items: ITEMS, exchanges: EXCHANGES });
  assert.equal(requestTight.calls.length, 2);
  for (const call of requestTight.calls) assert.ok(call.options.body.length <= body.length - 1);
  assert.deepEqual(decisions, expectedDecisions(EXCHANGES));
});

test('falls back before sending a request that exceeds the Jev token budget', async () => {
  const stateLimited = okFetch();
  const punctuationHeavy = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '.'.repeat(30000) }] },
    { type: 'function_call', call_id: 'call_a', name: 'exec_command', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_a', output: 'done' },
  ];
  await assert.rejects(createJevAsker(config(), API_KEY,
    { fetchImpl: stateLimited.fetchImpl })({ items: punctuationHeavy,
    exchanges: [{ callId: 'call_a', callIndex: 1, resultIndex: 2 }] }),
  { message: /^Jev state is approximately \d+ tokens, above jev_compaction\.max_state_tokens/ });
  assert.equal(stateLimited.calls.length, 0);

  const requestLimited = okFetch();
  await assert.rejects(createJevAsker(config({ jev_compaction: { max_request_tokens: 1 } }), API_KEY,
    { fetchImpl: requestLimited.fetchImpl })({ items: ITEMS, exchanges: EXCHANGES }),
  { message: /^Jev request is approximately \d+ tokens, above jev_compaction\.max_request_tokens/ });
  assert.equal(requestLimited.calls.length, 0);
});

test('splits a history above max_questions into batches that repeat the same state', async () => {
  const { items, exchanges } = history(60);
  const { calls, fetchImpl } = scoringFetch();
  const decisions = await createJevAsker(config(), API_KEY, { fetchImpl })({ items, exchanges });

  // 120 real questions do not fit one max_questions=100 request, so two batches travel instead of
  // the whole history falling back to the native summary.
  assert.equal(calls.length, 2);
  const requests = calls.map(call => JSON.parse(call.options.body));
  assert.deepEqual(requests.map(request => Object.keys(request.questions).length), [100, 20]);
  assert.deepEqual(requests.map(request => Object.keys(request.questions).filter(id => id === 'call_0').length), [1, 1]);
  // The questions of every batch are numbered from its own first exchange.
  assert.deepEqual(Object.keys(requests[1].questions).slice(0, 2), ['call_0', 'result_0']);
  assert.deepEqual(Object.keys(requests[1].questions).slice(-2), ['call_9', 'result_9']);
  assert.equal(requests[1].questions.call_0.instructions,
    'History index 101 holds the tool call of one tool exchange. Is that tool call still needed to continue the task?');
  // The same bounded state travels in every batch.
  assert.deepEqual(requests[0].state, requests[1].state);
  assert.equal(requests[0].state.items.length, items.length);
  assert.deepEqual(decisions, expectedDecisions(exchanges));
});

test('caps each batch at max_questions real questions', async () => {
  const { items, exchanges } = history(5);
  const { calls, fetchImpl } = scoringFetch();
  const decisions = await createJevAsker(config({ jev_compaction: { max_questions: 4 } }), API_KEY,
    { fetchImpl })({ items, exchanges });
  assert.deepEqual(calls.map(call => Object.keys(JSON.parse(call.options.body).questions).length), [4, 4, 2]);
  assert.deepEqual(decisions, expectedDecisions(exchanges));
});

test('drives the batch size from the request token budget', async () => {
  const { items, exchanges } = history(4);
  const permissive = config({ jev_compaction: { max_state_tokens: 1000000, max_request_tokens: 1000000 } });
  const capture = scoringFetch();
  await createJevAsker(permissive, API_KEY, { fetchImpl: capture.fetchImpl })({ items, exchanges });
  assert.equal(capture.calls.length, 1);
  const split = scoringFetch();
  const decisions = await createJevAsker(config({ jev_compaction: { max_request_tokens: 700 } }), API_KEY,
    { fetchImpl: split.fetchImpl })({ items, exchanges });
  assert.ok(split.calls.length > 1);
  assert.ok(split.calls.every(call => Object.keys(JSON.parse(call.options.body).questions).length > 0));
  assert.deepEqual(decisions, expectedDecisions(exchanges));
});

test('refuses a question cap that cannot hold one exchange', async () => {
  const { items, exchanges } = history(2);
  const { calls, fetchImpl } = scoringFetch();
  await assert.rejects(createJevAsker(config({ jev_compaction: { max_questions: 1 } }), API_KEY, { fetchImpl })({
    items,
    exchanges,
  }), { message: /^Jev request asks 2 questions, above jev_compaction\.max_questions \(1\)$/ });
  assert.equal(calls.length, 0);
});

test('a batch that fails leaves no partial decision list', async () => {
  const { items, exchanges } = history(6);
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const payload = JSON.parse(options.body);
    if (calls.length === 2) return new Response(MARKER, { status: 500 });
    return new Response(JSON.stringify({ answers: Object.fromEntries(
      Object.keys(payload.questions).map(id => [id, { noul: 0.1 }])) }));
  };
  await assert.rejects(createJevAsker(config({ jev_compaction: { max_questions: 4 } }), API_KEY,
    { fetchImpl })({ items, exchanges }), (error) => {
    assert.match(error.message, /HTTP 500/);
    assert.equal(error.message.includes(MARKER), false);
    return true;
  });
  // The whole plan is built before the first call, so every batch of the plan is issued together.
  assert.equal(calls.length, 3);
});

test('splits on the byte budget and refuses a single exchange that cannot fit', async () => {
  const { items, exchanges } = history(3);
  const capture = scoringFetch();
  await createJevAsker(config(), API_KEY, { fetchImpl: capture.fetchImpl })({ items, exchanges });
  assert.equal(capture.calls.length, 1);
  const size = Buffer.byteLength(capture.calls[0].options.body);

  // One byte under the whole request still fits one exchange, so the plan splits on bytes.
  const split = scoringFetch();
  const decisions = await createJevAsker(config({ max_request_bytes: size - 1 }), API_KEY,
    { fetchImpl: split.fetchImpl })({ items, exchanges });
  assert.ok(split.calls.length > 1);
  for (const call of split.calls) assert.ok(Buffer.byteLength(call.options.body) <= size - 1);
  assert.deepEqual(decisions, expectedDecisions(exchanges));

  // A budget that cannot hold a single exchange fails instead of sending a request the gateway
  // would reject.
  const alone = scoringFetch();
  await createJevAsker(config({ jev_compaction: { max_questions: 2 } }), API_KEY,
    { fetchImpl: alone.fetchImpl })({ items, exchanges });
  const oneExchange = Buffer.byteLength(alone.calls[0].options.body);
  const tight = scoringFetch();
  await assert.rejects(createJevAsker(config({ max_request_bytes: oneExchange - 1 }), API_KEY,
    { fetchImpl: tight.fetchImpl })({ items, exchanges }),
  { message: new RegExp(`^Jev request is \\d+ bytes, above max_request_bytes \\(${oneExchange - 1}\\)$`) });
  assert.equal(tight.calls.length, 0);
});

test('bounds the response stream at max_response_bytes', async () => {
  const { fetchImpl } = recordingFetch(() => new Response(`{"padding":"${'x'.repeat(400)}"}`, { status: 200 }));
  await assert.rejects(createJevAsker(config({ max_response_bytes: 64 }), API_KEY, { fetchImpl })({
    items: ITEMS,
    exchanges: [EXCHANGES[0]],
  }), /max_response_bytes/);
});

test('makes no request when there are no candidate exchanges', async () => {
  const { calls, fetchImpl } = okFetch();
  assert.deepEqual(await createJevAsker(config(), API_KEY, { fetchImpl })({ items: ITEMS, exchanges: [] }), []);
  assert.equal(calls.length, 0);
});

test('refuses a broken exchange or configuration', async () => {
  const { calls, fetchImpl } = okFetch();
  await assert.rejects(createJevAsker(config(), API_KEY, { fetchImpl })({ items: ITEMS, exchanges: [{ callId: 'call_a' }] }),
    /integer callIndex/);
  await assert.rejects(createJevAsker(config(), API_KEY, { fetchImpl })({
    items: ITEMS,
    exchanges: [{ callId: 'call_a', callIndex: ITEMS.length, resultIndex: 2 }],
  }), /callIndex 6 is outside the 6-item history/);
  await assert.rejects(createJevAsker(config(), API_KEY, { fetchImpl })({
    items: ITEMS,
    exchanges: [{ callId: 'call_a', callIndex: -1, resultIndex: 2 }],
  }), /callIndex -1 is outside/);
  await assert.rejects(createJevAsker({ ...PILOT_CONFIG, jev_compaction: undefined }, API_KEY, { fetchImpl })({
    items: ITEMS,
    exchanges: EXCHANGES,
  }), /jev_compaction config is required/);
  await assert.rejects(createJevAsker(config({ jev_compaction: { keep_threshold: 1.5 } }), API_KEY, { fetchImpl })({
    items: ITEMS,
    exchanges: EXCHANGES,
  }), /keep_threshold/);
  assert.equal(calls.length, 0);
});
