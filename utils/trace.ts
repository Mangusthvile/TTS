
export interface TraceEntry {
  ts: number;
  scope: string;
  data?: any;
  level: 'info' | 'warn' | 'error';
}

const BUFFER_SIZE = 300;
const traceBuffer: TraceEntry[] = [];

export function trace(scope: string, data?: any, level: 'info' | 'warn' | 'error' = 'info') {
  const entry: TraceEntry = { ts: Date.now(), scope, data, level };
  traceBuffer.push(entry);
  if (traceBuffer.length > BUFFER_SIZE) traceBuffer.shift();

  const msg = `[TaleVox] ${scope}`;
  if (level === 'error') console.error(msg, data);
  else if (level === 'warn') console.warn(msg, data);
  else console.log(msg, data || '');
}

export function traceError(scope: string, err: any, extra?: any) {
  const info = {
    message: err?.message || String(err),
    name: err?.name,
    stack: err?.stack,
    cause: err?.cause,
    ...extra
  };
  trace(scope, info, 'error');
}

export function getTraceDump() {
  return JSON.stringify(traceBuffer, null, 2);
}

export function installGlobalTraceHandlers() {
  window.addEventListener('error', (e) => traceError('global:error', e.error));
  window.addEventListener('unhandledrejection', (e) => traceError('global:unhandledrejection', e.reason));
  (window as any).__TALEVOX_TRACE_DUMP__ = getTraceDump;
}
