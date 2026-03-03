export const safeSetLocalStorage = (key: string, value: string) => {
  if (value.length > 250000 && key.includes("backup")) {
    console.warn(
      `[SafeStorage] Skipping backup write for ${key} (size ${value.length} > 250kb) to prevent quota issues.`
    );
    return;
  }
  try {
    localStorage.setItem(key, value);
  } catch (e: unknown) {
    const err = e as { name?: string; message?: string };
    const isQuota =
      err?.name === "QuotaExceededError" || err?.name === "NS_ERROR_DOM_QUOTA_REACHED";
    if (isQuota) {
      console.error(
        "[SafeStorage] QuotaExceededError writing to localStorage:",
        key,
        "size:",
        value.length,
        err?.message
      );
    } else {
      console.warn(`[SafeStorage] LocalStorage write failed for key "${key}":`, err?.message);
    }
    if (isQuota && typeof window !== "undefined") {
      try {
        const diagStr = localStorage.getItem("talevox_sync_diag") || "{}";
        const diag = JSON.parse(diagStr) as Record<string, unknown>;
        diag.lastSyncError = `Storage Quota Exceeded: ${err?.message ?? "unknown"}`;
        localStorage.setItem("talevox_sync_diag", JSON.stringify(diag));
      } catch {
        // ignore
      }
    }
  }
};
