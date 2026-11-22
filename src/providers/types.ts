/** 第一阶段仅传递文本；工具调用在后续 PR 中扩展。 */
export interface ModelMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

/** provider 接收的协议无关请求。 */
export interface ModelRequest {
  readonly model: string;
  readonly messages: readonly ModelMessage[];
}

/** provider 返回的完整文本；当前不支持流式响应。 */
export interface ModelResponse {
  readonly text: string;
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
