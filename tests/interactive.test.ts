import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import test from 'node:test';
import { Conversation } from '../src/conversation.ts';
import { runInteractive } from '../src/interactive.ts';
import type { ModelProvider } from '../src/providers/types.ts';

function setup(provider: ModelProvider) {
  const input = new PassThrough();
  const output = new PassThrough();
  const errors = new PassThrough();
  let text = '';
  let diagnostics = '';
  output.setEncoding('utf8').on('data', (chunk: string) => { text += chunk; });
  errors.setEncoding('utf8').on('data', (chunk: string) => { diagnostics += chunk; });
  const terminal = createInterface({ input, output, terminal: false, crlfDelay: Infinity });
  const conversation = new Conversation(provider, 'test-model');
  const finished = runInteractive(conversation, terminal, output, errors);
  return { input, terminal, conversation, finished, text: () => text, diagnostics: () => diagnostics };
}

test('按顺序处理多行、命令与退出，清空后模型不再看到旧上下文', async () => {
  const sizes: number[] = [];
  const ui = setup({ id: 'test', async complete(request) { sizes.push(request.messages.length); return { text: '回复' }; } });
  ui.input.end('第一轮\r\n第二轮\r\n/help\r\n/unknown\r\n/clear\r\n新话题\r\n/exit\r\n不应执行\r\n');
  await ui.finished;
  assert.deepEqual(sizes, [1, 3, 1]);
  assert.match(ui.text(), /交互会话/);
  assert.match(ui.text(), /已清空上下文/);
  assert.match(ui.text(), /会话已结束/);
  assert.match(ui.diagnostics(), /未知命令/);
  assert.equal(ui.conversation.messages.length, 2);
  assert.equal(ui.terminal.listenerCount('SIGINT'), 0);
});

test('失败后继续接受输入，不把底层异常和失败输入加入历史', async () => {
  let calls = 0;
  const ui = setup({ id: 'failure', async complete(request) {
    calls++;
    if (calls === 1) { throw new Error('private-key-value'); }
    assert.equal(request.messages.length, 1);
    return { text: '恢复成功' };
  } });
  ui.input.end('失败任务\n恢复任务\n');
  await ui.finished;
  assert.equal(calls, 2);
  assert.match(ui.diagnostics(), /任务失败/);
  assert.doesNotMatch(ui.diagnostics(), /private-key-value/);
  assert.match(ui.text(), /恢复成功/);
  assert.equal(ui.conversation.messages.length, 2);
});

test('输入先结束时等待当前回复，继续处理已收到的行而不重新打开输入', async () => {
  let entered!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const ui = setup({ id: 'slow', async complete() {
    calls++;
    if (calls === 1) { entered(); await gate; }
    return { text: '完成' };
  } });
  const closed = once(ui.terminal, 'close');
  ui.input.end('第一轮\n第二轮\n');
  await enteredPromise;
  await closed;
  release();
  await ui.finished;
  assert.equal(calls, 2);
  assert.equal(ui.conversation.messages.length, 4);
  assert.equal(ui.diagnostics(), '');
});

test('请求期间中断取消本轮，保留终端供下一次输入；空闲中断退出', async () => {
  let entered!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  let settled!: () => void;
  const settledPromise = new Promise<void>(resolve => { settled = resolve; });
  const ui = setup({ id: 'pending', complete(_request, signal) {
    entered();
    return new Promise(resolve => {
      signal.addEventListener('abort', () => { resolve({ text: '迟到结果' }); settled(); }, { once: true });
    });
  } });
  ui.input.write('取消本轮\n');
  await enteredPromise;
  ui.terminal.emit('SIGINT');
  await settledPromise;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(ui.conversation.messages, []);
  assert.match(ui.text(), /已取消本次请求/);
  assert.doesNotMatch(ui.text(), /助手> 迟到结果/);
  ui.terminal.emit('SIGINT');
  await ui.finished;
  assert.equal(ui.terminal.listenerCount('SIGINT'), 0);
  ui.input.destroy();
});
