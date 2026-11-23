import assert from 'node:assert/strict';
import test from 'node:test';
import { Conversation } from '../src/conversation.ts';
import { AppError } from '../src/errors.ts';
import type { ModelProvider, ModelRequest, ModelResponse } from '../src/providers/types.ts';

test('下一轮包含成功问答，历史快照不随后续请求变化', async () => {
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = {
    id: 'history',
    async complete(request) { requests.push(request); return { text: `回复${requests.length}` }; },
  };
  const conversation = new Conversation(provider, 'test');
  const signal = new AbortController().signal;
  await conversation.send(' 第一轮 ', signal);
  const firstSnapshot = conversation.messages;
  await conversation.send('第二轮', signal);
  assert.deepEqual(requests[1]?.messages, [
    { role: 'user', content: '第一轮' }, { role: 'assistant', content: '回复1' },
    { role: 'user', content: '第二轮' },
  ]);
  assert.equal(firstSnapshot.length, 2);
  assert.equal(conversation.messages.length, 4);
  conversation.clear();
  assert.deepEqual(conversation.messages, []);
  await conversation.send('重新开始', signal);
  assert.deepEqual(requests[2]?.messages, [{ role: 'user', content: '重新开始' }]);
});

test('失败和取消保留原历史，并允许继续发送', async () => {
  let calls = 0;
  const controller = new AbortController();
  const provider: ModelProvider = {
    id: 'failure',
    async complete() {
      calls++;
      if (calls === 2) { throw new Error('private provider failure'); }
      if (calls === 3) { controller.abort(); }
      return { text: '成功' };
    },
  };
  const conversation = new Conversation(provider, 'test');
  const signal = new AbortController().signal;
  await conversation.send('保留的输入', signal);
  const saved = conversation.messages;
  await assert.rejects(conversation.send('失败的输入', signal));
  assert.deepEqual(conversation.messages, saved);
  await assert.rejects(conversation.send('取消的输入', controller.signal), { name: 'AbortError' });
  assert.deepEqual(conversation.messages, saved);
  await conversation.send('继续', signal);
  assert.equal(conversation.messages.length, 4);
});

test('进行中的会话拒绝并发输入和清空，结束后解除占用', async () => {
  let release!: (response: ModelResponse) => void;
  const provider: ModelProvider = { id: 'pending', complete: () => new Promise(resolve => { release = resolve; }) };
  const conversation = new Conversation(provider, 'test');
  const signal = new AbortController().signal;
  const pending = conversation.send('第一轮', signal);
  await assert.rejects(conversation.send('并发输入', signal),
    (error: Error) => error instanceof AppError && error.code === 'CONVERSATION_BUSY');
  assert.throws(() => conversation.clear(),
    (error: Error) => error instanceof AppError && error.code === 'CONVERSATION_BUSY');
  release({ text: '完成' });
  await pending;
  conversation.clear();
  assert.deepEqual(conversation.messages, []);
});
