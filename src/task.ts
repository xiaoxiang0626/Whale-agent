import { Conversation } from './conversation.ts';
import type { ModelProvider, ModelResponse } from './providers/types.ts';
import type { AgentOptions } from './agent-loop.ts';
import type { AgentEvent } from './tools/types.ts';

/** 一次文本任务的输入。 */
export interface TaskInput {
  readonly model: string;
  readonly prompt: string;
  readonly options?: AgentOptions;
  readonly onEvent?: (event: AgentEvent) => void;
}

/**
 * 创建会话完成一次任务，工具与循环限制由调用方显式传入。
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
  const conversation = new Conversation(provider, input.model, input.options);
  const unsubscribe = input.onEvent === undefined ? undefined : conversation.subscribe(input.onEvent);
  try { return await conversation.send(input.prompt, signal); } finally { unsubscribe?.(); }
}
