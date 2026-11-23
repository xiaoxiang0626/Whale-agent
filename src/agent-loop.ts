import { AppError } from './errors.ts';
import type { ModelMessage, ModelProvider, ModelResponse } from './providers/types.ts';
import type { AgentEvent, ToolSet } from './tools/types.ts';

/** 一次会话运行所需的已授权能力与循环上限。 */
export interface AgentOptions {
  readonly tools?: ToolSet;
  readonly maxSteps?: number;
}

/**
 * 循环请求模型并串行执行工具，最终文本返回时交付完整消息增量。
 * @param provider 模型适配器。 @param model 模型名。 @param messages 此前历史与当前用户输入。
 * @param options 工具与模型请求次数上限。 @param signal 取消信号。 @param emit 显示进度的监听方。
 * @returns 最终响应和本轮新增消息；异常时调用方保留此前历史。
 */
export async function runAgent(provider: ModelProvider, model: string, messages: readonly ModelMessage[], options: AgentOptions,
  signal: AbortSignal, emit: (event: AgentEvent) => void): Promise<{ response: ModelResponse; delta: readonly ModelMessage[] }> {
  const delta: ModelMessage[] = [];
  const ids = new Set<string>();
  let calls = 0;
  for (let step = 1; step <= (options.maxSteps ?? 12); step++) {
    signal.throwIfAborted(); emit({ type: 'model', step });
    const response = await provider.complete({ model,
      messages: [...(options.tools === undefined ? [] : [{ role: 'system' as const, content: options.tools.context }]), ...messages, ...delta],
      ...(options.tools === undefined ? {} : { tools: options.tools.definitions }),
    }, signal);
    signal.throwIfAborted();
    delta.push({ role: 'assistant', content: response.text,
      ...(response.reasoningContent === undefined ? {} : { reasoningContent: response.reasoningContent }),
      ...(response.toolCalls === undefined ? {} : { toolCalls: response.toolCalls }),
    });
    if (response.toolCalls === undefined || response.toolCalls.length === 0) {
      if (response.text.trim().length === 0) { throw new AppError('INVALID_RESPONSE', '模型没有返回有效的最终回答。'); }
      return { response, delta };
    }
    if (options.tools === undefined) { throw new AppError('TOOL_UNAVAILABLE', '本会话未启用工具。'); }
    if (calls + response.toolCalls.length > 32) { throw new AppError('AGENT_LIMIT', '本轮工具调用超过 32 次上限。'); }
    for (const call of response.toolCalls) {
      if (ids.has(call.id)) { throw new AppError('INVALID_RESPONSE', '模型重复使用了本轮工具调用 ID。'); }
      ids.add(call.id);
    }
    if (step === (options.maxSteps ?? 12)) { break; }
    for (const call of response.toolCalls) {
      signal.throwIfAborted();
      const result = await options.tools.execute(call, signal);
      signal.throwIfAborted(); calls++;
      delta.push({ role: 'tool', toolCallId: call.id, content: result.content });
      emit({ type: 'tool', name: call.name, ok: result.ok, summary: result.summary,
        ...(result.preview === undefined ? {} : { preview: result.preview }) });
    }
  }
  throw new AppError('AGENT_LIMIT', '已达到本轮模型请求次数上限，可提高 --max-steps 或缩小任务范围。');
}
