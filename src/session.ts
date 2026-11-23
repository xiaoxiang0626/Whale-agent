/** 版本化 JSONL 会话日志：先刷盘再执行请求或确认操作，不保存认证头。 */
import { openSync, closeSync, fstatSync, readFileSync, writeSync, fsyncSync, ftruncateSync, copyFileSync, constants } from 'node:fs';
import { mkdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { AppError } from './errors.ts';
import { isRecord } from './providers/wire.ts';
import type { ModelMessage, ModelRequest, ModelResponse, ToolCall } from './providers/types.ts';
import type { ToolResult } from './tools/types.ts';

/** 会话恢复时必须一致的运行身份；不含 API 配置或凭据。 */
export interface SessionIdentity {
  readonly workspace: string;
  readonly provider: string;
  readonly model: string;
  readonly mode: 'none' | 'read-only' | 'confirmed';
}

/** 可恢复的完整成功历史和实际操作状态。 */
export interface SessionState {
  readonly messages: readonly ModelMessage[];
  readonly turns: number;
  readonly blocked: boolean;
}

type Event =
  | { readonly kind: 'header'; readonly data: { readonly formatVersion: 1; readonly identity: SessionIdentity } }
  | { readonly kind: 'state'; readonly data: SessionState }
  | { readonly kind: 'request'; readonly data: ModelRequest }
  | { readonly kind: 'response'; readonly data: ModelResponse }
  | { readonly kind: 'action_begin'; readonly data: { readonly input: string } }
  | { readonly kind: 'action_end'; readonly data: { readonly input: string; readonly result: ToolResult; readonly state: SessionState } };

const maxBytes = 134217728;
function corrupt(): AppError { return new AppError('SESSION_CORRUPT', '会话日志损坏或包含不支持的数据；请保留原文件并检查，不能自动重放。'); }
function isCall(value: unknown): value is ToolCall {
  return isRecord(value) && typeof value['id'] === 'string' && value['id'].length > 0 && value['id'].length <= 256
    && typeof value['name'] === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value['name'])
    && typeof value['arguments'] === 'string' && value['arguments'].length <= 65536;
}
function isResponse(value: unknown): value is ModelResponse {
  return isRecord(value) && typeof value['text'] === 'string'
    && (value['reasoningContent'] === undefined || typeof value['reasoningContent'] === 'string')
    && (value['toolCalls'] === undefined || (Array.isArray(value['toolCalls']) && value['toolCalls'].length <= 8 && value['toolCalls'].every(isCall)));
}
function isMessage(value: unknown): value is ModelMessage {
  if (!isRecord(value) || typeof value['content'] !== 'string') { return false; }
  if (value['role'] === 'user' || value['role'] === 'system') { return true; }
  if (value['role'] === 'tool') { return typeof value['toolCallId'] === 'string'; }
  return value['role'] === 'assistant' && isResponse({ ...value, text: value['content'] });
}
function isMessages(value: unknown): value is readonly ModelMessage[] {
  if (!Array.isArray(value) || !value.every(isMessage)) { return false; }
  const pending = new Set<string>();
  const ids = new Set<string>();
  for (const message of value) {
    if (message.role === 'tool') { if (!pending.delete(message.toolCallId)) { return false; } }
    else {
      if (pending.size > 0) { return false; }
      if (message.role === 'user') { ids.clear(); }
      if (message.role === 'assistant') {
        for (const call of message.toolCalls ?? []) { if (ids.has(call.id)) { return false; } ids.add(call.id); pending.add(call.id); }
      }
    }
  }
  return pending.size === 0;
}
function isState(value: unknown): value is SessionState {
  return isRecord(value) && isMessages(value['messages'])
    && typeof value['turns'] === 'number' && Number.isSafeInteger(value['turns']) && value['turns'] >= 0 && typeof value['blocked'] === 'boolean';
}
function isRequest(value: unknown): value is ModelRequest {
  return isRecord(value) && typeof value['model'] === 'string' && isMessages(value['messages'])
    && (value['tools'] === undefined || (Array.isArray(value['tools']) && value['tools'].every((tool: unknown) => isRecord(tool)
      && typeof tool['name'] === 'string' && typeof tool['description'] === 'string' && isRecord(tool['parameters']))));
}
function isResult(value: unknown): value is ToolResult {
  return isRecord(value) && typeof value['ok'] === 'boolean' && typeof value['content'] === 'string' && typeof value['summary'] === 'string'
    && (value['preview'] === undefined || typeof value['preview'] === 'string') && (value['continueModel'] === undefined || typeof value['continueModel'] === 'boolean')
    && (value['uncertain'] === undefined || typeof value['uncertain'] === 'boolean');
}

