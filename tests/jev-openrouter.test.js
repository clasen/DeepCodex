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
  assert.deepEqual(body.state, { items: ITEMS });
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

test('rejects a state above max_state_chars instead of truncating it', async () => {
  const size = JSON.stringify({ items: ITEMS }).length;
  const tight = recordingFetch(jsonReply(answers([[0.7, 0.9]])));
  await assert.rejects(createJevAsker(config({ jev_compaction: { max_state_chars: size - 1 } }), API_KEY,
    { fetchImpl: tight.fetchImpl })({ items: ITEMS, exchanges: [EXCHANGES[0]] }), /max_state_chars/);
  assert.equal(tight.calls.length, 0);

  const exact = recordingFetch(jsonReply(answers([[0.7, 0.9]])));
  await createJevAsker(config({ jev_compaction: { max_state_chars: size } }), API_KEY,
    { fetchImpl: exact.fetchImpl })({ items: ITEMS, exchanges: [EXCHANGES[0]] });
  assert.equal(exact.calls.length, 1);
});

test('bounds the serialized request at max_request_bytes', async () => {
  const capture = okFetch();
  await createJevAsker(config(), API_KEY, { fetchImpl: capture.fetchImpl })({ items: ITEMS, exchanges: EXCHANGES });
  const size = Buffer.byteLength(capture.calls[0].options.body);

  const exact = recordingFetch(jsonReply(answers([[0.7, 0.9], [0.2, 0.1]])));
  await createJevAsker(config({ max_request_bytes: size }), API_KEY, { fetchImpl: exact.fetchImpl })({
    items: ITEMS,
    exchanges: EXCHANGES,
  });
  assert.equal(exact.calls.length, 1);

  const tight = recordingFetch(jsonReply(answers([[0.7, 0.9], [0.2, 0.1]])));
  await assert.rejects(createJevAsker(config({ max_request_bytes: size - 1 }), API_KEY, { fetchImpl: tight.fetchImpl })({
    items: ITEMS,
    exchanges: EXCHANGES,
  }), /max_request_bytes/);
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
