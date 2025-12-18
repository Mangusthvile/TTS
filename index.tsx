import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

declare const __APP_VERSION__: string;

declare global {
  interface Window {
    __APP_VERSION__: string;
  }
  // Removed the 'var process' declaration because it conflicts with existing 
  // block-scoped definitions of 'process' in the global scope. 
  // The environment (e.g., Vite shim or index.html) provides this variable.
}

// Set version on window for settings display
window.__APP_VERSION__ = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
