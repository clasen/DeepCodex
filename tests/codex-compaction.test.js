import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { startPilot } from '../scripts/pilot-router.js';
import { loadConfig, runWorker, workerEnvironment } from '../scripts/worker.js';

// Opt-in: the installed Codex client compacts through the router, which answers with a local
// reference only when Jev prunes the history and relays the compaction natively otherwise.
// Compaction runs on every turn here because the fixture sets a one-token auto-compact limit:
// that exercises the transport repeatedly instead of waiting for a real context to fill.
test('real Codex continues after a local Jev compaction without a native summary',
  { skip: !process.env.DEEPCODEX_TEST_CODEX }, async t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deepcodex-compaction-codex-')));
    const workspace = path.join(root, 'workspace');
    const store = `deepcodex-compaction-test-${randomUUID()}`;
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, 'keep.txt'), 'KEEP-MARKER\n');
    fs.writeFileSync(path.join(workspace, 'drop.txt'), 'DROP-MARKER\n');
    t.after(() => {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(path.join(os.tmpdir(), store), { recursive: true, force: true });
    });
    const requests = [];
    const issued = new Set();
    const call = (name, id) => {
      issued.add(name);
      return { id: `fc_${name}`, type: 'function_call', call_id: `call_${name}`, name: 'exec_command',
        arguments: JSON.stringify({ cmd: `cat ${name}.txt`, workdir: workspace, max_output_tokens: 50 }) };
    };
    const upstream = http.createServer(async (request, response) => {
      const parts = [];
      for await (const part of request) parts.push(part);
      const text = Buffer.concat(parts).toString('utf8');
      const payload = JSON.parse(text);
      requests.push({ text, payload });
      // A compaction the router relays natively expects a summary in place of a tool call; the
      // local path never sends its checkpoint instruction here.
      const item = text.includes('CONTEXT CHECKPOINT COMPACTION')
        ? { id: 'msg_summary', type: 'message', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: 'fixture native summary', annotations: [] }] }
        : !issued.has('keep') ? call('keep')
          : !issued.has('drop') ? call('drop')
            : { id: 'msg_done', type: 'message', role: 'assistant', status: 'completed',
              content: [{ type: 'output_text', text: 'fixture compacted completion', annotations: [] }] };
      const result = { id: `resp_${requests.length}`, object: 'response', created_at: 0, model: payload.model,
        status: 'completed', output: [item], usage: { input_tokens: 40, output_tokens: 5, total_tokens: 45 } };
      const events = [
        { type: 'response.created', response: { ...result, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: result },
      ];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    t.after(() => { upstream.closeAllConnections(); return new Promise(resolve => upstream.close(resolve)); });
    const receipts = path.join(root, 'receipts.jsonl');
    // Simulated Jev decisions: the exchange that read keep.txt survives, the other is dropped.
    const jevAsker = ({ items, exchanges }) => exchanges.map(entry =>
      ({ keepCall: true, keepResult: JSON.stringify(items[entry.resultIndex]).includes('KEEP-MARKER') }));
    const router = await startPilot({
      ...JSON.parse(fs.readFileSync(new URL('../config/pilot.json', import.meta.url), 'utf8')),
      native_url: `http://127.0.0.1:${upstream.address().port}/responses`,
      deepseek_url: `http://127.0.0.1:${upstream.address().port}/responses`,
      native_models: ['gpt-6-astra'], child_model: 'deepseek-flash', max_requests: null,
      request_timeout_ms: 30000, receipts, markers: [],
      jev_compaction: { enabled: true, store, retain_recent: 0 },
    }, 'fixture-provider-key', 'fixture-capability', { jevAsker });
    t.after(() => { router.closeAllConnections(); return new Promise(resolve => router.close(resolve)); });
    const config = loadConfig();
    config.codex.model = 'gpt-6-astra';
    config.codex.model_context_window = 2000;
    config.codex.model_auto_compact_token_limit = 1;
    const provider = config.codex.model_providers[config.codex.model_provider];
    provider.base_url = `http://127.0.0.1:${router.address().port}`;
    provider.http_headers = { 'x-deepcodex-pilot': 'fixture-capability' };
    config.codex.features.enable_request_compression = false;
    config.limits.timeout_seconds = 60;
    const env = workerEnvironment({ ...process.env, DEEPSEEK_API_KEY: 'local-test-key' });
    const result = await runWorker(process.env.DEEPCODEX_TEST_CODEX, config, workspace,
      'Read keep.txt and drop.txt with the shell tool, then report completion.', false, env);
    const entries = fs.existsSync(receipts)
      ? fs.readFileSync(receipts, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
      : [];
    assert.equal(result.status, 'completed',
      JSON.stringify({ result, receipt_routes: entries.map(entry => entry.route), upstream: requests.length }));
    assert.equal(result.result.trim(), 'fixture compacted completion');
    // Only a compaction that prunes the history is answered locally; one that would remove nothing
    // continues as the native summary, and its receipt carries the fallback reason.
    assert.ok(entries.filter(entry => entry.route === 'compaction').length >= 1, JSON.stringify(entries));
    // A local reference never reaches the provider, and the checkpoint instruction reaches it only
    // once per native fallback.
    assert.equal(requests.filter(entry => entry.text.includes('CONTEXT CHECKPOINT COMPACTION')).length,
      entries.filter(entry => entry.compaction_fallback).length);
    assert.equal(requests.filter(entry => entry.text.includes('deepcodex-jev-v1:')).length, 0);
    // Every request that still carries the exchange Jev kept carries its call and result exactly
    // once each, and never the reference the client is holding.
    for (const entry of requests.filter(entry => entry.text.includes('call_keep'))) {
      const called = entry.payload.input.filter(item => item.type === 'function_call' && item.call_id === 'call_keep');
      const answered = entry.payload.input.filter(item => item.type === 'function_call_output' && item.call_id === 'call_keep');
      assert.deepEqual([called.length, answered.length], [1, 1]);
    }
    // The exchange Jev dropped is gone from the history the provider receives.
    const last = requests.at(-1).payload.input;
    assert.equal(last.filter(item => item.call_id === 'call_drop').length, 0);
  });
