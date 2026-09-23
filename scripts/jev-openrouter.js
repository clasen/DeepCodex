// Jev decisions over the OpenRouter alpha decisions route.
//
// Each candidate tool exchange becomes two `noul` questions, one for its call and one for its
// result, each naming the history index it refers to. A long conversation is split into batches:
// every batch repeats the same bounded view of the history and carries only as many questions as
// jev_compaction.max_questions and the request budget allow, and the answers are concatenated back
// in exchange order. The bounded view replaces a result body with its size and clips an oversized
// call argument, so a long session still reaches the decisions route. An answer is a
// probability-like number, so each half is kept from jev_compaction.keep_threshold upwards.
// Failures stay failures: a missing key, an HTTP error, a malformed answer, a state that does not
// fit or a batch that fails all stop the compaction instead of guessing, and no response body or
// credential reaches an error message.

import { isToolCall, isToolResult } from './compaction.js';

const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
const JSON_CONTENT_TYPE = 'application/json';
const TOKEN_PIECES = /[A-Za-z]+|\d+|[^\sA-Za-z\d]/g;

// This estimate follows fast-jev-compaction's JSON-aware budget for Jev requests. It is exported
// so the batch planner's token budget can be checked without a live gateway.
function estimatedTokens(text) {
  let tokens = 0;
  for (const [piece] of text.matchAll(TOKEN_PIECES)) {
    const first = piece.charCodeAt(0);
    if (first >= 48 && first <= 57) tokens += piece.length / 2;
    else if ((first >= 65 && first <= 90) || (first >= 97 && first <= 122)) {
      tokens += 1 + Math.floor((piece.length - 1) / 6);
    } else tokens += 0.9;
  }
  return Math.ceil(tokens);
}

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
    maxCallChars: positiveInteger(jev.max_call_chars, 'jev_compaction.max_call_chars'),
    maxQuestions: positiveInteger(jev.max_questions, 'jev_compaction.max_questions'),
    maxStateChars: positiveInteger(jev.max_state_chars, 'jev_compaction.max_state_chars'),
    maxStateTokens: positiveInteger(jev.max_state_tokens, 'jev_compaction.max_state_tokens'),
    maxRequestTokens: positiveInteger(jev.max_request_tokens, 'jev_compaction.max_request_tokens'),
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

function textOf(value) {
  return typeof value === 'string' ? value : JSON.stringify(value ?? '');
}

// Messages carry their text, and reasoning keeps its size, so the view stays readable to the asker
// without shipping a whole transcript.
function itemText(item) {
  const parts = [item?.content, item?.summary].find(Array.isArray) ?? [];
  return parts.map(part => typeof part?.text === 'string' ? part.text : '').filter(Boolean).join('\n');
}

// The state is the history index for index, because the questions name those indices: a result body
// becomes its size and a call argument is clipped at jev_compaction.max_call_chars. The history that
// is stored and replayed to the provider is never modified by this view.
function decisionState(items, { maxCallChars }) {
  return items.map(item => {
    const type = typeof item?.type === 'string' ? item.type : 'unknown';
    if (type === 'message') {
      return { type, role: typeof item.role === 'string' ? item.role : 'unknown', text: itemText(item) };
    }
    if (isToolResult(item)) {
      // The whole item is measured so a result shape without a known body field still reports its
      // real size instead of nothing.
      return { type, call_id: item.call_id, result: `${JSON.stringify(item).length} chars (omitted)` };
    }
    if (isToolCall(item)) {
      const args = textOf(item.arguments ?? item.input ?? '');
      return { type, call_id: item.call_id, name: typeof item.name === 'string' ? item.name : 'unknown',
        arguments: args.length > maxCallChars ? `${args.slice(0, maxCallChars)} (clipped)` : args };
    }
    const text = itemText(item);
    return text.length > 0 ? { type, text_chars: text.length } : { type };
  });
}

// Every exchange is checked against the history it indexes once, before any batch is planned.
function validateExchanges(items, exchanges) {
  exchanges.forEach((exchange, index) => {
    for (const [name, value] of [['callIndex', exchange?.callIndex], ['resultIndex', exchange?.resultIndex]]) {
      if (!Number.isInteger(value)) throw new Error(`Jev exchange ${index} has no integer ${name}`);
      if (value < 0 || value >= items.length) {
        throw new Error(`Jev exchange ${index} ${name} ${value} is outside the ${items.length}-item history`);
      }
    }
  });
}

