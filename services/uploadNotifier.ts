import { notifySimple } from "./notificationManager";

export type UploadNoticeKind =
  | "queued"
  | "started"
  | "paused"
  | "resumed"
  | "cleared"
  | "completed"
  | "failed";

export function notifyUpload(kind: UploadNoticeKind, message?: string): void {
  switch (kind) {
    case "queued":
      notifySimple(message ?? "Upload queued", "info");
      return;
    case "started":
      notifySimple(message ?? "Upload started", "info");
      return;
    case "paused":
      notifySimple(message ?? "Uploads paused", "info");
      return;
    case "resumed":
      notifySimple(message ?? "Uploads resumed", "success");
      return;
    case "cleared":
      notifySimple(message ?? "Upload queue cleared", "info");
      return;
    case "completed":
      notifySimple(message ?? "Uploads complete", "success");
      return;
    case "failed":
      notifySimple(message ?? "Upload failed", "error");
      return;
    default:
      notifySimple(message ?? "Upload update", "info");
  }
}
