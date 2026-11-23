/** 用户可以按错误码识别的失败类别。 */
export type ErrorCode =
  | 'INVALID_ARGUMENTS' | 'INVALID_CONFIG' | 'EMPTY_PROMPT'
  | 'AUTHENTICATION_FAILED' | 'RATE_LIMITED' | 'API_ERROR'
  | 'NETWORK_ERROR' | 'REQUEST_TIMEOUT' | 'INVALID_RESPONSE' | 'CONVERSATION_BUSY'
  | 'AGENT_LIMIT' | 'TOOL_UNAVAILABLE';

/** 适合直接展示给 CLI 用户的错误，不携带凭据或完整模型请求。 */
export class AppError extends Error {
  readonly code: ErrorCode;

  /** @param code 稳定错误码。 @param message 可直接显示的错误说明。 */
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'AppError';
    this.code = code;
  }
}

/**
 * 将失败转换为可直接展示的文本，不回显任意底层异常。
 * @param error 任务或交互期间的失败。
 * @returns 用户可读的诊断。
 */
export function formatError(error: unknown): string {
  return error instanceof AppError ? `[${error.code}] ${error.message}` : '任务失败，未获得有效响应。';
}
