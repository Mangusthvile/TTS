import type { JobProgress, JobRecord, JobStatus, UiMode } from "../types";
import { computeMobileMode } from "../utils/platform";
import { Capacitor } from "@capacitor/core";
import { JobRunner } from "../src/plugins/jobRunner";
import { ensureValidToken, getAuthSessionInfo } from "./driveAuth";
import type { JobRunnerPayload } from "../src/plugins/jobRunner";
import {
  createJob,
  updateJob,
  getJob,
  listJobs,
  deleteJob as deleteJobLocal,
  clearJobs as clearJobsLocal,
} from "./jobStore";
import { getLogger } from "../utils/logger";
import { SyncError } from "../utils/errors";
import { appConfig } from "../src/config/appConfig";
import { createCloudBatchJob, getCloudBatchJob, cancelCloudBatchJob } from "./cloudBatchApi";
import { initStorage } from "./storageSingleton";

type InterfaceMode = "mobile" | "desktop";
export type JobRunnerCapability = {
  available: boolean;
  platform: string;
  reason?: string;
  diagnostics?: any;
};

let capabilityPromise: Promise<JobRunnerCapability> | null = null;
const jobLog = getLogger("Jobs");

export async function getJobRunnerCapability(): Promise<JobRunnerCapability> {
  if (capabilityPromise) return capabilityPromise;
  capabilityPromise = (async () => {
    const platform = Capacitor.getPlatform?.() ?? "web";
    const isNative = Capacitor.isNativePlatform?.() ?? false;
    if (!isNative) {
      return { available: false, platform, reason: "not-native" };
    }
    try {
      let diag: any = null;
      try {
        diag = await JobRunner.getDiagnostics();
      } catch (e) {
        if (JobRunner.getNotificationDiagnostics) {
          diag = await JobRunner.getNotificationDiagnostics();
        } else {
          throw e;
        }
      }
      const hasPlugin = diag?.hasPlugin;
      if (hasPlugin === false) {
        return { available: false, platform, reason: "plugin-not-registered", diagnostics: diag };
      }
      return { available: true, platform, diagnostics: diag };
    } catch (e: any) {
      return {
        available: false,
        platform,
        reason: "probe-failed",
        diagnostics: String(e?.message ?? e),
      };
    }
  })().finally(() => {
    // keep cached
  });
  return capabilityPromise;
}

function getInterfaceMode(uiMode: UiMode): InterfaceMode {
  return computeMobileMode(uiMode) ? "mobile" : "desktop";
}

/** Refresh Drive token before enqueueing so native workers read a valid token from kv storage. */
async function refreshTokenBeforeDriveJob(): Promise<void> {
  if (!Capacitor.isNativePlatform?.()) return;
  try {
    const token = await ensureValidToken(false);
    const session = getAuthSessionInfo();
    const expiresAt =
      session.expiresAt > Date.now() ? session.expiresAt : Date.now() + 55 * 60 * 1000;
    const driver = await initStorage();
    const saved = await driver.saveAuthSession({
      accessToken: token,
      expiresAt,
      status: "signed_in",
    });
    if (!saved.ok) {
      throw new Error(saved.error || "Failed to persist auth session for native worker");
    }
  } catch (e) {
    jobLog.warn("refreshTokenBeforeDriveJob failed", { err: String((e as any)?.message ?? e) });
    throw e;
  }
}

export async function jobRunnerHealthCheck(uiMode: UiMode): Promise<void> {
  if (!computeMobileMode(uiMode)) return;
  try {
    const cap = await getJobRunnerCapability();
    jobLog.info("capability", cap);
  } catch (e) {
    jobLog.warn("health check failed", { err: String((e as any)?.message ?? e) });
  }
}

