import { AppError } from './errors.ts';
import type { ModelMessage, ModelProvider, ModelResponse } from './providers/types.ts';
import { runAgent } from './agent-loop.ts';
import type { AgentOptions } from './agent-loop.ts';
import type { AgentEvent } from './tools/types.ts';

/** 同一进程内的文本会话；成功问答成对加入历史，失败或取消不改变历史。 */
export class Conversation {
  readonly model: string;
  readonly providerId: string;
  private readonly provider: ModelProvider;
  private readonly history: ModelMessage[] = [];
  private busy = false;
  private turns = 0;
  private readonly options: AgentOptions;
  private readonly listeners = new Set<(event: AgentEvent) => void>();

  /** @param provider 模型适配器。 @param model 本会话使用的模型名。 @param options 已授权工具和循环限制。 */
  constructor(provider: ModelProvider, model: string, options: AgentOptions = {}) {
    this.provider = provider;
    this.providerId = provider.id;
    this.model = model;
    this.options = options;
  }

  /** 已成功完成的问答副本；不会随下一轮更新。 */
  get messages(): readonly ModelMessage[] {
    return structuredClone(this.history);
  }

  /** 已成功完成的问答轮数。 */
  get turnCount(): number { return this.turns; }

  /** 工作区绝对路径；没有工具时未定义。 */
  get workspace(): string | undefined { return this.options.tools?.workspace; }

  /** @param listener 同步接收进度，不应抛出异常。 @returns 移除该监听的函数。 */
  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** 清空已完成的问答；存在进行中的请求时失败。 */
  clear(): void {
    if (this.busy) { throw new AppError('CONVERSATION_BUSY', '请先等待或取消当前请求。'); }
    this.history.length = 0;
    this.turns = 0;
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
    try {
      const { response, delta } = await runAgent(this.provider, this.model, [...this.history, user], this.options,
        signal, event => { for (const listener of this.listeners) { listener(event); } });
      signal.throwIfAborted();
      this.history.push(user, ...delta); this.turns++;
      return response;
    } finally {
      this.busy = false;
    }
  }
}
