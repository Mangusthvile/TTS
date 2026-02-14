import React from "react";
import { AlertCircle, Cloud, CloudOff, FolderSync, Image as ImageIcon, Loader2 } from "lucide-react";
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

const BookHero: React.FC<Props> = ({ book, syncBadge, lastSavedAt, coverCardRef, coverRowRef, coverImageRef, coverMetaRef }) => {
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
        <div className="flex-1 min-w-0 flex flex-col gap-1">
          <h1 className="font-black tracking-tight text-xl sm:text-3xl line-clamp-2 heading-font">{book.title}</h1>
          <div className="text-[10px] font-black uppercase tracking-widest opacity-70">{syncBadge.backendLabel}</div>
          <div
            className={`inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-widest w-fit ${
              syncBadge.tone === "emerald"
                ? "text-emerald-500"
                : syncBadge.tone === "amber"
                  ? "text-amber-500"
                  : syncBadge.tone === "indigo"
                    ? "text-indigo-500"
                    : "text-slate-500"
            }`}
          >
            {syncBadge.statusLabel === "SYNCING" ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : syncBadge.statusLabel === "PAUSED" ? (
              <AlertCircle className="w-3 h-3" />
            ) : syncBadge.statusLabel === "NOT SYNCED" ? (
              <CloudOff className="w-3 h-3" />
            ) : syncBadge.statusLabel === "SYNCED" ? (
              <Cloud className="w-3 h-3" />
            ) : (
              <FolderSync className="w-3 h-3" />
            )}
            {syncBadge.statusLabel === "NOT SYNCED"
              ? "Not synced"
              : syncBadge.statusLabel === "SYNCING"
                ? "Syncing"
                : syncBadge.statusLabel === "PAUSED"
                  ? "Paused"
                  : syncBadge.statusLabel === "SYNCED"
                    ? "Synced"
                    : "Local"}
          </div>
          {lastSavedAt ? (
            <div className="text-[10px] font-black uppercase tracking-widest opacity-60">
              Last saved {new Date(lastSavedAt).toLocaleTimeString()}
            </div>
          ) : null}
          <div ref={coverMetaRef} className="text-[10px] font-black uppercase tracking-widest opacity-50">
            {(book.chapterCount ?? book.chapters.length)} chapters
          </div>
        </div>
      </div>
    </div>
  );
};

export default BookHero;
