/** 工作区内的受限路径与文本读取；不提供操作系统级沙箱。 */
import { lstat, open, realpath, readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { Stats } from 'node:fs';
import ignore from 'ignore';
import type { Ignore } from 'ignore';
import { AppError } from '../errors.ts';

const maxFileBytes = 262144;
const protectedNames = new Set(['.git', '.local-assets', '.ssh', '.aws', '.azure', '.npmrc', '.pypirc', '.netrc', '.git-credentials', 'node_modules', 'dist']);

/** 可传回模型的固定文件工具失败。 */
export class FileToolError extends Error {
  readonly code: string;
  /** @param code 失败类别。 @param message 固定诊断，不包含底层异常内容。 */
  constructor(code: string, message: string) { super(message); this.name = 'FileToolError'; this.code = code; }
}

function denied(): FileToolError { return new FileToolError('PATH_DENIED', '路径不可访问；请使用工作区内未被忽略的普通文件或目录。'); }
function protectedPart(part: string): boolean {
  const name = part.toLowerCase();
  return protectedNames.has(name) || (name.startsWith('.env') && name !== '.env.example')
    || /\.(pem|key|pfx|p12)$/.test(name) || /^id_(rsa|dsa|ecdsa|ed25519)(\.|$)/.test(name);
}

async function readBounded(path: string, stat: Stats, limit: number, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  const handle = await open(path, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink > 1 || opened.dev !== stat.dev || opened.ino !== stat.ino) { throw denied(); }
    if (opened.size > limit) { throw new FileToolError('FILE_TOO_LARGE', '文件超过读取字节上限。'); }
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length <= limit) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) { break; }
      length += bytesRead;
    }
    signal.throwIfAborted();
    if (length > limit) { throw new FileToolError('FILE_TOO_LARGE', '文件超过读取字节上限。'); }
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
}

/** 在一个已解析的真实目录内列出和读取文件。 */
export class Workspace {
  readonly root: string;
  /** @param root 已验证的真实目录绝对路径。 */
  private constructor(root: string) { this.root = root; }

  /** @param directory 用户授予的工作目录。 @returns 解析后的工作区；无效目录在启动时失败。 */
  static async create(directory: string): Promise<Workspace> {
    try {
      const root = await realpath(resolve(directory));
      if (!(await lstat(root)).isDirectory() || /[\u0000-\u001f]/.test(root)) { throw new Error('Invalid directory'); }
      return new Workspace(root);
    } catch (error) {
      if (error instanceof Error) { throw new AppError('INVALID_CONFIG', '工作区须为存在且可读取的目录。'); }
      throw error;
    }
  }

