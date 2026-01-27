const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export type DriveRetryOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
};

export async function driveRetry<T>(
  action: () => Promise<Response>,
  label: string,
  opts: DriveRetryOptions = {}
): Promise<Response> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 4);
  const baseDelay = Math.max(50, opts.baseDelayMs ?? 400);
  const maxDelay = Math.max(baseDelay, opts.maxDelayMs ?? 4000);

  let lastResponse: Response | null = null;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await action();
      if (!RETRYABLE_STATUS.has(response.status)) {
        return response;
      }

      lastResponse = response;
      lastError = new Error(`${label} failed with ${response.status}`);

      if (attempt >= maxAttempts) break;
      await delayWithJitter(attempt, baseDelay, maxDelay);
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts) break;
      await delayWithJitter(attempt, baseDelay, maxDelay);
    }
  }

  if (lastResponse && !lastResponse.ok) {
    throw new Error(`${label} failed after ${maxAttempts} attempts (status ${lastResponse.status})`);
  }
  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error(`${label} failed after ${maxAttempts} attempts`);
}

function delayWithJitter(attempt: number, baseDelay: number, maxDelay: number): Promise<void> {
  const exponential = Math.min(maxDelay, baseDelay * 2 ** (attempt - 1));
  const jitter = exponential * (0.5 + Math.random() * 0.5);
  const delay = Math.min(maxDelay, jitter);
  return new Promise((resolve) => setTimeout(resolve, delay));
}
