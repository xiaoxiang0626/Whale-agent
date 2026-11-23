/** 一次模型提出的函数调用；参数仍是待工具解析的 JSON 文本。 */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

/** 文本、助手工具调用和工具结果；reasoningContent 仅用于协议回传。 */
export type ModelMessage =
  | { readonly role: 'system' | 'user'; readonly content: string }
  | { readonly role: 'assistant'; readonly content: string; readonly toolCalls?: readonly ToolCall[]; readonly reasoningContent?: string }
  | { readonly role: 'tool'; readonly content: string; readonly toolCallId: string };

/** 提供给模型的函数及其 JSON Schema 参数。 */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

/** provider 接收的协议无关请求。 */
export interface ModelRequest {
  readonly model: string;
  readonly messages: readonly ModelMessage[];
  readonly tools?: readonly ToolDefinition[];
}

/** provider 返回的文本或工具调用；当前不支持流式响应。 */
export interface ModelResponse {
  readonly text: string;
  readonly toolCalls?: readonly ToolCall[];
  readonly reasoningContent?: string;
}

/** 模型适配器负责协议转换，并遵守调用方的取消信号。 */
export interface ModelProvider {
  readonly id: string;

  /**
   * 完成一次模型调用；失败时抛出错误，不伪造成功响应。
   * @param request 具体模型及消息。
   * @param signal 取消当前调用的信号。
   * @returns 模型生成的完整文本。
   */
  complete(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse>;
}
