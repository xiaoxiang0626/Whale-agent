import { Conversation } from './conversation.ts';
import type { ModelProvider, ModelResponse } from './providers/types.ts';

/** 一次文本任务的输入。 */
export interface TaskInput {
  readonly model: string;
  readonly prompt: string;
}

/**
 * 把任务转换为一次协议无关模型调用；工具循环在后续 PR 中实现。
 * @param provider 调用方注入的模型适配器。
 * @param input 模型名和用户任务。
 * @param signal 取消信号；错误直接交给调用方处理。
 * @returns 适配器响应。
 */
export async function runTask(
  provider: ModelProvider,
  input: TaskInput,
  signal: AbortSignal,
): Promise<ModelResponse> {
  return new Conversation(provider, input.model).send(input.prompt, signal);
}
