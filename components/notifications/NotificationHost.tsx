import React, { useEffect, useRef, useState } from "react";
import { AlertCircle, Cloud, Loader2 } from "lucide-react";
import { subscribeNotice, type Notice } from "../../services/notificationManager";

const DEFAULT_MS = 2500;

const NotificationHost: React.FC = () => {
  const [toast, setToast] = useState<Notice | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return subscribeNotice((notice) => {
      setToast(notice);
      if (timerRef.current) window.clearTimeout(timerRef.current);
      const ms = notice.ms ?? DEFAULT_MS;
      if (ms > 0) {
        timerRef.current = window.setTimeout(() => {
          setToast(null);
          timerRef.current = null;
        }, ms);
      }
    });
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, []);

  if (!toast) return null;

  return (
    <div className="fixed bottom-6 left-1/2 z-[100] -translate-x-1/2">
      <div
        className={`px-6 py-3 rounded-2xl shadow-2xl font-black text-xs uppercase tracking-widest flex items-center gap-3 toast-animate ${
          toast.type === "error"
            ? "bg-red-500 text-white"
            : toast.type === "success"
            ? "bg-emerald-500 text-white"
            : "bg-slate-900 text-white"
        }`}
      >
        {toast.type === "error" ? (
          <AlertCircle className="w-4 h-4" />
        ) : toast.type === "success" ? (
          <Cloud className="w-4 h-4" />
        ) : (
          <Loader2 className="w-4 h-4 animate-spin" />
        )}
        {toast.message}
      </div>
    </div>
  );
};

export default NotificationHost;