/** @param workspace 真实工作区目录。 @param name 用户提供的会话名。 @returns 工作区内受工具保护的日志路径。 */
export async function sessionPath(workspace: string, name: string): Promise<string> {
  if (!/^[\p{L}\p{N}_-]{1,64}$/u.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) {
    throw new AppError('INVALID_ARGUMENTS', '会话名限 1–64 个字母、数字、下划线或连字符，不能使用系统保留名称。');
  }
  try {
    let directory = workspace;
    for (const part of ['.coding-agent', 'sessions']) {
      directory = join(directory, part);
      await mkdir(directory, { recursive: true });
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) { throw new AppError('SESSION_IO', '会话目录须为工作区内的普通目录，不能是链接。'); }
    }
    return join(directory, `${name}.jsonl`);
  } catch (error) {
    if (error instanceof AppError) { throw error; }
    throw new AppError('SESSION_IO', '无法创建会话目录，请检查工作区路径和写入权限。');
  }
}

/** 一个独占打开的会话日志；所有 append 同步写入并 fsync，失败后禁止继续使用。 */
export class SessionJournal {
  readonly path: string;
  private readonly fd: number;
  private readonly release: () => Promise<void>;
  private readonly compromised: () => boolean;
  private readonly secrets: readonly string[];
  private sequence = 0;
  private bytes = 0;
  private failed = false;
  private closed = false;
  private current: SessionState = { messages: [], turns: 0, blocked: false };

  private constructor(path: string, fd: number, release: () => Promise<void>, compromised: () => boolean, secrets: readonly string[]) {
    this.path = path; this.fd = fd; this.release = release; this.compromised = compromised; this.secrets = secrets;
  }

  /** 已刷盘的恢复状态副本。 */
  get state(): SessionState { return structuredClone(this.current); }

