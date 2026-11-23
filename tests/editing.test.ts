import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, readdir, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createEditingTools } from '../src/tools/editing.ts';
import { Conversation } from '../src/conversation.ts';
import { createMockProvider } from '../src/providers/mock.ts';
import { displayText } from '../src/display.ts';
import type { ToolSet } from '../src/tools/types.ts';

const signal = new AbortController().signal;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
async function propose(tools: ToolSet, path: string, content: string, expected_sha256: string | null) {
  return tools.execute({ id: 'proposal', name: 'propose_file', arguments: JSON.stringify({ path, content, expected_sha256 }) }, signal);
}

test('提案先展示 diff；确认才替换或新建，拒绝和重复确认不写入', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-edit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = '\ufeff第一行\r\n旧内容\r\n';
  const updated = '\ufeff第一行\r\n新内容\r\n';
  await writeFile(join(root, 'text.txt'), original);
  const tools = await createEditingTools(root);
  const read = JSON.parse((await tools.execute({ id: 'read', name: 'read_file', arguments: '{"path":"text.txt"}' }, signal)).content);
  assert.equal(read.content, original); assert.equal(read.hasBom, true); assert.equal(read.sha256, hash(original));
  const result = await propose(tools, 'text.txt', updated, read.sha256);
  assert.match(result.preview ?? '', /-旧内容\r?\n\+新内容/);
  assert.equal(await readFile(join(root, 'text.txt'), 'utf8'), original);
  assert.equal((await tools.action?.('apply', 'edit-1', signal))?.ok, true);
  assert.equal(await readFile(join(root, 'text.txt'), 'utf8'), updated);
  assert.match((await tools.action?.('apply', 'edit-1', signal))?.content ?? '', /UNKNOWN_PROPOSAL/);
  await propose(tools, 'new.txt', 'new\n', null);
  assert.equal((await tools.action?.('reject', 'edit-2', signal))?.ok, true);
  await assert.rejects(readFile(join(root, 'new.txt')), { code: 'ENOENT' });
  await propose(tools, 'new.txt', 'new\n', null);
  assert.equal((await tools.action?.('apply', 'edit-3', signal))?.ok, true);
  assert.equal(await readFile(join(root, 'new.txt'), 'utf8'), 'new\n');
  assert.deepEqual((await readdir(root)).sort(), ['new.txt', 'text.txt']);
});

test('预览后文件变化、新建路径被占用、凭据和链接均拒绝写入', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-conflict-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'a.txt'), 'old');
  await writeFile(join(root, '.gitignore'), 'ignored/\n');
  await mkdir(join(root, 'ignored'));
  await symlink(join(root, 'ignored'), join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const tools = await createEditingTools(root);
  assert.match((await propose(tools, 'a.txt', 'new', hash('wrong'))).content, /FILE_CHANGED/);
  await propose(tools, 'a.txt', 'new', hash('old'));
  await writeFile(join(root, 'a.txt'), 'user change');
  assert.match((await tools.action?.('apply', 'edit-1', signal))?.content ?? '', /FILE_CHANGED/);
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'user change');
  await propose(tools, 'new.txt', 'new', null);
  await writeFile(join(root, 'new.txt'), 'user created');
  assert.match((await tools.action?.('apply', 'edit-2', signal))?.content ?? '', /FILE_CHANGED/);
  for (const path of ['../outside', '.env', '.git/config', 'ignored/new.txt', 'linked/new.txt']) {
    assert.match((await propose(tools, path, 'new', null)).content, /PATH_DENIED/);
  }
  assert.equal((await propose(tools, 'missing/new.txt', 'new', null)).ok, false);
  assert.match((await propose(tools, 'oversized.txt', '中'.repeat(22000), null)).content, /INVALID_CONTENT/);
  assert.match((await propose(tools, 'surrogate.txt', '\ud800', null)).content, /INVALID_CONTENT/);
  for (let index = 0; index < 10; index++) { assert.equal((await propose(tools, `file${index}.txt`, 'new', null)).ok, true); }
  assert.match((await propose(tools, 'extra.txt', 'new', null)).content, /PROPOSAL_LIMIT/);
  tools.clearPending?.();
  assert.match((await tools.action?.('apply', 'edit-3', signal))?.content ?? '', /UNKNOWN_PROPOSAL/);
});

test('确认操作的结果在模型失败或取消后仍保留；清空会丢弃待确认提案', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-action-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = await createEditingTools(root);
  await propose(tools, 'saved.txt', 'saved', null);
  const conversation = new Conversation({ id: 'fail', async complete() { throw new Error('provider failure'); } }, 'model', { tools });
  await assert.rejects(conversation.send('/apply edit-1', signal));
  assert.equal(await readFile(join(root, 'saved.txt'), 'utf8'), 'saved');
  assert.match(conversation.messages.at(-1)?.content ?? '', /"status":"applied"/);
  const before = conversation.messages.length;
  assert.match((await conversation.send('/apply edit-1', signal)).text, /UNKNOWN_PROPOSAL/);
  assert.equal(conversation.messages.length, before + 2);
  await propose(tools, 'cancel.txt', 'saved before cancellation', null);
  const controller = new AbortController();
  const cancelled = new Conversation({ id: 'cancel', async complete() { controller.abort(); return { text: 'late' }; } }, 'model', { tools });
  await assert.rejects(cancelled.send('/apply edit-2', controller.signal), { name: 'AbortError' });
  assert.match(cancelled.messages.at(-1)?.content ?? '', /"status":"applied"/);
  assert.equal(await readFile(join(root, 'cancel.txt'), 'utf8'), 'saved before cancellation');
  await propose(tools, 'discard.txt', 'discard', null);
  const normal = new Conversation(createMockProvider(), 'mock', { tools });
  normal.clear();
  assert.match((await normal.send('/apply edit-3', signal)).text, /UNKNOWN_PROPOSAL/);
});

test('预览显示移除终端控制序列，模型和文件文本保持原始内容', () => {
  const input = '\x1b[2J+danger\r\n\x1b]0;title\x07\ttext';
  assert.equal(displayText(input), '+danger\n    text');
  assert.match(input, /\x1b/);
});
