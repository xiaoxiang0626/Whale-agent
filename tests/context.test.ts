import assert from 'node:assert/strict';
import test from 'node:test';
import { selectContext } from '../src/context.ts';
import { Conversation } from '../src/conversation.ts';
import { AppError } from '../src/errors.ts';
import type { ModelMessage, ModelRequest } from '../src/providers/types.ts';

test('预算按完整轮次省略旧消息，保留当前调用与结果，不修改原历史', () => {
  const messages: ModelMessage[] = [
    { role: 'system', content: 'workspace rules' }, { role: 'user', content: 'old' + 'x'.repeat(4000) },
    { role: 'assistant', content: '', toolCalls: [{ id: 'old', name: 'read_file', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'old', content: 'old result' }, { role: 'assistant', content: 'old final' },
    { role: 'user', content: 'current' }, { role: 'assistant', content: '', reasoningContent: 'reasoning', toolCalls: [{ id: 'new', name: 'read_file', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'new', content: 'current result' },
  ];
  const result = selectContext({ model: 'test', messages }, 5, 4000);
  assert.equal(result.dropped, 4); assert.equal(messages.length, 8);
  assert.match(result.request.messages[1]?.content ?? '', /上下文裁剪/);
  assert.deepEqual(result.request.messages.slice(2), messages.slice(5));
  assert.ok(JSON.stringify(result.request).length <= 4000);
  assert.throws(() => selectContext({ model: 'test', messages: [{ role: 'user', content: 'x'.repeat(5000) }] }, 0, 4000),
    (error: Error) => error instanceof AppError && error.code === 'CONTEXT_LIMIT');
});

test('自动裁剪只影响实际模型请求，完整成功历史仍可保存', async () => {
  const requests: ModelRequest[] = [];
  const conversation = new Conversation({ id: 'test', async complete(request) { requests.push(request); return { text: 'y'.repeat(1400) }; } }, 'test', { maxContextChars: 4000 });
  for (let index = 0; index < 4; index++) { await conversation.send(`turn${index} ` + 'x'.repeat(1000), new AbortController().signal); }
  assert.equal(conversation.turnCount, 4); assert.equal(conversation.messages.length, 8);
  assert.ok(requests.every(request => JSON.stringify(request).length <= 4000));
  assert.match(requests[3]?.messages[0]?.content ?? '', /上下文裁剪/);
  assert.ok(conversation.messages[0]?.content.includes('turn0'));
});