  /**
   * 新建时不覆盖已有文件；恢复时拒绝身份不符、未知版本和损坏行。
   * @param path 日志绝对路径，父目录已存在。 @param identity 已解析运行身份。
   * @param resume 是否恢复。 @param repair 是否备份后仅移除未完成的末行。 @param secrets 禁止写入的已知密钥。
   * @returns 持有独占锁的日志；调用方必须 close。
   */
  static async open(path: string, identity: SessionIdentity, resume: boolean, repair = false, secrets: readonly string[] = []): Promise<SessionJournal> {
    let lost = false;
    let release: (() => Promise<void>) | undefined;
    let fd: number | undefined;
    try {
      release = await lockfile.lock(path, { realpath: false, stale: 10000, update: 2000, retries: 0, onCompromised: () => { lost = true; } });
      if (resume) {
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) { throw corrupt(); }
      }
      fd = openSync(path, resume ? 'r+' : 'wx+', 0o600);
      const journal = new SessionJournal(path, fd, release, () => lost, secrets);
      if (!resume) { journal.append({ kind: 'header', data: { formatVersion: 1, identity } }); }
      else { journal.load(identity, repair); }
      return journal;
    } catch (error) {
      if (fd !== undefined) { closeSync(fd); }
      if (release !== undefined) { await release(); }
      if (error instanceof AppError) { throw error; }
      throw new AppError('SESSION_IO', '无法打开或锁定会话；请检查名称、权限和已有进程。异常退出后等待至少 10 秒再恢复。');
    }
  }

  private load(identity: SessionIdentity, repair: boolean): void {
    const stat = fstatSync(this.fd);
    if (stat.size > maxBytes) { throw new AppError('SESSION_IO', '会话超过 128 MiB 上限，请保留原文件并新建会话。'); }
    const buffer = readFileSync(this.fd);
    const completeBytes = buffer.lastIndexOf(10) + 1;
    const partial = completeBytes !== buffer.length;
    if (partial && !repair) { throw new AppError('SESSION_CORRUPT', '会话末行未完成；可加 --repair-session 备份原日志后移除末行，再恢复。'); }
    let source: string;
    try { source = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, completeBytes)); }
    catch (error) { if (error instanceof TypeError) { throw corrupt(); } throw error; }
    const lines = source.split('\n'); lines.pop();
    if (lines.length === 0) { throw corrupt(); }
    let pending: string | undefined;
    for (const [index, line] of lines.entries()) {
      if (this.secrets.some(secret => secret.length > 0 && (line.includes(secret) || line.includes(JSON.stringify(secret).slice(1, -1))))) {
        throw new AppError('SESSION_SECRET', '日志包含当前已知 API Key，已阻止恢复；请保留文件并先移除凭据。');
      }
      let value: unknown;
      try { value = JSON.parse(line); } catch (error) { if (error instanceof SyntaxError) { throw corrupt(); } throw error; }
      if (!isRecord(value) || value['seq'] !== index + 1 || typeof value['kind'] !== 'string') { throw corrupt(); }
      const data = value['data'];
      if (index === 0) {
        if (value['kind'] !== 'header' || !isRecord(data)) { throw corrupt(); }
        if (data['formatVersion'] !== 1) { throw new AppError('SESSION_VERSION', '不支持该会话日志版本，请使用对应版本程序或新建会话。'); }
        const savedIdentity = data['identity'];
        if (!isRecord(savedIdentity) || Object.entries(identity).some(([key, expected]) => savedIdentity[key] !== expected)) {
          throw new AppError('SESSION_MISMATCH', '会话工作区、模型、适配器或工具模式不一致，请使用原配置恢复。');
        }
      } else if (value['kind'] === 'state' && isState(data)) { this.current = data; }
      else if (value['kind'] === 'request' && isRequest(data)) { /* 请求仅存档，不能作为已成功历史重放。 */ }
      else if (value['kind'] === 'response' && isResponse(data)) { /* 响应仅存档，由 state 决定恢复历史。 */ }
      else if (value['kind'] === 'action_begin' && isRecord(data) && typeof data['input'] === 'string' && pending === undefined) { pending = data['input']; }
      else if (value['kind'] === 'action_end' && isRecord(data) && pending !== undefined && data['input'] === pending && isState(data['state']) && isResult(data['result'])) {
        this.current = data['state']; pending = undefined;
      } else { throw corrupt(); }
    }
    this.sequence = lines.length; this.bytes = completeBytes;
    if (partial) {
      const backup = `${this.path}.recovery-${randomUUID()}.bak`;
      copyFileSync(this.path, backup, constants.COPYFILE_EXCL);
      const backupFd = openSync(backup, 'r+');
      try { fsyncSync(backupFd); } finally { closeSync(backupFd); }
      ftruncateSync(this.fd, completeBytes); fsyncSync(this.fd);
    }
    const notice = pending === undefined
      ? '[会话恢复] 保留已完成历史；此前待确认提案全部失效，请重新提出。未完成模型请求未加入成功历史，不会自动重放操作。'
      : `[操作结果未知] 上次确认 ${pending} 未记录结束；必须检查实际文件和进程。本会话禁止继续确认副作用，不会重放操作；待确认提案全部失效。`;
    const state: SessionState = { ...this.current, blocked: this.current.blocked || pending !== undefined,
      messages: [...this.current.messages, { role: 'system', content: notice }] };
    if (pending === undefined) { this.append({ kind: 'state', data: state }); }
    else {
      this.append({ kind: 'action_end', data: { input: pending, state,
        result: { ok: false, uncertain: true, content: JSON.stringify({ status: 'unknown', recovered: true }), summary: '恢复时无法确认上次操作结果，未重放。' } } });
    }
  }

  /** @param event 经过类型约束的消息或实际结果。 */
  append(event: Event): void {
    if (this.closed || this.failed || this.compromised()) { throw new AppError('SESSION_IO', '会话日志已关闭、失去锁或写入失败，请停止操作并重新检查日志。'); }
    const line = JSON.stringify({ seq: this.sequence + 1, ...event }) + '\n';
    if (this.secrets.some(secret => secret.length > 0 && (line.includes(secret) || line.includes(JSON.stringify(secret).slice(1, -1))))) {
      if (event.kind === 'action_end') { this.failed = true; }
      throw new AppError('SESSION_SECRET', '内容包含已知 API Key，已阻止记录和后续请求；请移除密钥后再试。');
    }
    const buffer = Buffer.from(line);
    if (this.bytes + buffer.length > maxBytes) { this.failed = true; throw new AppError('SESSION_IO', '会话日志达到 128 MiB 上限，请新建会话。'); }
    try {
      let written = 0;
      while (written < buffer.length) { const size = writeSync(this.fd, buffer, written, buffer.length - written, this.bytes + written); if (size === 0) { throw new Error('Short write'); } written += size; }
      fsyncSync(this.fd);
    } catch (error) {
      this.failed = true;
      if (error instanceof Error) { throw new AppError('SESSION_IO', '会话日志未能刷盘，已停止后续操作；保留原文件并检查磁盘和权限。'); }
      throw error;
    }
    this.sequence++; this.bytes += buffer.length;
    if (event.kind === 'state') { this.current = structuredClone(event.data); }
    if (event.kind === 'action_end') { this.current = structuredClone(event.data.state); }
  }

  /** 关闭文件并释放锁；重复调用无影响。 */
  async close(): Promise<void> {
    if (this.closed) { return; }
    this.closed = true;
    try {
      try { closeSync(this.fd); } finally { await this.release(); }
    } catch (error) {
      if (error instanceof Error) { throw new AppError('SESSION_IO', '无法正常关闭会话日志或释放锁，请保留文件并检查其他进程。'); }
      throw error;
    }
  }
}
