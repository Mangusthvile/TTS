import { useCallback } from "react";
import { notify, notifySimple, type Notice } from "../services/notificationManager";

export function useNotify() {
  return useCallback((notice: Notice) => notify(notice), []);
}

export function useNotifySimple() {
  return useCallback(
    (message: string, type: Notice["type"] = "info", ms: number = 3000) => {
      notifySimple(message, type, ms);
    },
    []
  );
}
