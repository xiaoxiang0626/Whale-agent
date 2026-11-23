import type { ToolCall, ToolDefinition } from '../providers/types.ts';

/** 工具执行结果；content 是传回模型的 JSON 文本，summary 供界面显示。 */
export interface ToolResult {
  readonly ok: boolean;
  readonly content: string;
  readonly summary: string;
}

/** 当前会话已授予的工具能力。 */
export interface ToolSet {
  readonly workspace: string;
  readonly context: string;
  readonly definitions: readonly ToolDefinition[];
  /** @param call 模型调用。 @param signal 本轮取消信号。 @returns 有界结果，预期失败也作为结果返回。 */
  execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult>;
}

/** 执行进度，不包含文件正文、推理内容或凭据。 */
export type AgentEvent =
  | { readonly type: 'model'; readonly step: number }
  | { readonly type: 'tool'; readonly name: string; readonly ok: boolean; readonly summary: string };
