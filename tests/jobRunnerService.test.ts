import { describe, it, expect, vi } from "vitest";
import type { UiMode } from "../types";

vi.mock("../src/plugins/jobRunner", () => ({
  JobRunner: {
    enqueueGenerateAudio: vi.fn(async () => ({ jobId: "job_1" })),
  },
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
