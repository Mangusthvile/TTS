export interface TraceEntry {
  ts: number;
  scope: string;
  data?: any;
  level: "info" | "warn" | "error";
}

const BUFFER_SIZE = 300;
const traceBuffer: TraceEntry[] = [];

/** Serialize for console so Capacitor/Android shows readable text instead of [object Object]. */
function serializeForConsole(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Error) {
    return `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ""}`;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function trace(scope: string, data?: any, level: "info" | "warn" | "error" = "info") {
  const entry: TraceEntry = { ts: Date.now(), scope, data, level };
  traceBuffer.push(entry);
  if (traceBuffer.length > BUFFER_SIZE) traceBuffer.shift();

  const msg = `[TaleVox] ${scope}`;
  const out = data !== undefined && data !== null ? serializeForConsole(data) : "";
  if (level === "error") console.error(out ? `${msg} ${out}` : msg);
  else if (level === "warn") console.warn(out ? `${msg} ${out}` : msg);
  else console.log(msg, out || "");
}

export function traceError(scope: string, err: any, extra?: any) {
  const message = err?.message ?? String(err);
  const info = {
    message,
    name: err?.name,
    stack: err?.stack,
    cause: err?.cause,
    ...extra,
  };
  trace(scope, info, "error");
}

export function getTraceDump() {
  return JSON.stringify(traceBuffer, null, 2);
}

export function installGlobalTraceHandlers() {
  window.addEventListener("error", (e) => traceError("global:error", e.error));
  window.addEventListener("unhandledrejection", (e) =>
    traceError("global:unhandledrejection", e.reason)
  );
  (window as any).__TALEVOX_TRACE_DUMP__ = getTraceDump;
}
