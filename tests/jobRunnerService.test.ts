import { describe, it, expect, vi } from "vitest";
import type { JobRecord, UiMode } from "../types";

vi.mock("../src/plugins/jobRunner", () => ({
  JobRunner: {
    enqueueGenerateAudio: vi.fn(async () => ({ jobId: "job_1" })),
    enqueueGenerateBookAudio: vi.fn(async () => ({ jobId: "job_2" })),
  },
}));

vi.mock("../services/cloudBatchApi", () => ({
  createCloudBatchJob: vi.fn(async () => ({
    jobId: "cloud_job_1",
    status: "queued",
    totalChapters: 1,
  })),
  getCloudBatchJob: vi.fn(async () => ({
    jobId: "cloud_job_1",
    status: "running",
    bookId: "book1",
    totalChapters: 1,
    completedChapters: 0,
    failedChapters: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })),
}));

describe("jobRunnerService enqueueGenerateAudio", () => {
  it("throws SyncError for invalid payload", async () => {
    const { enqueueGenerateAudio } = await import("../services/jobRunnerService");
    const uiMode = "mobile" as UiMode;
    await expect(
      enqueueGenerateAudio({ bookId: "", chapterIds: [] } as any, uiMode)
    ).rejects.toThrow("Invalid job payload");
  });

  it("passes through for valid payload on mobile", async () => {
    const { enqueueGenerateAudio } = await import("../services/jobRunnerService");
    const uiMode = "mobile" as UiMode;
    const res = await enqueueGenerateAudio(
      {
        bookId: "book1",
        chapterIds: ["ch1"],
        voice: { id: "voice1" },
        settings: {},
      } as any,
      uiMode
    );
    expect(res.jobId).toBe("job_1");
  });
});

describe("jobRunnerService cloud helpers", () => {
  it("enqueueCloudGenerateBookAudio throws when endpoint is not configured", async () => {
    vi.stubEnv("VITE_TALEVOX_BATCH_JOBS_ENDPOINT", "");
    vi.stubEnv("VITE_BATCH_JOBS_ENDPOINT", "");
    vi.resetModules();
    const { enqueueCloudGenerateBookAudio } = await import("../services/jobRunnerService");
    const uiMode = "mobile" as UiMode;
    try {
      await expect(
        enqueueCloudGenerateBookAudio(
          {
            bookId: "book1",
            chapterIds: ["ch1"],
            voice: { id: "voice1" },
            settings: {},
          } as any,
          uiMode
        )
      ).rejects.toThrow("Batch jobs endpoint is not configured");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("syncCloudBackedJobs is a no-op when there are no cloud jobs", async () => {
    const { syncCloudBackedJobs } = await import("../services/jobRunnerService");
    const uiMode = "mobile" as UiMode;
    const jobs: JobRecord[] = [];
    const result = await syncCloudBackedJobs(jobs, uiMode);
    expect(result).toEqual(jobs);
  });
});
