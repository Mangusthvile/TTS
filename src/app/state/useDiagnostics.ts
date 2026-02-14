import { useCallback, useEffect, useState } from 'react';
import { collectDiagnostics, saveDiagnosticsToFile, type DiagnosticsReport } from '../../../services/diagnosticsService';
import { getJobRunnerCapability } from '../../../services/jobRunnerService';
import { getLogger } from '../../../utils/logger';

const jobLog = getLogger('Jobs');

export function useDiagnostics(pushNotice: (opts: { message: string; type?: 'info' | 'error' | 'success'; ms?: number }) => void) {
  const [jobRunnerCap, setJobRunnerCap] = useState<{ available: boolean; platform: string; reason?: string } | null>(null);
  const [diagnosticsReport, setDiagnosticsReport] = useState<DiagnosticsReport | null>(null);

  useEffect(() => {
    let mounted = true;
    getJobRunnerCapability().then((cap) => {
      if (mounted) {
        setJobRunnerCap({ available: cap.available, platform: cap.platform, reason: cap.reason });
        jobLog.info('capability', cap);
      }
    });
    return () => { mounted = false; };
  }, []);

  const refreshDiagnostics = useCallback(async () => {
    try {
      const report = await collectDiagnostics();
      setDiagnosticsReport(report);
      return report;
    } catch (e: any) {
      jobLog.error('diagnostics.refreshFailed', e);
      return null;
    }
  }, []);

  const handleSaveDiagnostics = useCallback(async () => {
    const report = diagnosticsReport ?? (await refreshDiagnostics());
    if (!report) {
      pushNotice({ message: 'Failed to generate diagnostics.', type: 'error' });
      return;
    }
    try {
      await saveDiagnosticsToFile(report);
      pushNotice({ message: 'Diagnostics saved.', type: 'success' });
    } catch (e: any) {
      pushNotice({ message: e?.message ?? 'Failed to save diagnostics.', type: 'error' });
    }
  }, [diagnosticsReport, refreshDiagnostics, pushNotice]);

  const jobRunnerAvailable = jobRunnerCap?.available ?? false;

  return {
    diagnosticsReport,
    refreshDiagnostics,
    handleSaveDiagnostics,
    jobRunnerCap,
    jobRunnerAvailable,
  };
}
