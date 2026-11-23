import { AppError } from './errors.ts';
import type { ModelMessage, ModelProvider, ModelResponse } from './providers/types.ts';
import { runAgent } from './agent-loop.ts';
import type { AgentOptions } from './agent-loop.ts';
import type { AgentEvent, ToolResult } from './tools/types.ts';

/** 同一进程内的会话；模型失败不提交本轮消息，已确认的文件操作结果独立保留。 */
export class Conversation {
  readonly model: string;
  readonly providerId: string;
  private readonly provider: ModelProvider;
  private readonly history: ModelMessage[] = [];
  private busy = false;
  private turns = 0;
  private blocked = false;
  private settled: Promise<void> = Promise.resolve();
  private finish: (() => void) | undefined;
  private readonly options: AgentOptions;
  private readonly listeners = new Set<(event: AgentEvent) => void>();

  /** @param provider 模型适配器。 @param model 本会话使用的模型名。 @param options 已授权工具和循环限制。 */
  constructor(provider: ModelProvider, model: string, options: AgentOptions = {}) {
    this.provider = provider;
    this.providerId = provider.id;
    this.model = model;
    this.options = options;
    const saved = options.journal?.state;
    if (saved !== undefined) { for (const message of saved.messages) { this.history.push(message); } this.turns = saved.turns; this.blocked = saved.blocked; }
  }

  /** 已完成的模型消息与用户确认操作副本；不会随下一轮更新。 */
  get messages(): readonly ModelMessage[] {
    return structuredClone(this.history);
  }

  /** 已成功完成的问答轮数。 */
  get turnCount(): number { return this.turns; }

  /** 工作区绝对路径；没有工具时未定义。 */
  get workspace(): string | undefined { return this.options.tools?.workspace; }

  /** 当前日志路径；未启用日志时未定义。 */
  get sessionPath(): string | undefined { return this.options.journal?.path; }

  /** @returns 当前请求和确认操作结束后完成，用于退出前写完实际结果。 */
  waitUntilIdle(): Promise<void> { return this.settled; }

  private save(): void { this.options.journal?.append({ kind: 'state', data: { messages: this.history, turns: this.turns, blocked: this.blocked } }); }

  /** @param listener 同步接收进度，不应抛出异常。 @returns 移除该监听的函数。 */
  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** 清空已完成的问答；存在进行中的请求时失败。 */
  clear(): void {
    if (this.busy) { throw new AppError('CONVERSATION_BUSY', '请先等待或取消当前请求。'); }
    this.options.journal?.append({ kind: 'state', data: { messages: [], turns: 0, blocked: this.blocked } });
    this.history.length = 0;
    this.turns = 0;
    this.options.tools?.clearPending?.();
  }

  /**
   * 将历史与新输入一起发送；同一会话不允许并发调用。
   * @param input 用户文本。
   * @param signal 当前请求的取消信号。
   * @returns 完整模型响应。
   */
  async send(input: string, signal: AbortSignal): Promise<ModelResponse> {
    if (this.busy) { throw new AppError('CONVERSATION_BUSY', '请先等待或取消当前请求。'); }
    signal.throwIfAborted();
    const prompt = input.trim();
    if (prompt.length === 0) { throw new AppError('EMPTY_PROMPT', '请输入非空任务。'); }
    const user: ModelMessage = { role: 'user', content: prompt };
    this.busy = true;
    this.settled = new Promise(resolve => { this.finish = resolve; });
    try {
      const action = /^\/(apply|reject|run) ([a-zA-Z0-9-]+)$/.exec(prompt);
      if (action !== null) {
        const handler = this.options.tools?.action;
        if (handler === undefined) { throw new AppError('TOOL_UNAVAILABLE', '当前模式不支持确认操作。'); }
        const command = action[1] === 'apply' ? 'apply' : action[1] === 'run' ? 'run' : 'reject';
        if (this.blocked && command !== 'reject') { throw new AppError('ACTION_UNCERTAIN', '此前操作结果未知，本会话禁止继续写入和执行；检查实际文件与进程后新建会话。'); }
        this.options.journal?.append({ kind: 'action_begin', data: { input: prompt } });
        for (const listener of this.listeners) { listener({ type: 'tool', name: '用户确认', ok: true, summary: `正在处理 ${prompt}` }); }
        let result: ToolResult;
        try { result = await handler(command, action[2] ?? '', signal); } catch (error) {
          // 已进入确认操作，未返回结果时保守记录未知状态，不能假定操作没有发生。
          if (!(error instanceof Error)) { throw error; }
          result = { ok: false, uncertain: true, content: JSON.stringify({ ok: false, status: 'unknown' }), summary: '确认操作未返回结果，请检查实际文件和进程。' };
        }
        this.history.push(user, { role: 'system', content: `[已确认操作结果] ${result.content}` });
        if (result.uncertain === true) { this.blocked = true; }
        try { this.options.journal?.append({ kind: 'action_end', data: { input: prompt, result, state: { messages: this.history, turns: this.turns, blocked: this.blocked } } }); }
        catch (error) {
          this.blocked = true;
          if (error instanceof Error) { throw new AppError('SESSION_IO', '操作可能已经完成，但结果未能写入日志；请检查实际文件和进程，不能直接重试。'); }
          throw error;
        }
        for (const listener of this.listeners) { listener({ type: 'tool', name: '用户确认', ok: result.ok, summary: result.summary,
          ...(result.preview === undefined ? {} : { preview: result.preview }) }); }
        signal.throwIfAborted();
        if ((!result.ok && result.continueModel !== true) || command === 'reject') { return { text: `[本地操作] ${result.summary}` }; }
      }
      const prefix = action === null ? [...this.history, user] : this.history;
      const { response, delta } = await runAgent(this.provider, this.model, prefix, this.options,
        signal, event => { for (const listener of this.listeners) { listener(event); } });
      signal.throwIfAborted();
      this.history.push(...(action === null ? [user] : []), ...delta); this.turns++;
      this.save();
      return response;
    } finally {
      this.busy = false;
      this.finish?.(); this.finish = undefined;
    }
  }
}
