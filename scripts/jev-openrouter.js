// Jev decisions over the OpenRouter alpha decisions route.
//
// Each candidate tool exchange becomes two `noul` questions, one for its call and one for its
// result, each naming the history index it refers to. An answer is a probability-like number, so
// each half is kept from jev_compaction.keep_threshold upwards. Failures stay failures: a missing
// key, an HTTP error, a malformed answer or an oversized state, request or response all stop the
// compaction instead of guessing, and no response body or credential reaches an error message.

const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
const JSON_CONTENT_TYPE = 'application/json';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function positiveInteger(value, what) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${what} must be a positive integer`);
  }
  return value;
}

function readSettings(config) {
  const jev = config?.jev_compaction;
  if (!isPlainObject(jev)) throw new Error('jev_compaction config is required for Jev compaction');
  if (typeof jev.model !== 'string' || jev.model.trim() === '') {
    throw new Error('jev_compaction.model must be a non-empty string');
  }
  if (!isFiniteNumber(jev.keep_threshold) || jev.keep_threshold < 0 || jev.keep_threshold > 1) {
    throw new Error('jev_compaction.keep_threshold must be a number in [0, 1]');
  }
  return {
    model: jev.model,
    keepThreshold: jev.keep_threshold,
    maxStateChars: positiveInteger(jev.max_state_chars, 'jev_compaction.max_state_chars'),
    timeoutMs: positiveInteger(config.request_timeout_ms, 'request_timeout_ms'),
    maxRequestBytes: positiveInteger(config.max_request_bytes, 'max_request_bytes'),
    maxResponseBytes: positiveInteger(config.max_response_bytes, 'max_response_bytes'),
  };
}

function callQuestionId(index) {
  return `call_${index}`;
}

function resultQuestionId(index) {
  return `result_${index}`;
}

// The upstream question shape is exactly {type, instructions}: the true/false reading lives in
// the words, not in a criteria object.
function noulQuestion({ index, role }) {
  return {
    type: 'noul',
    instructions: `History index ${index} holds the ${role} of one tool exchange. `
      + `Is that ${role} still needed to continue the task?`,
  };
}

function buildRequest(settings, { items, exchanges }) {
  if (!Array.isArray(items)) throw new Error('Jev compaction needs the history items array');
  if (!Array.isArray(exchanges)) throw new Error('Jev compaction needs the candidate exchanges array');
  const questions = {};
  exchanges.forEach((exchange, index) => {
    const callIndex = exchange?.callIndex;
    const resultIndex = exchange?.resultIndex;
    for (const [name, value] of [['callIndex', callIndex], ['resultIndex', resultIndex]]) {
      if (!Number.isInteger(value)) throw new Error(`Jev exchange ${index} has no integer ${name}`);
      if (value < 0 || value >= items.length) {
        throw new Error(`Jev exchange ${index} ${name} ${value} is outside the ${items.length}-item history`);
      }
    }
    questions[callQuestionId(index)] = noulQuestion({ index: callIndex, role: 'tool call' });
    questions[resultQuestionId(index)] = noulQuestion({ index: resultIndex, role: 'tool result' });
  });
  const state = { items };
  const serializedState = JSON.stringify(state);
  if (serializedState.length > settings.maxStateChars) {
    throw new Error(`Jev state is ${serializedState.length} characters, above jev_compaction.max_state_chars (${settings.maxStateChars})`);
  }
  const body = { model: settings.model, state, questions };
  const size = Buffer.byteLength(JSON.stringify(body));
  if (size > settings.maxRequestBytes) {
    throw new Error(`Jev request is ${size} bytes, above max_request_bytes (${settings.maxRequestBytes})`);
  }
  return body;
}

async function readBounded(response, maxBytes) {
  const body = response.body;
  if (!body || typeof body[Symbol.asyncIterator] !== 'function') {
    throw new Error('decisions response has no readable body');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > maxBytes) throw new Error(`decisions response is above max_response_bytes (${maxBytes})`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function postDecisions({ fetchImpl, apiKey, body, settings }) {
  let response;
  try {
    response = await fetchImpl(DECISIONS_URL, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': JSON_CONTENT_TYPE,
        accept: JSON_CONTENT_TYPE,
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(settings.timeoutMs),
    });
  } catch (error) {
    // Transport errors can echo the request, so only the timeout detail is reported.
    throw new Error(error?.name === 'TimeoutError'
      ? `decisions request timed out after ${settings.timeoutMs} ms`
      : 'decisions request failed');
  }
  if (!isPlainObject(response) || typeof response.ok !== 'boolean') {
    throw new Error('decisions request returned no HTTP response');
  }
  if (!response.ok) {
    // The provider body can echo the request, so the status is the whole report.
    throw new Error(`decisions request failed with HTTP ${response.status}`);
  }
  return readBounded(response, settings.maxResponseBytes);
}

function parseAnswers(text, exchanges) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('decisions response is not valid JSON');
  }
  if (!isPlainObject(parsed) || Array.isArray(parsed)) {
    throw new Error('decisions response is not a JSON object');
  }
  if (parsed.error !== undefined) throw new Error('decisions response carries an error');
  const answers = parsed.answers;
  if (!isPlainObject(answers)) throw new Error('decisions response has no answers object');
  const noulOf = (qid) => {
    const answer = answers[qid];
    const value = isPlainObject(answer) ? answer.noul : undefined;
    if (!isFiniteNumber(value) || value < 0 || value > 1) {
      throw new Error(`decisions response has no usable noul for ${qid}`);
    }
    return value;
  };
  return exchanges.map((_, index) => ({
    keepCall: noulOf(callQuestionId(index)),
    keepResult: noulOf(resultQuestionId(index)),
  }));
}

export function createJevAsker(config, apiKey, { fetchImpl = fetch } = {}) {
  return async function askJev({ items, exchanges } = {}) {
    if (typeof apiKey !== 'string' || apiKey.trim() === '') {
      throw new Error('an OpenRouter API key is required for Jev compaction');
    }
    const settings = readSettings(config);
    if (!Array.isArray(exchanges)) throw new Error('Jev compaction needs the candidate exchanges array');
    if (exchanges.length === 0) return [];
    const body = buildRequest(settings, { items, exchanges });
    const text = await postDecisions({ fetchImpl, apiKey, body, settings });
    return parseAnswers(text, exchanges).map(({ keepCall, keepResult }) => ({
      keepCall: keepCall >= settings.keepThreshold,
      keepResult: keepResult >= settings.keepThreshold,
    }));
  };
}
