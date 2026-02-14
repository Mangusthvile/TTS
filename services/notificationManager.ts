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
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notify(notice: Notice): void {
  for (const listener of listeners) {
    listener(notice);
  }
}

export function notifySimple(message: string, type: NoticeType = "info", ms: number = 3000): void {
  notify({ message, type, ms });
}
