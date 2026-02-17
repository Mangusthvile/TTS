import React from "react";
import { Image as ImageIcon, AlertCircle, Cloud, CloudOff, FolderSync, Loader2 } from "lucide-react";
import type { Book } from "../../types";

type SyncBadge = {
  backendLabel: string;
  statusLabel: "SYNCING" | "PAUSED" | "NOT SYNCED" | "SYNCED" | "LOCAL";
  tone: "emerald" | "amber" | "indigo" | "slate";
};

type Props = {
  book: Book;
  syncBadge: SyncBadge;
  lastSavedAt?: number;
  coverCardRef: React.RefObject<HTMLDivElement | null>;
  coverRowRef: React.RefObject<HTMLDivElement | null>;
  coverImageRef: React.RefObject<HTMLDivElement | null>;
  coverMetaRef: React.RefObject<HTMLDivElement | null>;
};

const syncLabelToText = (label: SyncBadge["statusLabel"]) => {
  if (label === "NOT SYNCED") return "Not synced";
  if (label === "SYNCING") return "Syncing";
  if (label === "PAUSED") return "Paused";
  if (label === "SYNCED") return "Synced";
  return "Local";
};

const syncLabelToIcon = (label: SyncBadge["statusLabel"]) => {
  if (label === "SYNCING") return <Loader2 className="w-3 h-3 animate-spin" />;
  if (label === "PAUSED") return <AlertCircle className="w-3 h-3" />;
  if (label === "NOT SYNCED") return <CloudOff className="w-3 h-3" />;
  if (label === "SYNCED") return <Cloud className="w-3 h-3" />;
  return <FolderSync className="w-3 h-3" />;
};

const lastSavedLabel = (timestamp?: number) =>
  timestamp
    ? new Date(timestamp).toLocaleTimeString()
    : "not available yet";

const BookHero: React.FC<Props> = ({
  book,
  syncBadge,
  lastSavedAt,
  coverCardRef,
  coverRowRef,
  coverImageRef,
  coverMetaRef,
}) => {
  const backendLabel = book.backend === "drive" ? "Drive" : "Local";
  const syncText = syncLabelToText(syncBadge.statusLabel);
  const syncIcon = syncLabelToIcon(syncBadge.statusLabel);
  const chapterCount = book.chapterCount ?? book.chapters.length;

  return (
    <div ref={coverCardRef} className="p-4 sm:p-5 bg-transparent border-0 shadow-none">
      <div ref={coverRowRef} className="flex items-start gap-4">
        <div
          ref={coverImageRef}
          className="w-14 sm:w-16 aspect-[2/3] rounded-2xl overflow-hidden shadow-2xl flex-shrink-0 bg-indigo-600/10 flex items-center justify-center"
        >
          {book.coverImage ? (
            <img src={book.coverImage} className="w-full h-full object-cover" alt={book.title} />
          ) : (
            <ImageIcon className="w-6 h-6 opacity-20" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xl sm:text-3xl font-black leading-tight line-clamp-2 heading-font">
            {book.title}
          </div>
          <div ref={coverMetaRef} className="mt-2 flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="chip">{backendLabel}</span>
              <span className="chip inline-flex items-center gap-1 whitespace-nowrap">
                {syncIcon}
                {syncText}
              </span>
            </div>
            <div className="text-[11px] opacity-80">Last saved {lastSavedLabel(lastSavedAt)}</div>
            <div className="text-[11px] opacity-80">{chapterCount} chapters</div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default BookHero;
