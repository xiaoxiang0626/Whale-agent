import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement as h } from 'react';
import { renderToString } from 'ink';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { stripVTControlCharacters } from 'node:util';
import { Conversation } from '../src/conversation.ts';
import type { ModelProvider, ModelRequest } from '../src/providers/types.ts';
import { TerminalApp } from '../src/tui.ts';
import { TerminalView } from '../src/tui-view.ts';
import type { AgentOptions } from '../src/agent-loop.ts';

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) { throw new Error(label); }
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
}

function setup(provider: ModelProvider, options: AgentOptions = {}) {
  const conversation = new Conversation(provider, 'test-model', options);
  const app = render(h(TerminalApp, { conversation }));
  const frame = () => stripVTControlCharacters(app.lastFrame() ?? '');
  return { app, frame, conversation, close: () => { app.unmount(); app.cleanup(); } };
}

async function submit(ui: ReturnType<typeof setup>, text: string): Promise<void> {
  await waitFor(() => ui.frame().includes('输入消息或 /help'), 'Input is not ready');
  ui.app.stdin.write(text);
  await waitFor(() => ui.frame().includes(`你 › ${text}`), 'Input was not rendered');
  ui.app.stdin.write('\r');
}

test('宽屏、普通和窄窗口保留输入区，中文消息不越过终端宽高', () => {
  for (const [columns, rows] of [[130, 34], [80, 24], [40, 12]]) {
    assert.ok(columns !== undefined && rows !== undefined);
    const frame = stripVTControlCharacters(renderToString(h(TerminalView, {
      columns, rows, colorDepth: 1, model: 'deepseek-flash', provider: 'openai-compatible',
      entries: [{ role: 'assistant', text: '中文长消息🐳'.repeat(100) }], turns: 1,
      query: '尚未发送的草稿', pending: false, status: '就绪',
      onChange: () => {}, onSubmit: () => {},
    }), { columns }));
    assert.ok(frame.split('\n').length <= rows);
    for (const line of frame.split('\n')) { assert.ok(stringWidth(line) <= columns, line); }
    assert.match(frame, /你 ›/);
    assert.match(frame, /尚未发送的草稿/);
    if (columns >= 100) { assert.match(frame, /DeepSeek · 会话状态/); }
    else { assert.doesNotMatch(frame, /DeepSeek · 会话状态/); }
  }
});

test('TUI 展示实际工具进度，显示记录不展示工具正文或模型推理', async t => {
  let calls = 0;
  const ui = setup({ id: 'tool-ui', async complete() {
    calls++;
    return calls === 1 ? { text: '', reasoningContent: 'private-reasoning', toolCalls: [{ id: 'read', name: 'read_file', arguments: '{}' }] }
      : { text: '代码说明完成', reasoningContent: 'private-reasoning' };
  } }, { tools: { workspace: '/workspace', context: 'read', definitions: [], async execute() {
    return { ok: true, content: 'private-file-body', summary: '读取 app.ts，4 行' };
  } } });
  t.after(ui.close);
  await submit(ui, '解释');
  await waitFor(() => ui.frame().includes('代码说明完成'), 'Agent did not finish');
  assert.match(ui.frame(), /read_file：读取 app.ts/);
  assert.doesNotMatch(ui.frame(), /private-file-body|private-reasoning/);
  assert.equal(ui.conversation.turnCount, 1);
});

test('中文、emoji 和组合字符按字素编辑，缩放保留草稿并提交完整文本', async t => {
  const requests: ModelRequest[] = [];
  const ui = setup({ id: 'recording', async complete(request) { requests.push(request); return { text: '已收到' }; } });
  t.after(ui.close);
  await waitFor(() => ui.frame().includes('输入消息或 /help'), 'TUI did not mount');
  ui.app.stdin.write('你好🐳e\u0301');
  await waitFor(() => ui.frame().includes('你好🐳e\u0301'), 'Unicode input missing');
  ui.app.stdin.write('\x7f');
  await waitFor(() => !ui.frame().includes('e\u0301'), 'Combining character was not deleted');
  ui.app.stdin.write('\x7f');
  await waitFor(() => !ui.frame().includes('🐳'), 'Emoji was not deleted');
  ui.app.stdin.write('\x1b[D');
  await new Promise<void>(resolve => setImmediate(resolve));
  ui.app.stdin.write('鲸');
  await waitFor(() => ui.frame().includes('你鲸好'), 'Cursor insertion failed');
  Object.defineProperty(ui.app.stdout, 'columns', { value: 40, configurable: true });
  Object.defineProperty(ui.app.stdout, 'rows', { value: 12, configurable: true });
  ui.app.stdout.emit('resize');
  await waitFor(() => !ui.frame().includes('╭'), 'Compact layout did not render');
  assert.match(ui.frame(), /你鲸好/);
  ui.app.stdin.write('\r');
  await waitFor(() => ui.conversation.turnCount === 1, 'Turn did not complete');
  assert.deepEqual(requests[0]?.messages, [{ role: 'user', content: '你鲸好' }]);
});

