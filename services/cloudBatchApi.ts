import { appConfig } from "../src/config/appConfig";
import type { JobProgress } from "../types";

export type CloudBatchJobStatus =
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "canceled";

export interface CloudBatchJobSummary {
  jobId: string;
  status: CloudBatchJobStatus;
  bookId: string;
  totalChapters: number;
  completedChapters: number;
  failedChapters: number;
  lastChapterId?: string;
  errorSummary?: string;
  createdAt: number;
  updatedAt: number;
  progress?: JobProgress;
}

function getBatchJobsBaseUrl(): string {
  const envUrl =
    (import.meta as any)?.env?.VITE_TALEVOX_BATCH_JOBS_ENDPOINT ??
    (import.meta as any)?.env?.VITE_BATCH_JOBS_ENDPOINT;
  const cfgUrl = appConfig.cloud?.batchJobsEndpoint;
  const url = String(envUrl || cfgUrl || "").trim();
  if (!url) {
    throw new Error("Batch jobs endpoint is not configured (VITE_TALEVOX_BATCH_JOBS_ENDPOINT).");
  }
  return url.replace(/\/+$/, "");
}

export interface CreateCloudBatchJobRequest {
  userId?: string;
  bookId: string;
  chapterIds: string[];
  voice: { id: string; provider?: string };
  settings?: Record<string, any>;
  driveRootFolderId?: string;
  driveBookFolderId?: string;
}

export interface CreateCloudBatchJobResponse {
  jobId: string;
  status: CloudBatchJobStatus;
  totalChapters: number;
}

export async function createCloudBatchJob(
  req: CreateCloudBatchJobRequest
): Promise<CreateCloudBatchJobResponse> {
  if (!req.bookId || !Array.isArray(req.chapterIds) || req.chapterIds.length === 0) {
    throw new Error("Invalid cloud batch job payload");
  }
  const baseUrl = getBatchJobsBaseUrl();
  const res = await fetch(`${baseUrl}/v1/batch-jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Batch job create failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as CreateCloudBatchJobResponse;
  return data;
}

export async function getCloudBatchJob(jobId: string): Promise<CloudBatchJobSummary> {
  if (!jobId) throw new Error("jobId is required");
  const baseUrl = getBatchJobsBaseUrl();
  const res = await fetch(`${baseUrl}/v1/batch-jobs/${encodeURIComponent(jobId)}`);
  if (res.status === 404) {
    throw new Error("Batch job not found");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Batch job fetch failed: ${res.status} ${text}`);
  }
  const raw = (await res.json()) as Record<string, unknown>;
  const toMs = (v: unknown): number => {
    if (typeof v === "number" && v > 1e12) return v; // already ms
    if (typeof v === "number") return v * 1000; // seconds
    if (typeof v === "string") {
      const n = Date.parse(v);
      return Number.isFinite(n) ? n : 0;
    }
    if (v && typeof v === "object" && "_seconds" in v) {
      const s = Number((v as { _seconds?: number })._seconds);
      const n = Number((v as { _nanoseconds?: number })._nanoseconds ?? 0);
      return Number.isFinite(s) ? s * 1000 + n / 1e6 : 0;
    }
    if (v && typeof v === "object" && "toMillis" in v && typeof (v as any).toMillis === "function") {
      return (v as any).toMillis();
    }
    return 0;
  };
  return {
    jobId: String(raw.jobId ?? jobId),
    status: (raw.status as CloudBatchJobSummary["status"]) ?? "queued",
    bookId: String(raw.bookId ?? ""),
    totalChapters: Number(raw.totalChapters ?? 0),
    completedChapters: Number(raw.completedChapters ?? 0),
    failedChapters: Number(raw.failedChapters ?? 0),
    lastChapterId: raw.lastChapterId != null ? String(raw.lastChapterId) : undefined,
    errorSummary: raw.errorSummary != null ? String(raw.errorSummary) : undefined,
    createdAt: toMs(raw.createdAt) || Date.now(),
    updatedAt: toMs(raw.updatedAt) || Date.now(),
    progress: raw.progress as CloudBatchJobSummary["progress"],
  };
}

/** Cancel a cloud batch job (optional backend support). No-op if endpoint does not support cancel. */
export async function cancelCloudBatchJob(jobId: string): Promise<{ status: string } | void> {
  if (!jobId) return;
  const baseUrl = getBatchJobsBaseUrl();
  const res = await fetch(`${baseUrl}/v1/batch-jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (res.status === 404 || res.status === 405) return; // not found or method not allowed
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Batch job cancel failed: ${res.status} ${text}`);
  }
  return res.json() as Promise<{ status: string }>;
}

