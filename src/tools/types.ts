import type { ToolCall, ToolDefinition } from '../providers/types.ts';

/** 工具执行结果；content 是传回模型的 JSON 文本，summary 供界面显示。 */
export interface ToolResult {
  readonly ok: boolean;
  readonly content: string;
  readonly summary: string;
  readonly preview?: string;
}

/** 当前会话已授予的工具能力。 */
export interface ToolSet {
  readonly workspace: string;
  readonly context: string;
  readonly definitions: readonly ToolDefinition[];
  /** @param call 模型调用。 @param signal 本轮取消信号。 @returns 有界结果，预期失败也作为结果返回。 */
  execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult>;
  /** @param command 用户确认或拒绝命令。 @param id 预览编号。 @param signal 取消信号。 @returns 操作的实际结果。 */
  action?(command: 'apply' | 'reject', id: string, signal: AbortSignal): Promise<ToolResult>;
  /** 丢弃尚未确认的修改。 */
  clearPending?(): void;
}

/** 执行进度；preview 为用户明确需要审阅的 diff，其他字段不包含文件正文或模型推理。 */
export type AgentEvent =
  | { readonly type: 'model'; readonly step: number }
  | { readonly type: 'tool'; readonly name: string; readonly ok: boolean; readonly summary: string; readonly preview?: string };
