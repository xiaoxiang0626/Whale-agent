import assert from 'node:assert/strict';
import test from 'node:test';
import { Conversation } from '../src/conversation.ts';
import type { ModelProvider, ModelRequest } from '../src/providers/types.ts';
import type { AgentEvent, ToolSet } from '../src/tools/types.ts';

function tools(): ToolSet {
  return { workspace: '/workspace', context: 'read-only', definitions: [], async execute(call) {
    return { ok: true, content: `result:${call.name}`, summary: 'read completed' };
  } };
}

test('模型工具调用、结果和推理字段进入下一次请求；下一轮仍能引用完整成功历史', async () => {
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = { id: 'tools', async complete(request) {
    requests.push(structuredClone(request));
    if (requests.length === 1) { return { text: '', reasoningContent: 'provider-private-reasoning',
      toolCalls: [{ id: 'first', name: 'read_file', arguments: '{"path":"src/a.ts"}' }, { id: 'second', name: 'list_files', arguments: '{"path":"src"}' }] }; }
    return { text: 'finished', reasoningContent: 'retained-for-next-request' };
  } };
  const conversation = new Conversation(provider, 'test', { tools: tools() });
  const events: AgentEvent[] = [];
  const stop = conversation.subscribe(event => events.push(event));
  await conversation.send('inspect', new AbortController().signal);
  assert.deepEqual(requests[1]?.messages.map(message => message.role), ['system', 'user', 'assistant', 'tool', 'tool']);
  assert.deepEqual(requests[1]?.messages[2], { role: 'assistant', content: '', reasoningContent: 'provider-private-reasoning',
    toolCalls: [{ id: 'first', name: 'read_file', arguments: '{"path":"src/a.ts"}' }, { id: 'second', name: 'list_files', arguments: '{"path":"src"}' }] });
  assert.deepEqual(requests[1]?.messages[3], { role: 'tool', toolCallId: 'first', content: 'result:read_file' });
  assert.equal(conversation.turnCount, 1);
  assert.equal(conversation.messages.length, 5);
  const snapshot = conversation.messages;
  await conversation.send('continue', new AbortController().signal);
  assert.deepEqual(requests[2]?.messages.at(-2), { role: 'assistant', content: 'finished', reasoningContent: 'retained-for-next-request' });
  assert.equal(snapshot.length, 5);
  assert.equal(conversation.turnCount, 2);
  assert.equal(events.filter(event => event.type === 'tool').length, 2);
  assert.ok(events.every(event => !('content' in event)));
  stop(); const count = events.length;
  conversation.clear(); await conversation.send('new', new AbortController().signal);
  assert.equal(events.length, count);
  assert.equal(conversation.turnCount, 1);
});

test('循环上限、重复 ID 和未授权工具会停止调用，失败不提交本轮历史', async () => {
  let executions = 0;
  const toolSet = { ...tools(), async execute() { executions++; return { ok: true, content: 'ok', summary: 'ok' }; } };
  const provider: ModelProvider = { id: 'repeat', async complete() {
    return { text: '', toolCalls: [{ id: 'repeated', name: 'read_file', arguments: '{}' }] };
  } };
  const limited = new Conversation(provider, 'test', { tools: toolSet, maxSteps: 1 });
  await assert.rejects(limited.send('task', new AbortController().signal), /次数上限/);
  assert.equal(executions, 0);
  const repeated = new Conversation(provider, 'test', { tools: toolSet });
  await assert.rejects(repeated.send('task', new AbortController().signal), /重复使用/);
  assert.equal(executions, 1);
  assert.equal(repeated.turnCount, 0); assert.deepEqual(repeated.messages, []);
  const unavailable = new Conversation(provider, 'test');
  await assert.rejects(unavailable.send('task', new AbortController().signal), /未启用工具/);
});

test('取消阻止后续工具和最终响应提交；预期工具失败可回传给模型恢复', async () => {
  const controller = new AbortController();
  let calls = 0;
  const provider: ModelProvider = { id: 'cancel', async complete() {
    calls++;
    return { text: '', toolCalls: [{ id: 'a', name: 'read_file', arguments: '{}' }, { id: 'b', name: 'read_file', arguments: '{}' }] };
  } };
  let executed = 0;
  const conversation = new Conversation(provider, 'test', { tools: { ...tools(), async execute() {
    executed++; controller.abort(); return { ok: true, content: 'late', summary: 'late' };
  } } });
  await assert.rejects(conversation.send('task', controller.signal), { name: 'AbortError' });
  assert.equal(calls, 1); assert.equal(executed, 1); assert.deepEqual(conversation.messages, []);
  const recovering: ModelProvider = { id: 'recover', async complete(request) {
    return request.messages.at(-1)?.role === 'tool' ? { text: 'file not accessible' }
      : { text: '', toolCalls: [{ id: 'error', name: 'read_file', arguments: '{}' }] };
  } };
  const recovered = new Conversation(recovering, 'test', { tools: { ...tools(), async execute() {
    return { ok: false, content: '{"ok":false,"error":{"code":"PATH_DENIED"}}', summary: 'PATH_DENIED' };
  } } });
  assert.equal((await recovered.send('task', new AbortController().signal)).text, 'file not accessible');
  assert.equal(recovered.turnCount, 1);
});
