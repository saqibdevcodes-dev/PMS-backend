export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
export function requireState(
  condition: unknown,
  code: string,
  message: string,
  status = 409,
): asserts condition {
  if (!condition) throw new AppError(status, code, message);
}
export function found<T>(value: T | null | undefined): T {
  if (value == null) throw new AppError(404, 'NOT_FOUND', 'The requested record was not found.');
  return value;
}
