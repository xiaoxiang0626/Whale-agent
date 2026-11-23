import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReadOnlyTools } from '../src/tools/read-only.ts';
import type { ToolSet } from '../src/tools/types.ts';

async function call(tools: ToolSet, name: string, args: object) {
  return tools.execute({ id: 'test', name, arguments: JSON.stringify(args) }, new AbortController().signal);
}

test('工具读取真实文本、分页目录并应用根目录与嵌套忽略规则', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'coding-agent-files-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'src'));
  await writeFile(join(directory, '.gitignore'), '*.private\nsrc/*.txt\n');
  await writeFile(join(directory, 'src/.gitignore'), '!visible.txt\nhidden.txt\n');
  await writeFile(join(directory, 'src/visible.txt'), '第一行\n第二行\n第三行\n');
  await writeFile(join(directory, 'src/hidden.txt'), 'private fixture');
  await writeFile(join(directory, '.env'), 'private fixture');
  await writeFile(join(directory, '.env.example'), 'example');
  const tools = await createReadOnlyTools(directory);
  const root = await call(tools, 'list_files', { path: '.', limit: 1 });
  assert.equal(root.ok, true);
  assert.equal(JSON.parse(root.content).entries.length, 1);
  assert.equal(JSON.parse(root.content).nextOffset, 1);
  const listed = await call(tools, 'list_files', { path: 'src' });
  assert.deepEqual(JSON.parse(listed.content).entries.map((item: { path: string }) => item.path), ['src/.gitignore', 'src/visible.txt']);
  const text = JSON.parse((await call(tools, 'read_file', { path: 'src/visible.txt', start_line: 2, max_lines: 1 })).content);
  assert.equal(text.content, '第二行'); assert.equal(text.nextLine, 3); assert.equal(text.totalLines, 3);
  assert.equal((await call(tools, 'read_file', { path: '.env.example' })).ok, true);
});

test('绝对路径、父目录、凭据、忽略目录、符号链接和硬链接均不可读取', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'coding-agent-policy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'workspace'); const outside = join(directory, 'outside');
  await mkdir(root); await mkdir(outside);
  await writeFile(join(outside, 'secret.txt'), 'private fixture');
  await writeFile(join(root, '.env'), 'private fixture');
  await writeFile(join(root, 'private.pem'), 'private fixture');
  await mkdir(join(root, 'ignored')); await writeFile(join(root, 'ignored/data.txt'), 'private fixture');
  await writeFile(join(root, '.gitignore'), 'ignored/\n');
  await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await link(join(outside, 'secret.txt'), join(root, 'hardlink.txt'));
  const tools = await createReadOnlyTools(root);
  for (const path of ['../outside/secret.txt', outside, '/etc/passwd', 'C:\\outside\\secret.txt', '.env', './.env', 'private.pem',
    '.ENV.production', 'node_modules/a.txt', '.git/config', 'ignored/data.txt', 'linked/secret.txt', 'hardlink.txt', 'file:stream', 'x/../.env']) {
    const result = await call(tools, 'read_file', { path });
    assert.equal(result.ok, false, path); assert.doesNotMatch(result.content, /private fixture/);
    assert.match(result.content, /PATH_DENIED/);
  }
  const listed = await call(tools, 'list_files', { path: '.' });
  assert.doesNotMatch(listed.content, /linked|ignored|\.env|private.pem/);
});

test('工具验证 JSON 和参数，并限制文本大小、UTF-8、二进制与输出行数', async t => {
  const root = await mkdtemp(join(tmpdir(), 'coding-agent-limits-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'big.txt'), 'x'.repeat(262145));
  await writeFile(join(root, 'long.txt'), 'x'.repeat(20001));
  await writeFile(join(root, 'binary.bin'), Buffer.from([0, 1, 2]));
  await writeFile(join(root, 'invalid.txt'), Buffer.from([0xff]));
  await writeFile(join(root, 'pages.txt'), Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n'));
  const tools = await createReadOnlyTools(root);
  for (const [path, error] of [['big.txt', 'FILE_TOO_LARGE'], ['long.txt', 'LINE_TOO_LONG'], ['binary.bin', 'NOT_TEXT'], ['invalid.txt', 'NOT_TEXT'], ['missing', 'NOT_FOUND']]) {
    const result = await call(tools, 'read_file', { path }); assert.equal(result.ok, false); assert.match(result.content, new RegExp(error ?? ''));
  }
  for (const args of [{ path: '.', max_lines: 201 }, { path: '.', start_line: 0 }, { path: '.', surprise: true }, { path: 4 }]) {
    assert.match((await call(tools, 'read_file', args)).content, /INVALID_ARGUMENTS/);
  }
  assert.match((await tools.execute({ id: 'bad', name: 'read_file', arguments: '{' }, new AbortController().signal)).content, /INVALID_ARGUMENTS/);
  assert.match((await call(tools, 'run_shell', { path: '.' })).content, /UNKNOWN_TOOL/);
  const page = JSON.parse((await call(tools, 'read_file', { path: 'pages.txt', max_lines: 200 })).content);
  assert.equal(page.endLine, 200); assert.equal(page.nextLine, 201); assert.equal(page.totalLines, 300);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(tools.execute({ id: 'cancel', name: 'read_file', arguments: '{}' }, controller.signal), { name: 'AbortError' });
});