function createJobId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return (crypto as any).randomUUID();
  }
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function enqueueGenerateAudio(
  payload: JobRunnerPayload,
  uiMode: UiMode
): Promise<{ jobId: string }> {
  if (!payload?.bookId || !Array.isArray(payload.chapterIds) || payload.chapterIds.length === 0) {
    throw new SyncError("Invalid job payload", { operation: "enqueueGenerateAudio", payload });
  }
  const interfaceMode = getInterfaceMode(uiMode);
  if (interfaceMode === "mobile") {
    if (payload.driveFolderId) {
      await refreshTokenBeforeDriveJob();
    }
    try {
      const batchSize = appConfig.jobs.audioBatchSize ?? 5;
      const payloadWithBatch = { ...payload, batchSize };
      const res = await JobRunner.enqueueGenerateAudio({ payload: payloadWithBatch });
      jobLog.info("enqueueGenerateAudio", { ...res, correlationId: payload.correlationId });
      return res;
    } catch (e: any) {
      const errMsg = String(e?.message ?? e);
      jobLog.error("enqueueGenerateAudio failed", { err: errMsg, payload });
      if (errMsg.includes("notifications_not_granted")) {
        throw new SyncError(
          "notifications_not_granted",
          { operation: "enqueueGenerateAudio", payload },
          e
        );
      }
      throw new SyncError(
        "Failed to enqueue job",
        { operation: "enqueueGenerateAudio", payload },
        e
      );
    }
  }

  const jobId = createJobId();
  const now = Date.now();
  const total = payload.chapterIds?.length ?? 0;

  const job: JobRecord = {
    jobId,
    type: "generateAudio",
    status: "queued",
    payloadJson: payload,
    progressJson: { total, completed: 0 },
    createdAt: now,
    updatedAt: now,
  };

  await createJob(job);
  return { jobId };
}

export async function enqueueCloudGenerateBookAudio(
  payload: JobRunnerPayload,
  uiMode: UiMode,
  opts?: { userId?: string; driveRootFolderId?: string }
): Promise<{ jobId: string; cloudJobId: string }> {
  if (!payload?.bookId || !Array.isArray(payload.chapterIds) || payload.chapterIds.length === 0) {
    throw new SyncError("Invalid job payload", {
      operation: "enqueueCloudGenerateBookAudio",
      payload,
    });
  }
  const interfaceMode = getInterfaceMode(uiMode);
  if (interfaceMode !== "mobile") {
    throw new SyncError("Cloud batch generation is only supported on mobile", {
      operation: "enqueueCloudGenerateBookAudio",
      payload,
    });
  }
  const hasEndpoint =
    !!appConfig.cloud?.batchJobsEndpoint ||
    !!(import.meta as any)?.env?.VITE_TALEVOX_BATCH_JOBS_ENDPOINT ||
    !!(import.meta as any)?.env?.VITE_BATCH_JOBS_ENDPOINT;
  if (!hasEndpoint) {
    throw new SyncError("Batch jobs endpoint is not configured", {
      operation: "enqueueCloudGenerateBookAudio",
    });
  }

  const total = payload.chapterIds?.length ?? 0;
  const now = Date.now();
  const session = getAuthSessionInfo();
  const userId = opts?.userId ?? session.userEmail ?? "anonymous";

  const cloudReq = {
    userId,
    bookId: payload.bookId,
    chapterIds: payload.chapterIds,
    voice: { id: payload.voice.id, provider: payload.voice.provider },
    settings: payload.settings,
    driveRootFolderId: opts?.driveRootFolderId,
    driveBookFolderId: payload.driveFolderId,
  };

  try {
    const cloudRes = await createCloudBatchJob(cloudReq);
    const jobId = createJobId();
    const job: JobRecord = {
      jobId,
      type: "generate_book_audio",
      status: cloudRes.status as JobStatus,
      payloadJson: {
        ...payload,
        cloudJobId: cloudRes.jobId,
        backend: "cloud",
      },
      progressJson: { total, completed: 0 },
      createdAt: now,
      updatedAt: now,
    };
    await createJob(job);
    jobLog.info("enqueueCloudGenerateBookAudio", {
      jobId,
      cloudJobId: cloudRes.jobId,
      bookId: payload.bookId,
      chapters: total,
    });
    return { jobId, cloudJobId: cloudRes.jobId };
  } catch (e: any) {
    const errMsg = String(e?.message ?? e);
    jobLog.error("enqueueCloudGenerateBookAudio failed", { err: errMsg, payload: cloudReq });
    throw new SyncError(
      "Failed to enqueue cloud batch job",
      { operation: "enqueueCloudGenerateBookAudio", payload: cloudReq },
      e
    );
  }
}

