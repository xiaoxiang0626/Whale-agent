/** 用户可以按错误码识别的失败类别。 */
export type ErrorCode = 'INVALID_ARGUMENTS' | 'INVALID_CONFIG' | 'EMPTY_PROMPT';

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