// The questions of one batch are numbered from the batch's own first exchange, so every batch is
// independent and the answers are concatenated back in exchange order.
function batchQuestions(exchanges) {
  const questions = {};
  exchanges.forEach((exchange, index) => {
    questions[callQuestionId(index)] = noulQuestion({ index: exchange.callIndex, role: 'tool call' });
    questions[resultQuestionId(index)] = noulQuestion({ index: exchange.resultIndex, role: 'tool result' });
  });
  return questions;
}

// The request body is assembled from the state's own JSON, so the planner can measure a candidate
// batch without re-escaping a long state for every exchange it tries.
function serializeBody(settings, stateJson, exchanges) {
  return `{"model":${JSON.stringify(settings.model)},"state":${stateJson},"questions":${JSON.stringify(batchQuestions(exchanges))}}`;
}

// Every batch repeats the same state, so the state is measured once and the batches share what is
// left of the request budget. A batch always holds at least one exchange: an exchange that does not
// fit next to the state is a state that cannot be asked about, and the caller falls back instead of
// truncating the history.
function planBatches(settings, stateJson, exchanges) {
  const fits = payload => payload.length <= settings.maxStateChars
    && estimatedTokens(payload) <= settings.maxRequestTokens
    && Buffer.byteLength(payload) <= settings.maxRequestBytes;
  const batches = [];
  let current = [];
  for (const exchange of exchanges) {
    const candidate = [...current, exchange];
    if (candidate.length * 2 <= settings.maxQuestions && fits(serializeBody(settings, stateJson, candidate))) {
      current = candidate;
      continue;
    }
    if (current.length > 0) {
      batches.push(current);
      current = [];
    }
    const payload = serializeBody(settings, stateJson, [exchange]);
    if (settings.maxQuestions < 2) {
      throw new Error(`Jev request asks 2 questions, above jev_compaction.max_questions (${settings.maxQuestions})`);
    }
    if (payload.length > settings.maxStateChars) {
      throw new Error(`Jev request is ${payload.length} characters, above jev_compaction.max_state_chars (${settings.maxStateChars})`);
    }
    const tokens = estimatedTokens(payload);
    if (tokens > settings.maxRequestTokens) {
      throw new Error(`Jev request is approximately ${tokens} tokens, above jev_compaction.max_request_tokens (${settings.maxRequestTokens})`);
    }
    const bytes = Buffer.byteLength(payload);
    if (bytes > settings.maxRequestBytes) {
      throw new Error(`Jev request is ${bytes} bytes, above max_request_bytes (${settings.maxRequestBytes})`);
    }
    current = [exchange];
  }
  if (current.length > 0) batches.push(current);
  return batches;
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

async function postDecisions({ fetchImpl, apiKey, payload, settings }) {
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
      body: payload,
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
    if (!Array.isArray(items)) throw new Error('Jev compaction needs the history items array');
    validateExchanges(items, exchanges);
    // The state is the same bounded view in every batch, so it is measured once against the state
    // caps before anything is planned.
    const stateJson = JSON.stringify({ items: decisionState(items, settings) });
    if (stateJson.length > settings.maxStateChars) {
      throw new Error(`Jev state is ${stateJson.length} characters, above jev_compaction.max_state_chars (${settings.maxStateChars})`);
    }
    const stateTokens = estimatedTokens(stateJson);
    if (stateTokens > settings.maxStateTokens) {
      throw new Error(`Jev state is approximately ${stateTokens} tokens, above jev_compaction.max_state_tokens (${settings.maxStateTokens})`);
    }
    const planned = planBatches(settings, stateJson, exchanges)
      .map(batch => ({ batch, payload: serializeBody(settings, stateJson, batch) }));
    // All batches travel together so the compaction latency does not grow with the batch count.
    // Each batch is validated on arrival and the answers are combined only when every batch
    // succeeded, so a partial answer never reaches the caller as a complete decision list.
    const answers = await Promise.all(planned.map(async ({ batch, payload }) => {
      const text = await postDecisions({ fetchImpl, apiKey, payload, settings });
      return parseAnswers(text, batch);
    }));
    return answers.flat().map(({ keepCall, keepResult }) => ({
      keepCall: keepCall >= settings.keepThreshold,
      keepResult: keepResult >= settings.keepThreshold,
    }));
  };
}
