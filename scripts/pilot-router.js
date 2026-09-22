import http from 'node:http';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { zstdDecompressSync } from 'node:zlib';
import { deepSeekCustomToolNames, deepSeekResponsesEffort, deepSeekResponsesInput } from '../vendor/codex-router/deepseek-responses.js';
import { bridgeCustomTools, flattenNamespaceTools, flattenNamespacedHistory, flattenToolChoice,
  NamespaceToolCallTransform } from '../vendor/codex-router/namespace-relay.js';

// Relay adaptation: codex-router/src/router.mjs at 63ec1f3602c28f2a28ccb7e9edaf7b4f7d191c6c.
// Copyright (c) 2026 codex-router contributors; see ../vendor/codex-router/LICENSE.
// Same native collaboration token predicate as codex-router at the vendored revision.
const encryptedToken = /^gAAAAA[A-Za-z0-9_-]+={0,2}$/;
const nativeHeaderNames = [
  'authorization', 'chatgpt-account-id', 'openai-beta', 'originator', 'session_id',
  'session-id', 'thread-id', 'x-client-request-id', 'x-codex-beta-features',
  'x-codex-installation-id', 'x-codex-parent-thread-id', 'x-codex-turn-metadata',
  'x-codex-turn-state', 'x-codex-window-id', 'x-oai-attestation',
  'x-openai-internal-codex-responses-lite', 'x-openai-subagent',
];

export function nativeHeaders(headers) {
  const result = { 'content-type': 'application/json', accept: 'text/event-stream' };
  for (const key of nativeHeaderNames) if (headers[key]) result[key] = headers[key];
  return result;
}

// Receipt telemetry is an allowlist: only these transport codes may leave the process, so an
// upstream message, header or object can never reach the receipts file through error metadata.
const safeErrorCodes = new Set([
  'ABORT_ERR', 'EAI_AGAIN', 'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH',
  'ENOTFOUND', 'EPIPE', 'ETIMEDOUT', 'ERR_NAMESPACE_RELAY_COMMITTED_STREAM', 'UND_ERR_ABORTED',
  'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_DESTROYED', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET', 'Z_BUF_ERROR', 'Z_DATA_ERROR', 'Z_STREAM_ERROR',
]);

export function safeErrorCode(error) {
  for (const value of [error?.cause?.cause?.code, error?.cause?.code, error?.code]) {
    if (typeof value === 'string' && safeErrorCodes.has(value)) return value;
  }
  for (const name of [error?.cause?.cause?.name, error?.cause?.name, error?.name]) {
    if (name === 'AbortError') return 'ABORT_ERR';
  }
  return 'unknown';
}

export function sseEvents(text) {
  return text.split(/\r?\n\r?\n/).flatMap(frame => {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart()).join('\n');
    return !data || data === '[DONE]' ? [] : [JSON.parse(data)];
  });
}

export function completedOutput(events) {
  const items = new Map();
  for (const event of events) {
    if (event.type === 'response.output_item.done') items.set(event.item.id, event.item);
    if (event.type === 'response.completed') {
      for (const item of event.response.output || []) items.set(item.id, item);
    }
  }
  return [...items.values()];
}

export function plaintextHandoffs(input) {
  if (!Array.isArray(input)) return input;
  return input.map(item => item.type !== 'agent_message' ? item : {
    ...item,
    content: item.content.map(part => part.type === 'encrypted_content' && !encryptedToken.test(part.encrypted_content)
      ? { type: 'input_text', text: part.encrypted_content } : part),
  });
}

export function prepareDeepseek(payload, input) {
  const flattened = flattenNamespaceTools(payload.tools, { maxNameLength: 64, aliasCollisions: true });
  const bridged = bridgeCustomTools(flattened.tools, input, flattened.namespaces, payload.tool_choice,
    deepSeekCustomToolNames(flattened.tools, input, payload.tool_choice), { maxNameLength: 64 });
  return {
    namespaces: flattened.namespaces,
    payload: {
      ...payload, input: flattenNamespacedHistory(deepSeekResponsesInput(bridged.input), flattened.namespaces),
      tools: bridged.tools, tool_choice: flattenToolChoice(bridged.toolChoice, flattened.namespaces),
      reasoning: { effort: deepSeekResponsesEffort(payload.reasoning?.effort) },
    },
  };
}

