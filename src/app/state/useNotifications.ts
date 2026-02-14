import { useCallback, useEffect, useState } from 'react';
import { JobRunner } from '../../plugins/jobRunner';
import { getLogger } from '../../../utils/logger';

const jobLog = getLogger('Jobs');

type NotificationStatus = { supported: boolean; granted: boolean; enabled: boolean } | null;

export function useNotifications(
  jobRunnerAvailable: boolean,
  logJobs: boolean,
  pushNotice: (opts: { message: string; type?: 'info' | 'error' | 'success'; ms?: number }) => void
) {
  const [notificationStatus, setNotificationStatus] = useState<NotificationStatus>(null);

  const refreshNotificationStatus = useCallback(async () => {
    try {
      if (!jobRunnerAvailable) {
        setNotificationStatus({ supported: false, granted: false, enabled: false });
        return;
      }
      const res = await JobRunner.checkNotificationPermission();
      setNotificationStatus(res);
      jobLog.info('notifications.status', res);
    } catch {
      setNotificationStatus(null);
    }
  }, [logJobs, jobRunnerAvailable]);

  useEffect(() => {
    refreshNotificationStatus();
  }, [refreshNotificationStatus]);

  const handleRequestNotifications = useCallback(async () => {
    try {
      if (!jobRunnerAvailable) {
        pushNotice({ message: 'Notifications are unavailable on this device.', type: 'error' });
        return;
      }
      await JobRunner.requestNotificationPermission();
      await refreshNotificationStatus();
      pushNotice({ message: 'Notification permissions updated.', type: 'success' });
    } catch (e: any) {
      pushNotice({ message: e?.message ?? 'Failed to request notifications.', type: 'error' });
    }
  }, [refreshNotificationStatus, pushNotice, jobRunnerAvailable]);

  const handleOpenNotificationSettings = useCallback(async () => {
    try {
      if (!jobRunnerAvailable) {
        pushNotice({ message: 'Notifications are unavailable on this device.', type: 'error' });
        return;
      }
      await JobRunner.openNotificationSettings();
    } catch (e: any) {
      pushNotice({ message: e?.message ?? 'Unable to open notification settings.', type: 'error' });
    }
  }, [jobRunnerAvailable, pushNotice]);

  const handleSendTestNotification = useCallback(async () => {
    try {
      if (!jobRunnerAvailable) {
        pushNotice({ message: 'Notifications are unavailable on this device.', type: 'error' });
        return;
      }
      await JobRunner.sendTestNotification();
      pushNotice({ message: 'Test notification sent.', type: 'success' });
    } catch (e: any) {
      pushNotice({ message: e?.message ?? 'Failed to send test notification.', type: 'error' });
    }
  }, [jobRunnerAvailable, pushNotice]);

  return {
    notificationStatus,
    refreshNotificationStatus,
    handleRequestNotifications,
    handleOpenNotificationSettings,
    handleSendTestNotification,
  };
}
