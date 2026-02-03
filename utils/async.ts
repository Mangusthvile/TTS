export function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(() => resolve(), 0);
    }
  });
}

export async function yieldEvery(iteration: number, every: number): Promise<void> {
  if (every > 0 && iteration % every === 0) {
    await yieldToUi();
  }
}
