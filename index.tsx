import React, { ErrorInfo, ReactNode } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { AlertTriangle, RefreshCw, ClipboardCopy, Loader2 } from 'lucide-react';
import { installGlobalTraceHandlers } from './utils/trace';

// Help TypeScript recognize Vite's injected global
declare const __APP_VERSION__: string;

declare global {
  interface Window {
    __APP_VERSION__: string;
    gapi: any;
    google: any;
    Capacitor: any;
  }
}

// Set version on window for settings display
window.__APP_VERSION__ = '2.9.5';

// Install global trace listeners immediately
installGlobalTraceHandlers();

// --- Type Safety Helpers ---

/**
 * Normalizes string | null | undefined to a strict string | null 
 * to satisfy components that don't accept undefined.
 */
function toNullableString(v: string | null | undefined): string | null {
  return v ?? null;
}

// --- Error Recovery Utilities ---

const FATAL_ERROR_KEY = "talevox_last_fatal_error";

const recordFatalError = (error: any, info?: string) => {
  try {
    const errorData = {
      message: error?.message || String(error),
      stack: error?.stack || "No stack trace",
      info: info || "",
      timestamp: Date.now(),
      version: window.__APP_VERSION__,
      userAgent: navigator.userAgent
    };
    localStorage.setItem(FATAL_ERROR_KEY, JSON.stringify(errorData));
  } catch (e) {
    console.error("Failed to record fatal error to localStorage", e);
  }
};

const attemptHardReload = async () => {
  try {
    // 1. Unregister all service workers
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      for (const registration of registrations) {
        await registration.unregister();
      }
    }
    // 2. Clear all caches
    if ('caches' in window) {
      const cacheNames = await caches.keys();
      for (const name of cacheNames) {
        await caches.delete(name);
      }
    }
  } catch (e) {
    console.error("Cleanup before reload failed", e);
  } finally {
    // 3. Force reload from server
    window.location.reload();
  }
};

// --- Global Handlers for Non-React Errors ---

window.onerror = (message, source, lineno, colno, error) => {
  const msg = String(message);
  // Detect chunk/module load failures (common on mobile cache mismatch)
  if (msg.includes('Loading chunk') || 
      msg.includes('ChunkLoadError') || 
      msg.includes('Failed to fetch dynamically imported module') || 
      msg.includes('Importing a module script failed')) {
    recordFatalError(error || message, "ChunkLoadError Detected");
  } else {
    recordFatalError(error || message, `Global Window Error: ${source}:${lineno}`);
  }
};

window.onunhandledrejection = (event) => {
  recordFatalError(event.reason, "Unhandled Promise Rejection");
};

// --- Error Boundary Component ---

interface Props {
  children?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: string | null;
  isChunkError: boolean;
  isReloading: boolean;
}

class ErrorBoundary extends React.Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
    errorInfo: null,
    isChunkError: false,
    isReloading: false
  };

  public static getDerivedStateFromError(error: Error): Partial<State> {
    const isChunk = error.message.includes('Loading chunk') || 
                    error.message.includes('ChunkLoadError') || 
                    error.message.includes('Failed to fetch dynamically imported module') || 
                    error.message.includes('Importing a module script failed');
    return { hasError: true, error, isChunkError: isChunk };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught error:", error, errorInfo);
    // Normalize undefined to null to satisfy strict string | null typing
    const componentStack = toNullableString(errorInfo.componentStack);
    this.setState({ errorInfo: componentStack });
    recordFatalError(error, `React Component Crash: ${(componentStack || "").substring(0, 200)}`);
  }

  private handleCopy = () => {
    const details = {
      error: this.state.error?.message,
      stack: this.state.error?.stack,
      componentStack: this.state.errorInfo,
      version: window.__APP_VERSION__
    };
    navigator.clipboard.writeText(JSON.stringify(details, null, 2));
    alert("Error details copied to clipboard");
  };

  private handleReload = () => {
    this.setState({ isReloading: true });
    attemptHardReload();
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div className="fixed inset-0 z-[9999] bg-slate-950 text-slate-100 flex items-center justify-center p-6 font-sans">
          <div className="max-w-md w-full space-y-8 animate-in fade-in zoom-in-95 duration-300">
            <div className="flex flex-col items-center text-center space-y-4">
              <div className="p-4 bg-red-500/10 rounded-3xl">
                <AlertTriangle className="w-12 h-12 text-red-500" />
              </div>
              <h1 className="text-2xl font-black tracking-tight">App crashed after sign-in</h1>
              <p className="text-slate-400 text-sm font-medium">
                {this.state.isChunkError 
                  ? "A module failed to load. This usually happens after an update. A clean reload is required."
                  : "An unexpected error occurred. We've recorded the details to help fix this."}
              </p>
            </div>

            <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
              <button 
                onClick={() => {
                  const el = document.getElementById('error-stack');
                  if (el) el.classList.toggle('hidden');
                }}
                className="w-full px-4 py-3 text-left text-[10px] font-black uppercase tracking-widest bg-slate-800/50 flex justify-between items-center"
              >
                Error Details <span>Show/Hide</span>
              </button>
              <div id="error-stack" className="hidden p-4 text-[10px] font-mono text-red-400 overflow-x-auto whitespace-pre-wrap max-h-40 border-t border-slate-800">
                {this.state.error?.toString()}
                {"\n\n"}
                {this.state.error?.stack}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3">
              <button 
                onClick={this.handleReload}
                disabled={this.state.isReloading}
                className="w-full py-4 bg-indigo-600 text-white rounded-2xl font-black uppercase tracking-widest text-xs flex items-center justify-center gap-2 hover:bg-indigo-700 transition-all shadow-xl shadow-indigo-600/20 active:scale-[0.98] disabled:opacity-50"
              >
                {this.state.isReloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                Reload to update
              </button>
              <button 
                onClick={this.handleCopy}
                className="w-full py-4 bg-slate-800 text-slate-100 rounded-2xl font-black uppercase tracking-widest text-xs flex items-center justify-center gap-2 hover:bg-slate-700 transition-all active:scale-[0.98]"
              >
                <ClipboardCopy className="w-4 h-4" />
                Copy error details
              </button>
            </div>
            
            <p className="text-center text-[10px] font-bold text-slate-600 uppercase tracking-tighter">
              TaleVox v{window.__APP_VERSION__}
            </p>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);