import { UiMode } from '../types';

export function isTouchDevice(): boolean {
  if (typeof window === 'undefined') return false;
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}

export function isIOS(): boolean {
  if (typeof window === 'undefined') return false;
  return /Tb(ad|ablet)|iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as any).MSStream;
}

export function detectMobileByEnvironment(): boolean {
  if (typeof window === 'undefined') return false;
  return (isTouchDevice() && window.innerWidth < 1024);
}

export function computeMobileMode(uiMode: UiMode): boolean {
  if (uiMode === 'mobile') return true;
  if (uiMode === 'desktop') return false;
  return detectMobileByEnvironment();
}

/**
 * Legacy check, defaults to environment detection.
 * Prefer passing explicit state derived from computeMobileMode where possible.
 */
export function isMobileMode(): boolean {
  return detectMobileByEnvironment();
}
