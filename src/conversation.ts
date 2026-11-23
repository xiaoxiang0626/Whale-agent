import { AppError } from './errors.ts';
import type { ModelMessage, ModelProvider, ModelResponse } from './providers/types.ts';

/** 同一进程内的文本会话；成功问答成对加入历史，失败或取消不改变历史。 */
export class Conversation {
  readonly model: string;
  readonly providerId: string;
  private readonly provider: ModelProvider;
  private readonly history: ModelMessage[] = [];
  private busy = false;

  /** @param provider 模型适配器。 @param model 本会话使用的模型名。 */
  constructor(provider: ModelProvider, model: string) {
    this.provider = provider;
    this.providerId = provider.id;
    this.model = model;
  }

  /** 已成功完成的问答副本；不会随下一轮更新。 */
  get messages(): readonly ModelMessage[] {
    return this.history.map(message => ({ ...message }));
  }

  /** 清空已完成的问答；存在进行中的请求时失败。 */
  clear(): void {
    if (this.busy) { throw new AppError('CONVERSATION_BUSY', '请先等待或取消当前请求。'); }
    this.history.length = 0;
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
      const response = await this.provider.complete({
        model: this.model, messages: [...this.history, user],
      }, signal);
      signal.throwIfAborted();
      this.history.push(user, { role: 'assistant', content: response.text });
      return response;
    } finally {
      this.busy = false;
    }
  }
}
