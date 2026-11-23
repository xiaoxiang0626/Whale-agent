import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError } from '../src/errors.ts';
import { createMockProvider } from '../src/providers/mock.ts';
import type { ModelProvider, ModelRequest } from '../src/providers/types.ts';
import { runTask } from '../src/task.ts';

test('任务逻辑接受自定义适配器，并传递消息、模型和取消信号', async () => {
  const requests: ModelRequest[] = [];
  const signal = new AbortController().signal;
  const customProvider: ModelProvider = {
    id: 'custom',
    async complete(request, receivedSignal) {
      requests.push(request);
      assert.equal(receivedSignal, signal);
      return { text: '来自自定义适配器' };
    },
  };
  assert.deepEqual(await runTask(customProvider, { model: 'my-model', prompt: '  检查代码  ' }, signal), {
    text: '来自自定义适配器',
  });
  assert.deepEqual(requests, [{ model: 'my-model', messages: [{ role: 'user', content: '检查代码' }] }]);
});

test('模拟响应明确说明未调用模型 API', async () => {
  const response = await runTask(createMockProvider(), { model: 'mock-v1', prompt: '检查代码' }, new AbortController().signal);
  assert.match(response.text, /模拟响应，未调用模型 API/);
  assert.match(response.text, /已收到任务：检查代码/);
});

test('空任务和已取消的任务不会调用适配器', async () => {
  let calls = 0;
  const provider: ModelProvider = {
    id: 'counting',
    async complete() {
      calls++;
      return { text: 'unexpected' };
    },
  };
  await assert.rejects(runTask(provider, { model: 'test', prompt: ' ' }, new AbortController().signal),
    (error: Error) => error instanceof AppError && error.code === 'EMPTY_PROMPT');
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(runTask(provider, { model: 'test', prompt: 'task' }, cancelled.signal), { name: 'AbortError' });
  assert.equal(calls, 0);
});

test('适配器调用中取消时，不发布随后返回的响应', async () => {
  const controller = new AbortController();
  const provider: ModelProvider = {
    id: 'late-response',
    async complete() {
      controller.abort();
      return { text: '迟到的响应' };
    },
  };
  await assert.rejects(runTask(provider, { model: 'test', prompt: 'task' }, controller.signal), { name: 'AbortError' });
});

test('适配器失败会向调用方传播，不转换为模拟成功', async () => {
  const failure = new Error('provider failed');
  const provider: ModelProvider = {
    id: 'failing',
    async complete() { throw failure; },
  };
  await assert.rejects(runTask(provider, { model: 'test', prompt: 'task' }, new AbortController().signal),
    (error: Error) => error === failure);
});
