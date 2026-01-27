import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import type { JobRecord } from "../../types";

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
  cancelJob: (options: { jobId: string }) => Promise<void>;
  retryJob: (options: { jobId: string }) => Promise<{ jobId: string }>;
  getJob: (options: { jobId: string }) => Promise<{ job: JobRecord | null }>;
  listJobs: () => Promise<{ jobs: JobRecord[] }>;
  addListener: (
    eventName: "jobProgress" | "jobFinished",
    listenerFunc: (event: any) => void
  ) => Promise<PluginListenerHandle>;
  removeAllListeners: () => Promise<void>;
}

export const JobRunner = registerPlugin<JobRunnerPlugin>("JobRunner", {
  web: () => import("./web").then((m) => new m.JobRunnerWeb()),
});
