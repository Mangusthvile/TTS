import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import type { JobRecord } from "../../../types";

export type JobRunnerVoice = {
  id: string;
  name?: string;
  provider?: string;
};

export type JobRunnerSettings = {
  [key: string]: any;
};

export type JobRunnerPayload = {
  bookId: string;
  chapterIds: string[];
  voice: JobRunnerVoice;
  settings: JobRunnerSettings;
};

export interface JobRunnerPlugin {
  enqueueGenerateAudio: (options: { payload: JobRunnerPayload }) => Promise<{ jobId: string }>;
  enqueueFixIntegrity: (options: { payload: { bookId: string; driveFolderId?: string; options?: { genAudio?: boolean; cleanupStrays?: boolean; convertLegacy?: boolean } } }) => Promise<{ jobId: string }>;
  enqueueUploadJob: (options?: {}) => Promise<{ jobId: string }>;
  ensureUploadQueueJob: () => Promise<{ jobId: string | null }>;
  checkNotificationPermission: () => Promise<{ supported: boolean; granted: boolean; enabled: boolean }>;
  requestNotificationPermission: () => Promise<{ granted: boolean }>;
  openNotificationSettings: () => Promise<void>;
  sendTestNotification: () => Promise<void>;
  cancelJob: (options: { jobId: string }) => Promise<void>;
  retryJob: (options: { jobId: string }) => Promise<{ jobId: string }>;
  forceStartJob: (options: { jobId: string }) => Promise<void>;
  getWorkInfo: (options: { jobId: string }) => Promise<{ workInfo?: { state: string; runAttemptCount: number } }>;
  deleteJob: (options: { jobId: string }) => Promise<void>;
  clearJobs: (options: { statuses: string[] }) => Promise<void>;
  getJob: (options: { jobId: string }) => Promise<{ job: JobRecord | null }>;
  listJobs: () => Promise<{ jobs: JobRecord[] }>;
  kickUploadQueue: () => Promise<void>;
  getDiagnostics?: () => Promise<{
    hasPlugin?: boolean;
    plugin?: string;
    permission?: "granted" | "denied" | "prompt" | "unknown";
    channels?: string[];
    interfaceMode?: string;
    platform?: string;
    androidBuild?: number;
    notifications?: { permission?: string; enabled?: boolean };
    notes?: string[];
  }>;
  getNotificationDiagnostics?: () => Promise<{
    hasPlugin?: boolean;
    plugin?: string;
    permission?: "granted" | "denied" | "prompt" | "unknown";
    channels?: string[];
    channelExists?: boolean;
    foregroundRecent?: boolean;
    foregroundAgeMs?: number;
  }>;
  addListener: (
    eventName: "jobProgress" | "jobFinished",
    listenerFunc: (event: any) => void
  ) => Promise<PluginListenerHandle>;
  removeAllListeners: () => Promise<void>;
}

export const JobRunner = registerPlugin<JobRunnerPlugin>("JobRunner", {
  web: () => import("./web").then((m) => new m.JobRunnerWeb()),
});
