import {
  clamp,
  computePercent,
  COMPLETE_PERCENT_THRESHOLD,
  COMPLETE_TIME_EPSILON_SECONDS,
  isNearCompletion,
  MIN_DURATION_SECONDS_FOR_COMPLETE,
} from "./progress";

// Progress semantics:
// - progress/progressSec are monotonic (never decrease) unless reset
// - isCompleted flips true on explicit end or near-end threshold
// - if you introduce a separate "current position", keep it distinct from stored progress
export type ProgressCommitReason =
  | "tick"
  | "pause"
  | "sceneChange"
  | "chapterSwitch"
  | "scrub"
  | "scrubToEnd"
  | "seek"
  | "seekToNearEnd"
  | "ended"
  | "reset";

export type ProgressSnapshot = {
  progress: number;
  progressSec?: number;
  durationSec?: number;
  progressChars?: number;
  textLength?: number;
  isCompleted?: boolean;
};

export type ProgressCommitInput = {
  current: ProgressSnapshot;
  timeSec: number;
  durationSec?: number;
  progressChars?: number;
  textLength?: number;
  reason: ProgressCommitReason;
  completed?: boolean;
  allowDecrease?: boolean;
};

export type ProgressCommitResult = {
  next: ProgressSnapshot;
  changed: boolean;
};

export function computeProgressUpdate(input: ProgressCommitInput): ProgressCommitResult {
  const allowDecrease = input.allowDecrease ?? false;
  const current = input.current;

  const currentProgress = Number.isFinite(current.progress) ? current.progress : 0;
  const currentDuration =
    typeof current.durationSec === "number" && Number.isFinite(current.durationSec) ? current.durationSec : 0;
  const currentTextLength =
    typeof current.textLength === "number" && Number.isFinite(current.textLength) ? current.textLength : 0;
  const currentChars =
    typeof current.progressChars === "number" && Number.isFinite(current.progressChars) ? current.progressChars : 0;

  const incomingDuration =
    typeof input.durationSec === "number" && Number.isFinite(input.durationSec) ? input.durationSec : 0;
  const durationSec = incomingDuration > 0 ? incomingDuration : currentDuration;
  const incomingTextLength =
    typeof input.textLength === "number" && Number.isFinite(input.textLength) ? input.textLength : 0;
  const textLength = incomingTextLength > 0 ? incomingTextLength : currentTextLength;

  const rawTime = typeof input.timeSec === "number" && Number.isFinite(input.timeSec) ? input.timeSec : 0;
  const timeSec = durationSec > 0 ? clamp(rawTime, 0, durationSec) : Math.max(0, rawTime);
  const progressChars =
    typeof input.progressChars === "number" && Number.isFinite(input.progressChars)
      ? Math.max(0, input.progressChars)
      : currentChars;

  const percentFromTime = computePercent(timeSec, durationSec);
  const percentFromChars =
    percentFromTime === undefined && textLength > 0 ? computePercent(progressChars, textLength) : undefined;
  const percentCandidate = typeof percentFromTime === "number" ? percentFromTime : percentFromChars;

  let nextPercent =
    typeof percentCandidate === "number" ? percentCandidate : currentProgress;
  if (!allowDecrease && typeof percentCandidate === "number") {
    nextPercent = Math.max(currentProgress, percentCandidate);
  }
  nextPercent = clamp(nextPercent, 0, 1);

  let nextProgressSec = timeSec;
  let nextProgressChars = progressChars;
  if (!allowDecrease) {
    const currentSec = typeof current.progressSec === "number" ? current.progressSec : 0;
    const currentChars = typeof current.progressChars === "number" ? current.progressChars : 0;
    nextProgressSec = Math.max(currentSec, nextProgressSec);
    nextProgressChars = Math.max(currentChars, nextProgressChars);
  }

  if (durationSec > 0) {
    nextProgressSec = clamp(nextProgressSec, 0, durationSec);
  }

  const percentAtThreshold =
    typeof percentCandidate === "number" && percentCandidate >= COMPLETE_PERCENT_THRESHOLD;
  const timeAtEpsilon =
    durationSec > 0 &&
    durationSec >= MIN_DURATION_SECONDS_FOR_COMPLETE &&
    durationSec - timeSec <= COMPLETE_TIME_EPSILON_SECONDS;
  const explicitCompletion =
    input.completed ||
    input.reason === "ended" ||
    input.reason === "scrubToEnd" ||
    input.reason === "seekToNearEnd";

  let nextIsCompleted = !!current.isCompleted;
  if (input.reason === "reset") {
    nextIsCompleted = false;
  } else if (explicitCompletion || percentAtThreshold || (timeAtEpsilon && input.reason !== "tick")) {
    if (input.reason === "ended" || isNearCompletion(timeSec, durationSec) || percentAtThreshold || timeAtEpsilon) {
      nextIsCompleted = true;
    }
  }

  if (input.reason === "reset") {
    nextPercent = 0;
    nextProgressSec = 0;
    nextProgressChars = 0;
  } else if (nextIsCompleted) {
    nextPercent = 1;
    if (durationSec > 0) {
      nextProgressSec = durationSec;
    }
    if (textLength > 0) {
      nextProgressChars = textLength;
    }
  }

  const next: ProgressSnapshot = {
    progress: nextPercent,
    progressSec: nextProgressSec,
    durationSec: durationSec || current.durationSec,
    progressChars: nextProgressChars,
    textLength: textLength || current.textLength,
    isCompleted: nextIsCompleted,
  };

  const changed =
    Math.abs((next.progress ?? 0) - (current.progress ?? 0)) > 0.0001 ||
    Math.abs((next.progressSec ?? 0) - (current.progressSec ?? 0)) > 0.0001 ||
    next.isCompleted !== current.isCompleted ||
    (next.durationSec ?? 0) !== (current.durationSec ?? 0);

  return { next, changed };
}
