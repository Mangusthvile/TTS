// services/jobStore.ts
import { getStorage, initStorage } from "./storageSingleton";
import type { JobRecord, JobType } from "../types";

export async function createJob(job: JobRecord): Promise<void> {
  await initStorage();
  const storage = getStorage();
  const res = await storage.createJob(job);
  if (!res.ok) {
    console.warn("[TaleVox][Jobs] createJob failed:", res.error);
  }
}

export async function updateJob(
  jobId: string,
  patch: Partial<Omit<JobRecord, "jobId" | "createdAt">>
): Promise<void> {
  await initStorage();
  const storage = getStorage();
  const res = await storage.updateJob(jobId, patch);
  if (!res.ok) {
    console.warn("[TaleVox][Jobs] updateJob failed:", res.error);
  }
}

export async function getJob(jobId: string): Promise<JobRecord | null> {
  await initStorage();
  const storage = getStorage();
  const res = await storage.getJob(jobId);
  if (!res.ok) return null;
  return res.value ?? null;
}

export async function listJobs(type?: JobType): Promise<JobRecord[]> {
  await initStorage();
  const storage = getStorage();
  const res = await storage.listJobs(type);
  if (!res.ok) return [];
  return res.value ?? [];
}
