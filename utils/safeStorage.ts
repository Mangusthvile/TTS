import { BACKUP_KEY } from '../src/app/constants';

export const safeSetLocalStorage = (key: string, value: string) => {
  if (value.length > 250000 && (key === BACKUP_KEY || key.includes('backup'))) {
    console.warn(`[SafeStorage] Skipping backup write for ${key} (size ${value.length} > 250kb) to prevent quota issues.`);
    return;
  }
  try {
    localStorage.setItem(key, value);
  } catch (e: any) {
    console.warn(`LocalStorage write failed for key "${key}":`, e.message);
    if (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED') {
      const diagStr = localStorage.getItem('talevox_sync_diag') || '{}';
      try {
        const diag = JSON.parse(diagStr);
        diag.lastSyncError = `Storage Quota Exceeded: ${e.message}`;
        localStorage.setItem('talevox_sync_diag', JSON.stringify(diag));
      } catch (inner) {}
    }
  }
};