export async function startBookGenerationJob(
  payload: JobRunnerPayload,
  uiMode: UiMode
): Promise<{ jobId: string }> {
  if (!payload?.bookId || !Array.isArray(payload.chapterIds) || payload.chapterIds.length === 0) {
    throw new SyncError("Invalid job payload", { operation: "startBookGenerationJob", payload });
  }
  const interfaceMode = getInterfaceMode(uiMode);
  if (interfaceMode === "mobile") {
    if (payload.driveFolderId) {
      await refreshTokenBeforeDriveJob();
    }
    try {
      const batchSize = appConfig.jobs.audioBatchSize ?? 5;
      const payloadWithBatch = { ...payload, batchSize };
      const res = await JobRunner.enqueueGenerateBookAudio({ payload: payloadWithBatch });
      jobLog.info("startBookGenerationJob", { ...res, correlationId: payload.correlationId });
      return res;
    } catch (e: any) {
      const errMsg = String(e?.message ?? e);
      jobLog.error("startBookGenerationJob failed", { err: errMsg, payload });
      if (errMsg.includes("notifications_not_granted")) {
        throw new SyncError(
          "notifications_not_granted",
          { operation: "startBookGenerationJob", payload },
          e
        );
      }
      throw new SyncError(
        "Failed to enqueue book generation job",
        { operation: "startBookGenerationJob", payload },
        e
      );
    }
  }

  const jobId = createJobId();
  const now = Date.now();
  const total = payload.chapterIds?.length ?? 0;

  const job: JobRecord = {
    jobId,
    type: "generate_book_audio",
    status: "queued",
    payloadJson: payload,
    progressJson: { total, completed: 0 },
    createdAt: now,
    updatedAt: now,
  };

  await createJob(job);
  return { jobId };
}

/** Round-robin index for syncing one cloud job per refresh to cap HTTP calls. */
let syncCloudBackedRefreshCount = 0;

export async function syncCloudBackedJobs(
  jobs: JobRecord[],
  uiMode: UiMode
): Promise<JobRecord[]> {
  const interfaceMode = getInterfaceMode(uiMode);
  if (interfaceMode !== "mobile") return jobs;
  const hasEndpoint =
    !!appConfig.cloud?.batchJobsEndpoint ||
    !!(import.meta as any)?.env?.VITE_TALEVOX_BATCH_JOBS_ENDPOINT ||
    !!(import.meta as any)?.env?.VITE_BATCH_JOBS_ENDPOINT;
  if (!hasEndpoint) return jobs;

  const cloudIndices: number[] = [];
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const payload = (job as any)?.payloadJson ?? {};
    const cloudJobId = typeof payload?.cloudJobId === "string" ? payload.cloudJobId : "";
    const backend = String(payload?.backend ?? "");
    if (job.type === "generate_book_audio" && backend === "cloud" && cloudJobId) {
      cloudIndices.push(i);
    }
  }
  if (cloudIndices.length === 0) return jobs;

  syncCloudBackedRefreshCount += 1;
  const roundRobinIndex = syncCloudBackedRefreshCount % cloudIndices.length;
  const i = cloudIndices[roundRobinIndex];
  const job = jobs[i];
  const payload = (job as any)?.payloadJson ?? {};
  const cloudJobId = typeof payload?.cloudJobId === "string" ? payload.cloudJobId : "";

  const updatedJobs = [...jobs];
  try {
    const remote = await getCloudBatchJob(cloudJobId);
    const status = remote.status as JobStatus;
    const progress: JobProgress = remote.progress ?? {
      total: remote.totalChapters,
      completed: remote.completedChapters,
      currentChapterId: remote.lastChapterId,
    };
    const patch: Partial<Omit<JobRecord, "jobId" | "createdAt">> = {
      status,
      progressJson: progress,
      updatedAt: remote.updatedAt || Date.now(),
    };
    await updateJob(job.jobId, patch);
    updatedJobs[i] = {
      ...job,
      status,
      progressJson: progress,
      updatedAt: patch.updatedAt ?? job.updatedAt,
    };
  } catch (e: any) {
    const errMsg = String(e?.message ?? e);
    jobLog.warn("syncCloudBackedJobs failed", { jobId: job.jobId, err: errMsg });
  }
  return updatedJobs;
}

