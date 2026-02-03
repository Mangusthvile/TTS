import { describe, it, expect } from "vitest";
import { planNativeTextSync } from "../services/syncPlanner";

describe("planNativeTextSync", () => {
  it("flags missing rows and files", () => {
    const plan = planNativeTextSync({
      chapterIds: ["a", "b", "c"],
      existingRows: { a: true, b: false, c: true },
      existingFiles: { a: true, b: false, c: false },
    });

    expect(plan.missingRows).toEqual(["b"]);
    expect(plan.missingFiles).toEqual(["c"]);
  });
});