export async function startPilot(config, deepseekKey, capability) {
  const relayCache = new Map();
  let requestCount = 0;
  const receipt = entry => {
    if (existsSync(config.receipts) && statSync(config.receipts).size >= config.log_max_bytes) {
      renameSync(config.receipts, config.receipts + '.1');
    }
    appendFileSync(config.receipts, JSON.stringify(entry) + '\n', { mode: 0o600 });
  };
  async function boundedText(response) {
    let size = 0;
    const parts = [];
    for await (const part of response.body) {
      size += part.length;
      if (size > config.max_response_bytes) throw new Error('Response size limit exceeded');
      parts.push(Buffer.from(part));
    }
    return Buffer.concat(parts).toString('utf8');
  }
  async function upstream(url, headers, body, signal) {
    if (++requestCount > config.max_requests && config.max_requests !== null) throw new Error('Pilot request limit exceeded');
    return fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal, redirect: 'error' });
  }
  async function handoff(item, headers, signal, telemetry) {
    const token = item.content.find(part => part.type === 'encrypted_content')?.encrypted_content;
    if (!token || !encryptedToken.test(token)) return plaintextHandoffs([item])[0];
    const cacheKey = createHash('sha256').update(headers.authorization).update(token).digest('hex');
    if (relayCache.get(cacheKey)?.expires < Date.now()) relayCache.delete(cacheKey);
    if (!relayCache.has(cacheKey)) {
      // Adapted from relayEncryptedAgentPayloadOnce in codex-router/src/router.mjs.
      const result = await upstream(config.native_url, headers, {
        model: config.relay_model, stream: true, store: false,
        instructions: 'You are a transport relay. Do not execute or answer the delegated task. Call relay_external_agent_payload exactly once with the exact plaintext after the Payload: label in the supplied collaboration message. Preserve every character.',
        input: [item],
        tools: [{ type: 'function', name: 'relay_external_agent_payload', strict: true,
          parameters: { type: 'object', properties: { payload: { type: 'string' } }, required: ['payload'], additionalProperties: false } }],
        tool_choice: { type: 'function', name: 'relay_external_agent_payload' },
      }, signal);
      const body = await boundedText(result);
      receipt({ route: 'relay', model: config.relay_model, http_status: result.status, ...telemetry() });
      if (!result.ok) throw new Error(`Native relay HTTP ${result.status}`);
      const events = sseEvents(body);
      if (!events.some(event => event.type === 'response.completed')) throw new Error('Native relay did not complete');
      const calls = completedOutput(events).filter(item => item.type === 'function_call' && item.name === 'relay_external_agent_payload');
      if (calls?.length !== 1) throw new Error('Native relay did not complete with one task payload');
      const text = JSON.parse(calls[0].arguments).payload;
      if (typeof text !== 'string' || !text.trim()) throw new Error('Native relay returned no task');
      if (relayCache.size >= config.relay_cache_entries) relayCache.delete(relayCache.keys().next().value);
      relayCache.set(cacheKey, { text, expires: Date.now() + config.relay_cache_ttl_ms });
    }
    return { ...item, content: item.content.map(part => part.type === 'encrypted_content'
      ? { type: 'input_text', text: relayCache.get(cacheKey).text } : part) };
  }
  const server = http.createServer(async (request, response) => {
    const startedAt = Date.now();
    const requestId = randomUUID();
    const telemetry = () => ({ timestamp: new Date().toISOString(), request_id: requestId,
      duration_ms: Date.now() - startedAt });
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, config.request_timeout_ms);
    let clientCancelled = false;
    // Failure attribution: which leg was in flight when the request failed.
    let phase = 'request';
    let route;
    let model;
    let upstreamStatus;
    let bytesSent = 0;
    response.on('close', () => {
      if (!response.writableFinished && !controller.signal.aborted) {
        clientCancelled = true;
        controller.abort();
      }
    });
    try {
      const supplied = Buffer.from(request.headers['x-deepcodex-pilot'] || '');
      const expected = Buffer.from(capability);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        response.writeHead(403).end(); return;
      }
      if (request.method === 'GET' && request.url === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ready', pid: process.pid })); return;
      }
      const path = new URL(request.url, 'http://localhost').pathname;
      const nativePaths = ['/responses', '/responses/compact', '/responses/lite', '/alpha/search'];
      if (request.method !== 'POST' || !nativePaths.includes(path)) {
        response.writeHead(404).end(); return;
      }
      const parts = []; let size = 0;
      for await (const part of request) {
        size += part.length;
        if (size > config.max_request_bytes) throw new Error('Request size limit exceeded');
        parts.push(part);
      }
      let bytes = Buffer.concat(parts);
      const encoding = request.headers['content-encoding'];
      if (encoding === 'zstd') bytes = zstdDecompressSync(bytes, { maxOutputLength: config.max_request_bytes });
      else if (encoding) throw new Error('Unsupported request compression');
      const payload = JSON.parse(bytes.toString('utf8'));
      const isChild = payload.model === config.child_model;
      if (!isChild && payload.model && !config.native_models.includes(payload.model)) throw new Error('Model outside configured catalog');
      if (isChild && path !== '/responses') throw new Error('DeepSeek supports only the Responses endpoint');
      // Only the catalog-validated model reaches the receipts.
      model = payload.model;
      const headers = nativeHeaders(request.headers);
      if (!headers.authorization) throw new Error('Missing Codex authentication');
      let body = payload;
      let namespaces;
      if (isChild) {
        const input = [];
        for (const item of payload.input) {
          if (item.type !== 'agent_message') { input.push(item); continue; }
          phase = 'relay';
          route = 'relay';
          input.push(await handoff(item, headers, controller.signal, telemetry));
          phase = 'request';
          route = undefined;
        }
        const prepared = prepareDeepseek(payload, input);
        body = prepared.payload;
        namespaces = prepared.namespaces;
      } else body = { ...payload, input: plaintextHandoffs(payload.input) };
      const nativeUrl = config.native_url.replace(/\/responses$/, '') + path;
      phase = 'upstream';
      route = isChild ? 'deepseek' : 'native';
      const result = await upstream(isChild ? config.deepseek_url : nativeUrl,
        isChild ? { 'content-type': 'application/json', authorization: `Bearer ${deepseekKey}` } : headers,
        body, controller.signal);
      upstreamStatus = result.status;
      const entry = {
        route: isChild ? 'deepseek' : 'native', model: payload.model, http_status: result.status,
        recipients: Array.isArray(payload.input) ? payload.input.filter(item => item.type === 'agent_message').map(item => item.recipient) : [],
        task_count: Array.isArray(payload.input) ? payload.input.filter(item => item.type === 'agent_message').length : 0,
        tool_results: config.markers.map(marker => Array.isArray(payload.input) && payload.input.some(item => item.type === 'function_call_output' && JSON.stringify(item.output).includes(marker))),
      };
      const contentType = result.headers.get('content-type') || 'application/octet-stream';
      const responseHeaders = { 'content-type': contentType };
      for (const name of ['x-codex-turn-state', 'x-request-id', 'retry-after']) {
        if (result.headers.has(name)) responseHeaders[name] = result.headers.get(name);
      }
      response.writeHead(result.status, responseHeaders);
      const source = Readable.fromWeb(result.body);
      const stream = isChild && result.ok ? source.pipe(new NamespaceToolCallTransform(namespaces, contentType)) : source;
      if (stream !== source) source.on('error', error => stream.destroy(error));
      const chunks = []; let length = 0;
      for await (const chunk of stream) {
        length += chunk.length;
        if (length > config.max_response_bytes) throw new Error('Response size limit exceeded');
        chunks.push(Buffer.from(chunk));
        bytesSent = length;
        if (!response.write(chunk)) await once(response, 'drain', { signal: controller.signal });
      }
      const text = Buffer.concat(chunks).toString('utf8');
      if (result.ok && (contentType.includes('text/event-stream') || /^(?:event:|data:)/.test(text))) {
        const events = sseEvents(text);
        const completed = events.find(event => event.type === 'response.completed');
        entry.completed = !!completed;
        entry.response_model = completed?.response?.model;
        const usage = completed?.response?.usage;
        entry.usage = usage && { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens,
          cached_tokens: usage.input_tokens_details?.cached_tokens };
        const output = completedOutput(events);
        entry.calls = output.filter(item => item.type === 'function_call' || item.type === 'custom_tool_call').map(item => ({ name: item.name, namespace: item.namespace }));
        const visible = output.filter(item => item.type === 'message').flatMap(item => item.content || []).filter(part => part.type === 'output_text').map(part => part.text).join('\n');
        entry.answers = config.markers.map(marker => visible.includes(marker));
      }
      entry.bytes_sent = bytesSent;
      receipt({ ...entry, ...telemetry() });
      response.end();
    } catch (error) {
      const outcome = clientCancelled ? 'client_disconnect' : timedOut ? 'timeout'
        : phase === 'request' ? 'local_error' : 'upstream_error';
      if (clientCancelled) {
        receipt({ route: 'cancelled', upstream_route: route, model, phase, reason: 'codex_disconnected', outcome,
          bytes_sent: bytesSent, ...telemetry() });
        return;
      }
      // A JSON syntax error can quote the parsed text, so the message is generic by phase.
      let message = error instanceof SyntaxError
        ? (phase === 'request' ? 'Invalid JSON request body' : 'Invalid JSON upstream response')
        : String(error.message);
      for (const secret of [deepseekKey, capability]) {
        if (typeof secret === 'string' && secret.length) message = message.replaceAll(secret, '[REDACTED]');
      }
      const failure = { route: 'error', phase, outcome, message,
        error_code: safeErrorCode(error), bytes_sent: bytesSent };
      if (route) failure.upstream_route = route;
      if (model) failure.model = model;
      if (upstreamStatus !== undefined) failure.http_status = upstreamStatus;
      receipt({ ...failure, ...telemetry() });
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'DeepCodex request failed; inspect local receipts.' } }));
      else response.destroy();
    } finally { clearTimeout(timer); }
  });
  server.listen(config.port, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const { config, capability } = JSON.parse(input);
  const server = await startPilot(config, process.env.DEEPSEEK_API_KEY, capability);
  process.stdout.write(JSON.stringify({ pid: process.pid, port: server.address().port }) + '\n');
}
