import type { UiMode } from "../types";
import type { JobRecord } from "../types";
import { computeMobileMode } from "../utils/platform";
import { JobRunner } from "../src/plugins/jobRunner";
import type { JobRunnerPayload } from "../src/plugins/jobRunner";
import { createJob, updateJob, getJob, listJobs, deleteJob as deleteJobLocal, clearJobs as clearJobsLocal } from "./jobStore";

type InterfaceMode = "mobile" | "desktop";

function getInterfaceMode(uiMode: UiMode): InterfaceMode {
  return computeMobileMode(uiMode) ? "mobile" : "desktop";
}

export async function jobRunnerHealthCheck(uiMode: UiMode): Promise<void> {
  if (!computeMobileMode(uiMode)) return;
  try {
    const res = await JobRunner.getDiagnostics?.();
    console.log("[JobRunner][native] health check", res);
  } catch (e) {
    console.warn("[JobRunner][native] health check failed", e);
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
  const interfaceMode = getInterfaceMode(uiMode);
  if (interfaceMode === "mobile") {
    try {
      const res = await JobRunner.enqueueGenerateAudio({ payload });
      console.log("[JobRunner][native] enqueueGenerateAudio", res);
      return res;
    } catch (e: any) {
      console.error("[JobRunner][native] enqueueGenerateAudio failed", e);
      throw e;
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
  payload: { bookId: string; driveFolderId?: string; options?: { genAudio?: boolean; cleanupStrays?: boolean; convertLegacy?: boolean } },
  uiMode: UiMode
): Promise<{ jobId: string }> {
  const interfaceMode = getInterfaceMode(uiMode);
  if (interfaceMode === "mobile") {
    const res = await JobRunner.enqueueFixIntegrity({ payload });
    console.log("[JobRunner][native] enqueueFixIntegrity", res);
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
    console.log("[JobRunner][native] cancelJob", res);
    await updateJob(jobId, { status: "canceled", updatedAt: Date.now() });
    return;
  }
  await updateJob(jobId, { status: "canceled", updatedAt: Date.now() });
}

export async function retryJob(jobId: string, uiMode: UiMode): Promise<{ jobId: string }> {
  const interfaceMode = getInterfaceMode(uiMode);
  if (interfaceMode === "mobile") {
    const res = await JobRunner.retryJob({ jobId });
    console.log("[JobRunner][native] retryJob", res);
    return res;
  }
  await updateJob(jobId, { status: "queued", error: undefined, updatedAt: Date.now() });
  return { jobId };
}

export async function getJobById(jobId: string, uiMode: UiMode): Promise<JobRecord | null> {
  const interfaceMode = getInterfaceMode(uiMode);
  if (interfaceMode === "mobile") {
    const res = await JobRunner.getJob({ jobId });
    console.log("[JobRunner][native] getJob", res);
    return res.job;
  }
  return getJob(jobId);
}

export async function listAllJobs(uiMode: UiMode): Promise<JobRecord[]> {
  const interfaceMode = getInterfaceMode(uiMode);
  if (interfaceMode === "mobile") {
    const res = await JobRunner.listJobs();
    console.log("[JobRunner][native] listJobs", res);
    return res.jobs ?? [];
  }
  return listJobs();
}

export async function forceStartJob(jobId: string, uiMode: UiMode): Promise<void> {
  const interfaceMode = getInterfaceMode(uiMode);
  if (interfaceMode === "mobile") {
    const res = await JobRunner.forceStartJob({ jobId });
    console.log("[JobRunner][native] forceStartJob", res);
    return;
  }
}

export async function enqueueUploadJob(uiMode: UiMode): Promise<{ jobId: string }> {
  const interfaceMode = getInterfaceMode(uiMode);
  if (interfaceMode === "mobile") {
    const res = await JobRunner.enqueueUploadJob({});
    console.log("[JobRunner][native] enqueueUploadJob", res);
    return res;
  }
  const jobId = createJobId();
  const now = Date.now();
  const job: JobRecord = {
    jobId,
    type: "uploadQueue",
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
    console.log("[JobRunner][native] deleteJob", res);
    return;
  }
  await deleteJobLocal(jobId);
}

export async function clearJobs(statuses: string[], uiMode: UiMode): Promise<void> {
  const interfaceMode = getInterfaceMode(uiMode);
  if (interfaceMode === "mobile") {
    const res = await JobRunner.clearJobs({ statuses });
    console.log("[JobRunner][native] clearJobs", res);
    return;
  }
  await clearJobsLocal(statuses);
}

export async function getWorkInfo(jobId: string, uiMode: UiMode): Promise<{ state: string; runAttemptCount: number } | null> {
  const interfaceMode = getInterfaceMode(uiMode);
  if (interfaceMode === "mobile") {
    try {
      const res = await JobRunner.getWorkInfo({ jobId });
      console.log("[JobRunner][native] getWorkInfo", res);
      return res.workInfo ?? null;
    } catch (e: any) {
      console.error("[JobRunner][native] getWorkInfo failed", e);
      throw e;
    }
  }
  return null;
}

export async function ensureUploadQueueJob(uiMode: UiMode): Promise<{ jobId: string | null }> {
  const interfaceMode = getInterfaceMode(uiMode);
  if (interfaceMode === "mobile") {
    const res = await JobRunner.ensureUploadQueueJob();
    console.log("[JobRunner][native] ensureUploadQueueJob", res);
    return res;
  }
  return { jobId: null };
}