export async function enqueueFixIntegrity(
  payload: {
    bookId: string;
    driveFolderId?: string;
    options?: { genAudio?: boolean; cleanupStrays?: boolean; convertLegacy?: boolean };
    voice?: { id: string; name?: string; provider?: string };
    settings?: Record<string, any>;
  },
  uiMode: UiMode
): Promise<{ jobId: string }> {
  const interfaceMode = getInterfaceMode(uiMode);
  if (interfaceMode === "mobile") {
    if (payload.driveFolderId) {
      await refreshTokenBeforeDriveJob();
    }
    const res = await JobRunner.enqueueFixIntegrity({ payload });
    jobLog.info("enqueueFixIntegrity", res);
    return res;
  }

  const jobId = createJobId();
  const now = Date.now();
  const job: JobRecord = {
    jobId,
    type: "fixIntegrity",
    status: "queued",
    payloadJson: payload,
    progressJson: { total: 0, completed: 0 },
    createdAt: now,
    updatedAt: now,
  };
  await createJob(job);
  return { jobId };
}

export async function cancelJob(jobId: string, uiMode: UiMode): Promise<void> {
  const interfaceMode = getInterfaceMode(uiMode);
  if (interfaceMode === "mobile") {
    const job = await getJobById(jobId, uiMode).catch(() => null);
    const cloudJobId =
      job?.type === "generate_book_audio" &&
      (job as any)?.payloadJson?.backend === "cloud" &&
      typeof (job as any)?.payloadJson?.cloudJobId === "string"
        ? (job as any).payloadJson.cloudJobId
        : undefined;
    if (cloudJobId) {
      try {
        await cancelCloudBatchJob(cloudJobId);
      } catch (e: any) {
        jobLog.warn("cancelCloudBatchJob failed", { cloudJobId, err: String(e?.message ?? e) });
      }
    }
    const res = await JobRunner.cancelJob({ jobId });
    jobLog.info("cancelJob", { jobId });
    await updateJob(jobId, { status: "canceled", updatedAt: Date.now() });
    return;
  }
  await updateJob(jobId, { status: "canceled", updatedAt: Date.now() });
}

export async function retryJob(jobId: string, uiMode: UiMode): Promise<{ jobId: string }> {
  const interfaceMode = getInterfaceMode(uiMode);
  if (interfaceMode === "mobile") {
    const res = await JobRunner.retryJob({ jobId });
    jobLog.info("retryJob", res);
    return res;
  }
  await updateJob(jobId, { status: "queued", error: undefined, updatedAt: Date.now() });
  return { jobId };
}

export async function getJobById(jobId: string, uiMode: UiMode): Promise<JobRecord | null> {
  const interfaceMode = getInterfaceMode(uiMode);
  if (interfaceMode === "mobile") {
    const res = await JobRunner.getJob({ jobId });
    jobLog.info("getJob", res);
    return res.job;
  }
  return getJob(jobId);
}

