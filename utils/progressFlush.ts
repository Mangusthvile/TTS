/**
 * Central registry for flushing progress state on page unload (web) or app background (native).
 * Ensures debounced progress is written before the app is killed (e.g. hard refresh, tab close).
 */

type FlushFn = () => void;

const flushHandlers = new Set<FlushFn>();

export function registerBeforeUnloadFlush(fn: FlushFn): () => void {
  flushHandlers.add(fn);
  return () => {
    flushHandlers.delete(fn);
  };
}

export function runAllProgressFlushes(): void {
  for (const fn of flushHandlers) {
    try {
      fn();
    } catch (e) {
      console.warn("[progressFlush] Handler error:", e);
    }
  }
}
