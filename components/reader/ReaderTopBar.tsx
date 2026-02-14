import React from "react";
import { ChevronLeft } from "lucide-react";
import { Theme, type Chapter } from "../../types";

type Props = {
  chapter: Chapter | null;
  onBack?: () => void;
  theme: Theme;
  showHighlightPending: boolean;
  themeMuted: string;
  debugMode: boolean;
  cueMeta?: { method?: string; count?: number };
  activeCueIndex?: number | null;
  onRegenerateCueMap?: () => void;
  children?: React.ReactNode;
};

const ReaderTopBar: React.FC<Props> = ({
  chapter,
  onBack,
  theme,
  showHighlightPending,
  themeMuted,
  debugMode,
  cueMeta,
  activeCueIndex,
  onRegenerateCueMap,
  children,
}) => {
  return (
    <div className={`mb-10 border-b pb-6 flex justify-between items-end select-none ${theme === Theme.DARK ? 'border-white/10' : theme === Theme.SEPIA ? 'border-black/10' : 'border-black/10'}`}>
      <div className="flex-1 min-w-0 pr-4">
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-[color:var(--tvx-accent)] mb-4 hover:translate-x-[-2px] transition-transform"
        >
          <ChevronLeft className="w-3 h-3" /> Back
        </button>
        <div className="text-[11px] font-black uppercase tracking-widest text-[color:var(--tvx-accent)] mb-1">Chapter {chapter?.index || 0}</div>
        <h1 className="text-3xl lg:text-5xl font-black tracking-tight leading-tight truncate heading-font">{chapter?.title || "Untitled"}</h1>
        {showHighlightPending && (
          <div className="mt-2 text-[10px] font-black uppercase tracking-widest" style={{ color: themeMuted }}>
            Highlight generating...
          </div>
        )}
        {debugMode && (
          <div className="mt-2 text-[10px] font-mono text-indigo-400 flex items-center gap-3">
            <span>Cues: {cueMeta?.count ?? 'n/a'}</span>
            <span>Method: {cueMeta?.method ?? 'n/a'}</span>
            <span>Active idx: {activeCueIndex ?? '--'}</span>
            {onRegenerateCueMap && chapter && (
              <button
                onClick={onRegenerateCueMap}
                className="px-2 py-1 rounded bg-indigo-700 text-white text-[10px] font-black uppercase tracking-widest"
              >
                Regenerate cue map
              </button>
            )}
          </div>
        )}
      </div>
      {children}
    </div>
  );
};

export default ReaderTopBar;
