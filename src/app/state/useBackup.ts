import { useCallback, useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Filesystem } from '@capacitor/filesystem';
import { AppState, BackupOptions, BackupProgress, BackupTarget } from '../../../types';
import { ensureValidToken } from '../../../services/driveAuth';
import { listBookAttachments } from '../../../services/libraryStore';
import { readProgressStore } from '../../../services/progressStore';
import {
  createFullBackupZip,
  DEFAULT_BACKUP_OPTIONS,
  DEFAULT_BACKUP_SETTINGS,
  listDriveBackupCandidates,
  restoreFromBackupZip,
  restoreFromDriveSave,
  saveBackup,
  type DriveBackupCandidate,
} from '../../../services/backupService';
import { PREFS_KEY } from '../constants';

export function useBackup(opts: {
  stateRef: React.MutableRefObject<AppState>;
  setState: React.Dispatch<React.SetStateAction<AppState>>;
  jobs: any[];
  activeChapterId?: string | null;
  activeTab: "library" | "collection" | "reader" | "rules" | "settings";
  pushNotice: (opts: { message: string; type?: 'info' | 'error' | 'success'; ms?: number }) => void;
  isOnline: boolean;
}) {
  const { stateRef, setState, jobs, activeChapterId, activeTab, pushNotice, isOnline } = opts;
  const [backupOptions, setBackupOptions] = useState<BackupOptions>(DEFAULT_BACKUP_OPTIONS);
  const [backupProgress, setBackupProgress] = useState<BackupProgress | null>(null);
  const [driveBackupCandidates, setDriveBackupCandidates] = useState<DriveBackupCandidate[]>([]);
  const backupBusyRef = useRef(false);

  const collectBackupContext = useCallback(async () => {
    const s = stateRef.current;
    const preferencesRaw = localStorage.getItem(PREFS_KEY);
    const preferences = preferencesRaw ? (JSON.parse(preferencesRaw) as Record<string, unknown>) : {};
    let readerProgress: Record<string, unknown> = {};
    try {
      const raw = localStorage.getItem('talevox_reader_progress');
      if (raw) readerProgress = JSON.parse(raw);
    } catch {
      readerProgress = {};
    }
    const progressStorePayload = readProgressStore();
    const attachmentLists = await Promise.all(
      s.books.map((book) => listBookAttachments(book.id).catch(() => []))
    );
    return {
      state: s,
      preferences,
      readerProgress,
      legacyProgressStore: (progressStorePayload as unknown as Record<string, unknown>) || {},
      attachments: attachmentLists.flat(),
      jobs,
      activeChapterId: activeChapterId ?? undefined,
      activeTab,
    };
  }, [activeChapterId, activeTab, jobs, stateRef]);

  const runBackup = useCallback(async (
    target: BackupTarget,
    cfg?: { nativeMode?: 'prompt' | 'internalOnly' }
  ) => {
    if (backupBusyRef.current) return;
    backupBusyRef.current = true;
    setState((p) => ({ ...p, backupInProgress: true, lastBackupError: undefined }));
    setBackupProgress(null);
    try {
      const ctx = await collectBackupContext();
      const zipBlob = await createFullBackupZip(backupOptions, setBackupProgress, ctx);
      const saveRes = await saveBackup(
        target,
        zipBlob,
        undefined,
        setBackupProgress,
        {
          rootFolderId: stateRef.current.driveRootFolderId,
          keepDriveBackups: stateRef.current.backupSettings?.keepDriveBackups ?? 10,
          keepLocalBackups: stateRef.current.backupSettings?.keepLocalBackups ?? 10,
          nativeMode: cfg?.nativeMode,
        }
      );
      setState((p) => ({
        ...p,
        backupInProgress: false,
        lastBackupAt: Date.now(),
        lastBackupLocation: saveRes.locationLabel,
        lastBackupError: undefined,
      }));
      setBackupProgress({ step: 'finalizing', message: 'Backup complete' });
      pushNotice({ message: `Backup complete: ${saveRes.locationLabel}`, type: 'success' });
    } catch (e: any) {
      const message = String(e?.message ?? e);
      setState((p) => ({
        ...p,
        backupInProgress: false,
        lastBackupError: message,
      }));
      setBackupProgress({ step: 'finalizing', message: `Backup failed: ${message}` });
      pushNotice({ message: `Backup failed: ${message}`, type: 'error', ms: 0 });
    } finally {
      backupBusyRef.current = false;
      setTimeout(() => setBackupProgress(null), 2500);
    }
  }, [backupOptions, collectBackupContext, pushNotice, setState, stateRef]);

  const handleBackupToDriveZip = useCallback(async () => {
    if (!stateRef.current.driveRootFolderId) {
      pushNotice({ message: 'Drive root folder not configured', type: 'error' });
      return;
    }
    await runBackup('drive');
  }, [pushNotice, runBackup, stateRef]);

  const handleBackupToDeviceZip = useCallback(async () => {
    await runBackup(Capacitor.isNativePlatform() ? 'localFolder' : 'download');
  }, [runBackup]);

  const handleRestoreFromFileZip = useCallback(async () => {
    if (backupBusyRef.current) return;
    backupBusyRef.current = true;
    setState((p) => ({ ...p, backupInProgress: true, lastBackupError: undefined }));
    try {
      if (Capacitor.isNativePlatform()) {
        const picker = (Capacitor as any)?.Plugins?.CapacitorFilePicker || (Capacitor as any)?.Plugins?.FilePicker;
        if (!picker?.pickFiles) {
          throw new Error('File picker is not available on this platform.');
        }
        const res = await picker.pickFiles({
          multiple: false,
          types: ['application/zip'],
        });
        const file = res?.files?.[0];
        const uri = file?.path || file?.uri;
        if (!uri) return;
        const read = await Filesystem.readFile({ path: uri });
        let blob: Blob | null = null;
        if (read.data instanceof Blob) {
          blob = read.data;
        } else if (typeof read.data === 'string') {
          const b64 = read.data.includes(',') ? read.data.split(',')[1] : read.data;
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
          blob = new Blob([bytes], { type: 'application/zip' });
        }
        if (!blob) throw new Error('Unable to read backup ZIP.');
        await restoreFromBackupZip(blob, setBackupProgress);
      } else {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.zip,application/zip';
        input.style.display = 'none';
        document.body.appendChild(input);

        const selected = await new Promise<File | null>((resolve) => {
          input.onchange = () => {
            const picked = input.files?.[0] ?? null;
            resolve(picked);
          };
          input.click();
        });
        document.body.removeChild(input);
        if (!selected) return;
        await restoreFromBackupZip(selected, setBackupProgress);
      }
    } catch (e: any) {
      const message = String(e?.message ?? e);
      setState((p) => ({ ...p, backupInProgress: false, lastBackupError: message }));
      pushNotice({ message: `Restore failed: ${message}`, type: 'error', ms: 0 });
    } finally {
      backupBusyRef.current = false;
      setState((p) => ({ ...p, backupInProgress: false }));
    }
  }, [pushNotice, setState]);

  const handleLoadDriveBackupCandidates = useCallback(async () => {
    if (!stateRef.current.driveRootFolderId) {
      pushNotice({ message: 'Drive root folder not configured', type: 'error' });
      return;
    }
    try {
      const items = await listDriveBackupCandidates(stateRef.current.driveRootFolderId);
      setDriveBackupCandidates(items);
      if (!items.length) {
        pushNotice({ message: 'No Drive backup ZIP files found', type: 'info' });
      }
    } catch (e: any) {
      pushNotice({ message: `Failed to list Drive backups: ${String(e?.message ?? e)}`, type: 'error', ms: 0 });
    }
  }, [pushNotice, stateRef]);

  const handleRestoreFromDriveBackup = useCallback(async (fileId: string) => {
    if (!fileId) return;
    if (backupBusyRef.current) return;
    backupBusyRef.current = true;
    setState((p) => ({ ...p, backupInProgress: true, lastBackupError: undefined }));
    try {
      await restoreFromDriveSave(fileId, setBackupProgress);
    } catch (e: any) {
      const message = String(e?.message ?? e);
      setState((p) => ({ ...p, backupInProgress: false, lastBackupError: message }));
      pushNotice({ message: `Drive restore failed: ${message}`, type: 'error', ms: 0 });
    } finally {
      backupBusyRef.current = false;
      setState((p) => ({ ...p, backupInProgress: false }));
    }
  }, [pushNotice, setState]);

  useEffect(() => {
    const settings = stateRef.current.backupSettings || DEFAULT_BACKUP_SETTINGS;
    const shouldAutoDrive = settings.autoBackupToDrive;
    const shouldAutoDevice = settings.autoBackupToDevice;
    if (!shouldAutoDrive && !shouldAutoDevice) return;

    const minutes = Math.max(1, Number(settings.backupIntervalMin) || 30);
    const intervalMs = minutes * 60 * 1000;
    const timer = window.setInterval(() => {
      if (backupBusyRef.current) return;
      void (async () => {
        const current = stateRef.current;
        if (current.backupInProgress) return;

        if (shouldAutoDrive && current.driveRootFolderId && isOnline) {
          try {
            await ensureValidToken(false);
            await runBackup('drive');
            return;
          } catch {
            // Continue to device backup fallback.
          }
        }

        if (shouldAutoDevice && Capacitor.isNativePlatform()) {
          await runBackup('localFolder', { nativeMode: 'internalOnly' });
        }
      })();
    }, intervalMs);

    return () => window.clearInterval(timer);
  }, [isOnline, runBackup, stateRef]);

  return {
    backupOptions,
    setBackupOptions,
    backupProgress,
    driveBackupCandidates,
    handleBackupToDriveZip,
    handleBackupToDeviceZip,
    handleRestoreFromFileZip,
    handleLoadDriveBackupCandidates,
    handleRestoreFromDriveBackup,
    runBackup,
  };
}
