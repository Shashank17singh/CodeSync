export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message)
  }
}

export const notFound = (what = 'Resource'): ApiError =>
  new ApiError(404, 'not_found', `${what} not found`)

export const forbidden = (message = 'You do not have permission to do this'): ApiError =>
  new ApiError(403, 'forbidden', message)

export const conflict = (code: string, message: string): ApiError =>
  new ApiError(409, code, message)

export const invalid = (code: string, message: string): ApiError =>
  new ApiError(422, code, message)

export function assertExecutionEnabled(config: { executionEnabled: boolean }): void {
  if (config.executionEnabled) return
  throw new ApiError(503, 'execution_disabled', 'Running code is turned off on this deployment')
}
