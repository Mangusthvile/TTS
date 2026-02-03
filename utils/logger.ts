export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogContext = Record<string, any>;
export type LogEntry = {
  ts: number;
  level: LogLevel;
  tag: string;
  message: string;
  context?: LogContext;
};

const tagEnabled = new Map<string, boolean>();
const logBuffer: LogEntry[] = [];
const LOG_BUFFER_SIZE = 200;

export function setLogEnabled(tag: string, enabled: boolean): void {
  tagEnabled.set(tag, enabled);
}

function shouldLog(tag: string, level: LogLevel): boolean {
  if (level === "error" || level === "warn") return true;
  return tagEnabled.get(tag) ?? false;
}

function format(tag: string, message: string): string {
  return `[TaleVox][${tag}] ${message}`;
}

function pushLog(entry: LogEntry): void {
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_SIZE) {
    logBuffer.splice(0, logBuffer.length - LOG_BUFFER_SIZE);
  }
}

function emit(level: LogLevel, tag: string, message: string, context?: LogContext): void {
  if (!shouldLog(tag, level)) return;
  const line = format(tag, message);
  pushLog({ ts: Date.now(), level, tag, message, context });
  if (level === "error") {
    console.error(line, context ?? "");
    return;
  }
  if (level === "warn") {
    console.warn(line, context ?? "");
    return;
  }
  if (level === "debug") {
    console.debug(line, context ?? "");
    return;
  }
  console.log(line, context ?? "");
}

export function getLogger(tag: string) {
  return {
    debug: (message: string, context?: LogContext) => emit("debug", tag, message, context),
    info: (message: string, context?: LogContext) => emit("info", tag, message, context),
    warn: (message: string, context?: LogContext) => emit("warn", tag, message, context),
    error: (message: string, context?: LogContext) => emit("error", tag, message, context),
  };
}

export function getLogBuffer(limit = 20): LogEntry[] {
  if (limit <= 0) return [];
  return logBuffer.slice(-limit);
}

export function clearLogBuffer(): void {
  logBuffer.length = 0;
}

export function createCorrelationId(prefix = "job"): string {
  try {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
      return `${prefix}_${(crypto as any).randomUUID()}`;
    }
  } catch {
    // fall through to fallback
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
