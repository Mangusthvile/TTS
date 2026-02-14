import React from "react";
import { MoreVertical, Plus, Paperclip, Bug } from "lucide-react";
import { Theme } from "../../types";

type Props = {
  theme: Theme;
  showToolsMenu: boolean;
  setShowToolsMenu: (v: boolean) => void;
  onAddChapter?: () => void;
  onOpenAttachments?: () => void;
  debugMode?: boolean;
  onToggleDebug?: () => void;
};

const ReaderToolbar: React.FC<Props> = ({
  theme,
  showToolsMenu,
  setShowToolsMenu,
  onAddChapter,
  onOpenAttachments,
  debugMode,
  onToggleDebug,
}) => {
  return (
    <div className="flex items-center gap-1 relative">
      <button
        onClick={() => setShowToolsMenu(!showToolsMenu)}
        title="Reader tools"
        className={`p-3 rounded-xl transition-all ${theme === Theme.DARK ? 'bg-white/10 hover:bg-white/20' : 'bg-black/5 hover:bg-black/10'}`}
      >
        <MoreVertical className="w-5 h-5" />
      </button>
      {showToolsMenu && (
        <div className={`absolute right-0 top-12 z-20 min-w-[180px] rounded-2xl shadow-2xl p-2 ${theme === Theme.DARK ? 'bg-slate-900 border border-white/10' : theme === Theme.SEPIA ? 'bg-[#efe6d5] border border-black/10' : 'bg-white border border-black/10'}`}>
          {onAddChapter && (
            <button
              onClick={() => { setShowToolsMenu(false); onAddChapter(); }}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-colors ${theme === Theme.DARK ? 'hover:bg-white/10 text-slate-100' : 'hover:bg-black/5 text-slate-900'}`}
            >
              <Plus className="w-4 h-4" /> Add Chapter
            </button>
          )}
          {onOpenAttachments && (
            <button
              onClick={() => { setShowToolsMenu(false); onOpenAttachments(); }}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-colors ${theme === Theme.DARK ? 'hover:bg-white/10 text-slate-100' : 'hover:bg-black/5 text-slate-900'}`}
            >
              <Paperclip className="w-4 h-4" /> Attachments
            </button>
          )}
          {onToggleDebug && (
            <button
              onClick={() => { setShowToolsMenu(false); onToggleDebug(); }}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-colors ${theme === Theme.DARK ? 'hover:bg-white/10 text-slate-100' : 'hover:bg-black/5 text-slate-900'}`}
            >
              <Bug className="w-4 h-4" /> {debugMode ? 'Disable Debug' : 'Enable Debug'}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default ReaderToolbar;