  private async rules(directory: string, signal: AbortSignal): Promise<Ignore | undefined> {
    const file = join(directory, '.gitignore');
    let stat: Stats;
    try { stat = await lstat(file); } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') { return undefined; }
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) { throw denied(); }
    return ignore().add((await readBounded(file, stat, 65536, signal)).toString('utf8'));
  }

  /** @param path 工作区相对路径。 @param signal 取消信号。 @returns 已校验的真实路径与文件属性。 */
  async existing(path: string, signal: AbortSignal): Promise<{ path: string; relativePath: string; stat: Stats }> {
    signal.throwIfAborted();
    if (path.length > 4096 || /^[\\/]/.test(path) || /[:<>"|?*\u0000-\u001f]/.test(path)) { throw denied(); }
    const parts = path.replace(/\\/g, '/').split('/').filter(part => part.length > 0 && part !== '.');
    if (parts.some(part => part === '..' || part.endsWith('.') || part.endsWith(' ') || protectedPart(part))) { throw denied(); }
    let current = this.root;
    let stat = await lstat(current);
    if (stat.isSymbolicLink()) { throw denied(); }
    const policies: { depth: number; matcher: Ignore }[] = [];
    for (let index = 0; index < parts.length; index++) {
      const policy = await this.rules(current, signal);
      if (policy !== undefined) { policies.push({ depth: index, matcher: policy }); }
      current = join(current, parts[index] ?? '');
      stat = await lstat(current);
      if (stat.isSymbolicLink()) { throw denied(); }
      let ignored = false;
      for (const { depth, matcher } of policies) {
        const result = matcher.test(parts.slice(depth, index + 1).join('/') + (stat.isDirectory() ? '/' : ''));
        if (result.ignored) { ignored = true; }
        if (result.unignored) { ignored = false; }
      }
      if (ignored) { throw denied(); }
    }
    const actual = await realpath(current);
    const canonical = relative(this.root, actual);
    if (canonical === '..' || canonical.startsWith(`..${sep}`) || resolve(this.root, canonical) !== actual
      || canonical.split(sep).some(protectedPart)) { throw denied(); }
    signal.throwIfAborted();
    if (canonical.length > 0 && canonical.split(sep).join('/') !== parts.join('/')) {
      return this.existing(canonical.split(sep).join('/'), signal);
    }
    return { path: actual, relativePath: canonical.split(sep).join('/') || '.', stat };
  }

  /** @param path 相对目录。 @param offset 首项偏移。 @param limit 返回数量。 @param signal 取消信号。 @returns 文件列表与下一页偏移。 */
  async list(path: string, offset: number, limit: number, signal: AbortSignal) {
    const target = await this.existing(path, signal);
    if (!target.stat.isDirectory()) { throw new FileToolError('NOT_DIRECTORY', '该路径不是目录。'); }
    const items = (await readdir(target.path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'));
    const entries: { path: string; type: 'file' | 'directory' }[] = [];
    for (const item of items) {
      signal.throwIfAborted();
      if (item.isSymbolicLink() || (!item.isFile() && !item.isDirectory())) { continue; }
      try {
        const child = await this.existing(relative(this.root, join(target.path, item.name)), signal);
        entries.push({ path: child.relativePath, type: item.isDirectory() ? 'directory' : 'file' });
      } catch (error) {
        if (error instanceof FileToolError && error.code === 'PATH_DENIED') { continue; }
        throw error;
      }
    }
    return { path: target.relativePath, entries: entries.slice(offset, offset + limit),
      total: entries.length, nextOffset: offset + limit < entries.length ? offset + limit : null };
  }

  /** @param path 相对文件。 @param startLine 起始行。 @param maxLines 行数上限。 @param signal 取消信号。 @returns 有界 UTF-8 文本与分页信息。 */
  async read(path: string, startLine: number, maxLines: number, signal: AbortSignal) {
    const target = await this.existing(path, signal);
    if (!target.stat.isFile()) { throw new FileToolError('NOT_FILE', '该路径不是普通文件。'); }
    const buffer = await readBounded(target.path, target.stat, maxFileBytes, signal);
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch (error) {
      if (error instanceof TypeError) { throw new FileToolError('NOT_TEXT', '文件不是有效 UTF-8 文本。'); }
      throw error;
    }
    if (text.includes('\0')) { throw new FileToolError('NOT_TEXT', '文件包含二进制数据。'); }
    const lines = text.split(/\r?\n/);
    if (lines.at(-1) === '') { lines.pop(); }
    const selected: string[] = [];
    let size = 0;
    for (const line of lines.slice(startLine - 1, startLine - 1 + maxLines)) {
      if (line.length > 20000) { throw new FileToolError('LINE_TOO_LONG', '单行文本超过 20000 字符上限。'); }
      const length = line.length + (selected.length > 0 ? 1 : 0);
      if (size + length > 20000) { break; }
      selected.push(line); size += length;
    }
    const endLine = Math.min(lines.length, startLine + selected.length - 1);
    return { path: target.relativePath, startLine, endLine, totalLines: lines.length,
      content: selected.join('\n'), nextLine: endLine < lines.length ? endLine + 1 : null };
  }
}
