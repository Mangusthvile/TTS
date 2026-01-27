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
      return await JobRunner.enqueueGenerateAudio({ payload });
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg.includes("not implemented")) {
        // Fallback to local job store if plugin isn't registered yet.
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
    try {
      return await JobRunner.enqueueFixIntegrity({ payload });
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (!msg.includes("not implemented")) throw e;
    }
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
    try {
      await JobRunner.cancelJob({ jobId });
      await updateJob(jobId, { status: "canceled", updatedAt: Date.now() });
      return;
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (!msg.includes("not implemented")) throw e;
    }
    await updateJob(jobId, { status: "canceled", updatedAt: Date.now() });
    return;
  }
  await updateJob(jobId, { status: "canceled", updatedAt: Date.now() });
}

export async function retryJob(jobId: string, uiMode: UiMode): Promise<{ jobId: string }> {
  const interfaceMode = getInterfaceMode(uiMode);
  if (interfaceMode === "mobile") {
    try {
      return await JobRunner.retryJob({ jobId });
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (!msg.includes("not implemented") && !msg.includes("not failed or canceled")) throw e;
    }
  }
  await updateJob(jobId, { status: "queued", error: undefined, updatedAt: Date.now() });
  return { jobId };
}

export async function getJobById(jobId: string, uiMode: UiMode): Promise<JobRecord | null> {
  const interfaceMode = getInterfaceMode(uiMode);
  if (interfaceMode === "mobile") {
    try {
      const res = await JobRunner.getJob({ jobId });
      return res.job;
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (!msg.includes("not implemented")) throw e;
    }
  }
  return getJob(jobId);
}

export async function listAllJobs(uiMode: UiMode): Promise<JobRecord[]> {
  const interfaceMode = getInterfaceMode(uiMode);
  if (interfaceMode === "mobile") {
    try {
      const res = await JobRunner.listJobs();
      return res.jobs ?? [];
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (!msg.includes("not implemented")) throw e;
    }
  }
  return listJobs();
}

export async function forceStartJob(jobId: string, uiMode: UiMode): Promise<void> {
  const interfaceMode = getInterfaceMode(uiMode);
  if (interfaceMode === "mobile") {
    try {
      await JobRunner.forceStartJob({ jobId });
      return;
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (!msg.includes("not implemented")) throw e;
    }
  }
}

export async function deleteJob(jobId: string, uiMode: UiMode): Promise<void> {
  const interfaceMode = getInterfaceMode(uiMode);
  if (interfaceMode === "mobile") {
    try {
      await JobRunner.deleteJob({ jobId });
      return;
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (!msg.includes("not implemented")) throw e;
    }
  }
  await deleteJobLocal(jobId);
}

export async function clearJobs(statuses: string[], uiMode: UiMode): Promise<void> {
  const interfaceMode = getInterfaceMode(uiMode);
  if (interfaceMode === "mobile") {
    try {
      await JobRunner.clearJobs({ statuses });
      return;
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (!msg.includes("not implemented")) throw e;
    }
  }
  await clearJobsLocal(statuses);
}
