import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { completedOutput, nativeHeaders, plaintextHandoffs, prepareDeepseek, sseEvents } from '../scripts/pilot-router.js';
import { NamespaceToolCallTransform } from '../vendor/codex-router/namespace-relay.js';

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
