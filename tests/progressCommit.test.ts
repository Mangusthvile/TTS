import { describe, expect, it } from "vitest";
import { computeProgressUpdate } from "../utils/progressCommit";

describe("progress commit rules", () => {
  it("keeps progress at 60% when skipping next", () => {
    const { next } = computeProgressUpdate({
      current: { progress: 0.6, progressSec: 60, durationSec: 100, isCompleted: false },
      timeSec: 60,
      durationSec: 100,
      reason: "chapterSwitch",
    });
    expect(next.progress).toBeCloseTo(0.6, 4);
    expect(next.isCompleted).toBe(false);
    expect(next.progressSec).toBeCloseTo(60, 4);
  });

  it("marks complete when scrubbed near end", () => {
    const { next } = computeProgressUpdate({
      current: { progress: 0.7, progressSec: 70, durationSec: 100, isCompleted: false },
      timeSec: 99,
      durationSec: 100,
      reason: "scrubToEnd",
    });
    expect(next.isCompleted).toBe(true);
    expect(next.progress).toBe(1);
    expect(next.progressSec).toBeCloseTo(100, 4);
  });

  it("scrub forward updates progress without completing", () => {
    const { next } = computeProgressUpdate({
      current: { progress: 0.1, progressSec: 10, durationSec: 100, isCompleted: false },
      timeSec: 75,
      durationSec: 100,
      reason: "scrub",
    });
    expect(next.isCompleted).toBe(false);
    expect(next.progress).toBeCloseTo(0.75, 4);
    expect(next.progressSec).toBeCloseTo(75, 4);
  });

  it("scrub backward clears completion and reduces progress", () => {
    const { next } = computeProgressUpdate({
      current: { progress: 1, progressSec: 100, durationSec: 100, isCompleted: true },
      timeSec: 30,
      durationSec: 100,
      reason: "scrub",
    });
    expect(next.isCompleted).toBe(true);
    expect(next.progress).toBe(1);
    expect(next.progressSec).toBeCloseTo(100, 4);
  });

  it("does not derive percent from zero duration", () => {
    const { next } = computeProgressUpdate({
      current: { progress: 0.4, progressSec: 40, durationSec: 0, isCompleted: false },
      timeSec: 12,
      durationSec: 0,
      reason: "tick",
    });
    expect(next.progress).toBeCloseTo(0.4, 4);
    expect(next.progressSec).toBeCloseTo(40, 4);
  });

  it("clamps time when duration shrinks and keeps progress monotonic", () => {
    const { next } = computeProgressUpdate({
      current: { progress: 0.9, progressSec: 90, durationSec: 100, isCompleted: false },
      timeSec: 90,
      durationSec: 50,
      reason: "tick",
    });
    expect(next.durationSec).toBe(50);
    expect(next.progressSec).toBeCloseTo(50, 4);
    expect(next.isCompleted).toBe(true);
  });

  it("ended forces completion", () => {
    const { next } = computeProgressUpdate({
      current: { progress: 0.2, progressSec: 20, durationSec: 100, isCompleted: false },
      timeSec: 20,
      durationSec: 100,
      reason: "ended",
    });
    expect(next.isCompleted).toBe(true);
    expect(next.progress).toBe(1);
    expect(next.progressSec).toBeCloseTo(100, 4);
  });

  it("percent threshold marks completion on tick", () => {
    const { next } = computeProgressUpdate({
      current: { progress: 0.97, progressSec: 97, durationSec: 100, isCompleted: false },
      timeSec: 99.6,
      durationSec: 100,
      reason: "tick",
    });
    expect(next.isCompleted).toBe(true);
    expect(next.progress).toBe(1);
  });
});
