import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

declare global {
  interface Window {
    __APP_VERSION__: string;
    gapi: any;
    google: any;
    Capacitor: any;
  }
}

// Set version on window for settings display
window.__APP_VERSION__ = '2.6.4';

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