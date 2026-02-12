export const COMPLETE_PERCENT_THRESHOLD = 0.995;
export const COMPLETE_REMAINING_SECONDS_THRESHOLD = 2.0;
export const MIN_DURATION_SECONDS_FOR_COMPLETE = 5.0;
export const COMPLETE_TIME_EPSILON_SECONDS = 0.5;

export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function computePercent(timeSec: number, durationSec?: number): number | undefined {
  if (!durationSec || durationSec <= 0) return undefined;
  return clamp(timeSec / durationSec, 0, 1);
}

export function isNearCompletion(timeSec: number, durationSec?: number): boolean {
  if (!durationSec || durationSec <= 0) return false;
  if (durationSec < MIN_DURATION_SECONDS_FOR_COMPLETE) return false;
  const percent = computePercent(timeSec, durationSec);
  if (typeof percent === "number" && percent >= COMPLETE_PERCENT_THRESHOLD) return true;
  return durationSec - timeSec <= COMPLETE_REMAINING_SECONDS_THRESHOLD;
}