test('取消后保留成功上下文，允许继续发送并清空', async t => {
  let calls = 0;
  let started!: () => void;
  const pendingStarted = new Promise<void>(resolve => { started = resolve; });
  const requests: ModelRequest[] = [];
  const ui = setup({ id: 'cancel', async complete(request, signal) {
    calls++; requests.push(request);
    if (calls === 2) {
      started();
      return new Promise(resolve => signal.addEventListener('abort', () => resolve({ text: '迟到结果' }), { once: true }));
    }
    return { text: '完成' };
  } });
  t.after(ui.close);
  await submit(ui, '保留');
  await waitFor(() => ui.conversation.turnCount === 1 && ui.frame().includes('输入消息或 /help'), 'First turn pending');
  await submit(ui, '取消'); await pendingStarted;
  ui.app.stdin.write('\x03');
  await waitFor(() => ui.frame().includes('已取消本次请求'), 'Cancellation missing');
  assert.equal(ui.conversation.turnCount, 1);
  assert.doesNotMatch(ui.frame(), /迟到结果/);
  await submit(ui, '继续');
  await waitFor(() => ui.conversation.turnCount === 2 && ui.frame().includes('输入消息或 /help'), 'Retry pending');
  assert.deepEqual(requests[2]?.messages.map(message => message.content), ['保留', '完成', '继续']);
  await submit(ui, '/clear');
  await waitFor(() => ui.frame().includes('上下文已清空'), 'Clear command missing');
  assert.equal(ui.conversation.turnCount, 0);
});

test('界面卸载会取消正在进行的请求，迟到响应不提交历史', async t => {
  let started!: () => void;
  let cancelled!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const aborted = new Promise<void>(resolve => { cancelled = resolve; });
  const ui = setup({ id: 'pending', complete(_request, signal) {
    started();
    return new Promise(resolve => signal.addEventListener('abort', () => { resolve({ text: 'late' }); cancelled(); }, { once: true }));
  } });
  t.after(ui.close);
  await submit(ui, '等待'); await entered;
  ui.app.unmount(); await aborted;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(ui.conversation.turnCount, 0);
});

test('历史翻页不修改尚未发送的输入，长回复可以回到最新消息', async t => {
  const ui = setup({ id: 'long', async complete() {
    return { text: Array.from({ length: 80 }, (_, index) => `回复行${index}`).join('\n') };
  } });
  t.after(ui.close);
  await submit(ui, '长回复');
  await waitFor(() => ui.frame().includes('回复行79'), 'Last line missing');
  ui.app.stdin.write('草稿');
  await waitFor(() => ui.frame().includes('你 › 草稿'), 'Draft missing');
  ui.app.stdin.write('\x1b[5~');
  await waitFor(() => ui.frame().includes('浏览历史'), 'Page up missing');
  assert.match(ui.frame(), /你 › 草稿/);
  for (let index = 0; index < 8; index++) {
    ui.app.stdin.write('\x1b[5~');
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
  await waitFor(() => ui.frame().includes('回复行0'), 'First page missing');
  ui.app.stdin.write('\x1b[6~');
  await waitFor(() => !ui.frame().includes('回复行0'), 'Page down stayed beyond first page');
  assert.doesNotMatch(ui.frame(), /回复行79/);
  for (let index = 0; index < 8; index++) {
    ui.app.stdin.write('\x1b[6~');
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
  await waitFor(() => ui.frame().includes('回复行79'), 'Page down missing');
  assert.match(ui.frame(), /你 › 草稿/);
});

test('界面显示固定错误诊断，失败后可重试且不提交失败输入', async t => {
  let calls = 0;
  const requests: ModelRequest[] = [];
  const ui = setup({ id: 'failure', async complete(request) {
    calls++; requests.push(request);
    if (calls === 1) { throw new Error('private-secret-value'); }
    return { text: '重试成功' };
  } });
  t.after(ui.close);
  await submit(ui, '失败');
  await waitFor(() => ui.frame().includes('请求失败'), 'Error state missing');
  assert.doesNotMatch(ui.frame(), /private-secret-value/);
  await submit(ui, '重试');
  await waitFor(() => ui.frame().includes('重试成功'), 'Retry missing');
  assert.deepEqual(requests[1]?.messages, [{ role: 'user', content: '重试' }]);
});
