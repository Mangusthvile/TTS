import { WebPlugin } from "@capacitor/core";
import type { JobRecord } from "../../../types";
import type { JobRunnerPayload, JobRunnerPlugin } from "./index";
import { createJob, updateJob, getJob, listJobs, deleteJob, clearJobs } from "../../../services/jobStore";

function createJobId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return (crypto as any).randomUUID();
  }
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export class JobRunnerWeb extends WebPlugin implements JobRunnerPlugin {
  async enqueueGenerateAudio(options: { payload: JobRunnerPayload }): Promise<{ jobId: string }> {
    const jobId = createJobId();
    const now = Date.now();
    const total = options.payload.chapterIds?.length ?? 0;

    const job: JobRecord = {
      jobId,
      type: "generateAudio",
      status: "queued",
      payloadJson: options.payload,
      progressJson: { total, completed: 0 },
      createdAt: now,
      updatedAt: now,
    };

    await createJob(job);
    return { jobId };
  }

  async enqueueFixIntegrity(options: { payload: { bookId: string; driveFolderId?: string; options?: { genAudio?: boolean; cleanupStrays?: boolean; convertLegacy?: boolean } } }): Promise<{ jobId: string }> {
    const jobId = createJobId();
    const now = Date.now();

    const job: JobRecord = {
      jobId,
      type: "fixIntegrity",
      status: "queued",
      payloadJson: options.payload,
      progressJson: { total: 0, completed: 0 },
      createdAt: now,
      updatedAt: now,
    };

    await createJob(job);
    return { jobId };
  }

  async enqueueUploadJob(): Promise<{ jobId: string }> {
    const jobId = createJobId();
    const now = Date.now();
    const total = 0;
    const job: JobRecord = {
      jobId,
      type: "drive_upload_queue",
      status: "queued",
      payloadJson: {},
      progressJson: { total, completed: 0 },
      createdAt: now,
      updatedAt: now,
    };
    await createJob(job);
    return { jobId };
  }

  async ensureUploadQueueJob(): Promise<{ jobId: string | null }> {
    return { jobId: null };
  }

  async checkNotificationPermission(): Promise<{ supported: boolean; granted: boolean; enabled: boolean }> {
    return { supported: false, granted: true, enabled: true };
  }

  async getDiagnostics(): Promise<any> {
    return { hasPlugin: false, permission: "unknown", channels: [] };
  }

  async getNotificationDiagnostics(): Promise<any> {
    return { hasPlugin: false, permission: "unknown", channels: [] };
  }

  async requestNotificationPermission(): Promise<{ granted: boolean }> {
    return { granted: true };
  }

  async openNotificationSettings(): Promise<void> {
    return;
  }

  async sendTestNotification(): Promise<void> {
    return;
  }

  async cancelJob(options: { jobId: string }): Promise<void> {
    await updateJob(options.jobId, { status: "canceled", updatedAt: Date.now() });
  }

  async retryJob(options: { jobId: string }): Promise<{ jobId: string }> {
    await updateJob(options.jobId, {
      status: "queued",
      error: undefined,
      updatedAt: Date.now(),
    });
    return { jobId: options.jobId };
  }

  async forceStartJob(options: { jobId: string }): Promise<void> {
    await updateJob(options.jobId, {
      status: "queued",
      updatedAt: Date.now(),
    });
  }

  async getWorkInfo(): Promise<{ workInfo?: { state: string; runAttemptCount: number } }> {
    return { workInfo: { state: "unsupported", runAttemptCount: 0 } };
  }

  async deleteJob(options: { jobId: string }): Promise<void> {
    await deleteJob(options.jobId);
  }

  async clearJobs(options: { statuses: string[] }): Promise<void> {
    await clearJobs(options.statuses);
  }

  async getJob(options: { jobId: string }): Promise<{ job: JobRecord | null }> {
    const job = await getJob(options.jobId);
    return { job };
  }

  async listJobs(): Promise<{ jobs: JobRecord[] }> {
    const jobs = await listJobs();
    return { jobs };
  }

  async kickUploadQueue(): Promise<void> {
    return;
  }
}
