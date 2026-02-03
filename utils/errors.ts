export type ErrorContext = Record<string, any>;

export class TaleVoxError extends Error {
  code: string;
  context?: ErrorContext;
  cause?: unknown;

  constructor(code: string, message: string, context?: ErrorContext, cause?: unknown) {
    super(message);
    this.name = code;
    this.code = code;
    this.context = context;
    this.cause = cause;
  }
}

export class DbNotOpenError extends TaleVoxError {
  constructor(dbName: string, operation: string, cause?: unknown) {
    super("DbNotOpenError", `Database "${dbName}" not opened`, { dbName, operation }, cause);
  }
}

export class SyncError extends TaleVoxError {
  constructor(message: string, context?: ErrorContext, cause?: unknown) {
    super("SyncError", message, context, cause);
  }
}

export class MissingTextError extends TaleVoxError {
  constructor(chapterId: string, bookId?: string, context?: ErrorContext, cause?: unknown) {
    super(
      "MissingTextError",
      "Chapter text missing. Run Fix Integrity.",
      { chapterId, bookId, ...context },
      cause
    );
  }
}

export class MissingBookError extends TaleVoxError {
  constructor(bookId: string, context?: ErrorContext, cause?: unknown) {
    super("MissingBookError", "Book not found. Re-sync library.", { bookId, ...context }, cause);
  }
}

export function toUserMessage(err: unknown): string {
  if (err instanceof TaleVoxError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
