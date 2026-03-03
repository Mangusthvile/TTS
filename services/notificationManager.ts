export type NoticeType = "info" | "success" | "error" | "reconnect";

export type Notice = {
  message: string;
  type: NoticeType;
  ms?: number;
  source?: string;
};

type Listener = (notice: Notice) => void;

const listeners = new Set<Listener>();

export function subscribeNotice(listener: Listener): () => void {
  if (listeners.has(listener)) {
    return () => {};
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notify(notice: Notice): void {
  if (typeof import.meta !== "undefined" && (import.meta as any).env?.DEV && listeners.size > 1) {
    console.warn("[TaleVox] notificationManager: multiple listeners registered; ensure subscribeNotice cleanup is called on unmount.", listeners.size);
  }
  const safeMessage =
    notice.message != null && String(notice.message).trim() !== ""
      ? String(notice.message).trim()
      : notice.type === "error"
        ? "An error occurred"
        : "Done";
  const safeNotice: Notice = { ...notice, message: safeMessage };
  for (const listener of listeners) {
    listener(safeNotice);
  }
}

export function notifySimple(message: string, type: NoticeType = "info", ms: number = 3000): void {
  notify({ message: message || (type === "error" ? "An error occurred" : "Done"), type, ms });
}