export async function listAllJobs(uiMode: UiMode): Promise<JobRecord[]> {
  const interfaceMode = getInterfaceMode(uiMode);
  if (interfaceMode === "mobile") {
    const res = await JobRunner.listJobs();
    jobLog.info("listJobs", { count: res.jobs?.length ?? 0 });
    return res.jobs ?? [];
  }
  return listJobs();
}

export async function forceStartJob(jobId: string, uiMode: UiMode): Promise<void> {
  const interfaceMode = getInterfaceMode(uiMode);
  if (interfaceMode === "mobile") {
    const res = await JobRunner.forceStartJob({ jobId });
    jobLog.info("forceStartJob", { jobId });
    return;
  }
}

export async function enqueueUploadJob(
  uiMode: UiMode,
  opts?: { constraints?: { wifiOnly?: boolean; requiresCharging?: boolean } }
): Promise<{ jobId: string }> {
  const interfaceMode = getInterfaceMode(uiMode);
  if (interfaceMode === "mobile") {
    await refreshTokenBeforeDriveJob();
    const res = await JobRunner.enqueueUploadJob(opts ?? {});
    jobLog.info("enqueueUploadJob", res);
    return res;
  }
  const jobId = createJobId();
  const now = Date.now();
  const job: JobRecord = {
    jobId,
    type: "drive_upload_queue",
    status: "queued",
    payloadJson: {},
    progressJson: { total: 0, completed: 0 },
    createdAt: now,
    updatedAt: now,
  };
  await createJob(job);
  return { jobId };
}

export async function deleteJob(jobId: string, uiMode: UiMode): Promise<void> {
  const interfaceMode = getInterfaceMode(uiMode);
  if (interfaceMode === "mobile") {
    const res = await JobRunner.deleteJob({ jobId });
    jobLog.info("deleteJob", { jobId });
    return;
  }
  await deleteJobLocal(jobId);
}

export async function clearJobs(statuses: string[], uiMode: UiMode): Promise<void> {
  const interfaceMode = getInterfaceMode(uiMode);
  if (interfaceMode === "mobile") {
    const res = await JobRunner.clearJobs({ statuses });
    jobLog.info("clearJobs", { statuses });
    return;
  }
  await clearJobsLocal(statuses);
}

export async function getWorkInfo(
  jobId: string,
  uiMode: UiMode
): Promise<{ state: string; runAttemptCount: number } | null> {
  const interfaceMode = getInterfaceMode(uiMode);
  if (interfaceMode === "mobile") {
    try {
      const res = await JobRunner.getWorkInfo({ jobId });
      jobLog.info("getWorkInfo", res);
      return res.workInfo ?? null;
    } catch (e: any) {
      jobLog.error("getWorkInfo failed", e);
      throw e;
    }
  }
  return null;
}

export async function ensureUploadQueueJob(
  uiMode: UiMode,
  opts?: { constraints?: { wifiOnly?: boolean; requiresCharging?: boolean } }
): Promise<{ jobId: string | null }> {
  const interfaceMode = getInterfaceMode(uiMode);
  if (interfaceMode === "mobile") {
    await refreshTokenBeforeDriveJob();
    const res = await JobRunner.ensureUploadQueueJob(opts ?? {});
    jobLog.info("ensureUploadQueueJob", res);
    return res;
  }
  return { jobId: null };
}

export async function setUploadQueuePaused(paused: boolean, uiMode: UiMode): Promise<void> {
  const interfaceMode = getInterfaceMode(uiMode);
  if (interfaceMode === "mobile") {
    await JobRunner.setUploadQueuePaused({ paused });
  }
}

export async function getUploadQueuePaused(uiMode: UiMode): Promise<boolean> {
  const interfaceMode = getInterfaceMode(uiMode);
  if (interfaceMode === "mobile") {
    const res = await JobRunner.getUploadQueuePaused();
    return !!res?.paused;
  }
  return false;
}
