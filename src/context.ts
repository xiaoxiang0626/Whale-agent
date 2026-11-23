/** 按完整用户轮次选择模型上下文，完整历史由调用方保留。 */
import { AppError } from './errors.ts';
import type { ModelMessage, ModelRequest } from './providers/types.ts';

/**
 * 将请求 JSON 字符数限制在预算内；当前轮次不拆分，旧轮次从最早开始省略。
 * @param request 未裁剪请求。 @param currentStart 当前用户输入在 messages 中的位置。 @param limit JSON UTF-16 字符预算。
 * @returns 实际请求与省略消息数；当前轮次过大时失败。
 */
export function selectContext(request: ModelRequest, currentStart: number, limit: number): { request: ModelRequest; dropped: number } {
  const system = request.messages[0]?.role === 'system' ? request.messages.slice(0, 1) : [];
  let start = system.length;
  for (;;) {
    const dropped = start - system.length;
    const messages: readonly ModelMessage[] = [...system,
      ...(dropped === 0 ? [] : [{ role: 'system' as const, content: `[上下文裁剪] 已省略最早 ${dropped} 条历史消息；需要旧文件信息时重新读取，不得猜测。` }]),
      ...request.messages.slice(start)];
    const selected = { ...request, messages };
    if (JSON.stringify(selected).length <= limit) { return { request: selected, dropped }; }
    let next = start + 1;
    while (next < currentStart && request.messages[next]?.role !== 'user') { next++; }
    if (start >= currentStart || next > currentStart) { throw new AppError('CONTEXT_LIMIT', '当前轮次超过上下文字符预算，请缩小任务、减少工具输出或提高 --context-chars。'); }
    start = next;
  }
}
