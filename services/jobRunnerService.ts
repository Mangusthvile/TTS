import type { UiMode } from "../types";
import type { JobRecord } from "../types";
import { computeMobileMode } from "../utils/platform";
import { Capacitor } from "@capacitor/core";
import { JobRunner } from "../src/plugins/jobRunner";
import type { JobRunnerPayload } from "../src/plugins/jobRunner";
import { createJob, updateJob, getJob, listJobs, deleteJob as deleteJobLocal, clearJobs as clearJobsLocal } from "./jobStore";
import { getLogger } from "../utils/logger";
import { SyncError } from "../utils/errors";

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
      return { available: false, platform, reason: "probe-failed", diagnostics: String(e?.message ?? e) };
    }
  })().finally(() => {
    // keep cached
  });
  return capabilityPromise;
}

function getInterfaceMode(uiMode: UiMode): InterfaceMode {
  return computeMobileMode(uiMode) ? "mobile" : "desktop";
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
    try {
      const res = await JobRunner.enqueueGenerateAudio({ payload });
      jobLog.info("enqueueGenerateAudio", { ...res, correlationId: payload.correlationId });
      return res;
    } catch (e: any) {
      const errMsg = String(e?.message ?? e);
      jobLog.error("enqueueGenerateAudio failed", { err: errMsg, payload });
      if (errMsg.includes("notifications_not_granted")) {
        throw new SyncError("notifications_not_granted", { operation: "enqueueGenerateAudio", payload }, e);
      }
      throw new SyncError("Failed to enqueue job", { operation: "enqueueGenerateAudio", payload }, e);
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

export async function getWorkInfo(jobId: string, uiMode: UiMode): Promise<{ state: string; runAttemptCount: number } | null> {
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
