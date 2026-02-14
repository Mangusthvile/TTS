import React from "react";
import { AlignJustify, ChevronLeft, LayoutGrid, MoreVertical, Search, Wrench } from "lucide-react";

type Props = {
  title: string;
  tapTarget: string;
  viewMode: "sections" | "grid";
  onBack: () => void;
  onToggleSearch: () => void;
  onOpenSettings: () => void;
  onSetViewMode: (mode: "sections" | "grid") => void;
  showOverflow: boolean;
  onToggleOverflow: () => void;
  onOpenSettingsFromMenu: () => void;
  onToggleOrganize: () => void;
  isOrganizeMode: boolean;
  onCheck: () => void;
  onReindex: () => void;
  onFix: () => void;
  onAddVolume: () => void;
  showAddVolume: boolean;
  hasIssues: boolean;
  isDark: boolean;
};

const BookTopBar: React.FC<Props> = ({
  title,
  tapTarget,
  viewMode,
  onBack,
  onToggleSearch,
  onOpenSettings,
  onSetViewMode,
  showOverflow,
  onToggleOverflow,
  onOpenSettingsFromMenu,
  onToggleOrganize,
  isOrganizeMode,
  onCheck,
  onReindex,
  onFix,
  onAddVolume,
  showAddVolume,
  hasIssues,
  isDark,
}) => {
  return (
    <div className="p-3 flex items-center justify-between gap-3">
      <button
        onClick={onBack}
        className={`${tapTarget} flex items-center justify-center rounded-xl bg-black/5 hover:bg-black/10`}
        title="Back"
      >
        <ChevronLeft className="w-4 h-4" />
      </button>
      <div className="flex-1 min-w-0 text-center font-black text-sm truncate" aria-label={title} />
      <div className="flex items-center gap-1.5">
        <button
          onClick={onToggleSearch}
          className={`${tapTarget} flex items-center justify-center rounded-xl bg-black/5 hover:bg-black/10`}
          title="Search"
        >
          <Search className="w-4 h-4" />
        </button>
        <button
          onClick={onToggleOrganize}
          className={`${tapTarget} flex items-center justify-center rounded-xl ${isOrganizeMode ? "bg-indigo-500/20 text-indigo-600" : "bg-black/5 hover:bg-black/10"}`}
          title={isOrganizeMode ? "Done organizing" : "Organize"}
        >
          <Wrench className="w-4 h-4" />
        </button>
        <div className="flex items-center gap-1 p-1 rounded-xl bg-black/5">
          <button
            onClick={() => onSetViewMode("sections")}
            className={`p-1.5 rounded-lg transition-all ${viewMode === "sections" ? "bg-white shadow-sm text-indigo-600" : "opacity-40"}`}
            title="Sections"
          >
            <AlignJustify className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => onSetViewMode("grid")}
            className={`p-1.5 rounded-lg transition-all ${viewMode === "grid" ? "bg-white shadow-sm text-indigo-600" : "opacity-40"}`}
            title="Grid"
          >
            <LayoutGrid className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="relative">
          <button
            onClick={onToggleOverflow}
            className={`${tapTarget} flex items-center justify-center rounded-xl bg-black/5 hover:bg-black/10`}
            title="More"
          >
            <MoreVertical className="w-4 h-4" />
          </button>
          {showOverflow ? (
            <div className={`absolute right-0 mt-2 w-56 rounded-2xl border shadow-2xl p-2 z-[60] ${isDark ? "bg-slate-900 border-white/10" : "bg-white border-black/10"}`}>
              <button
                onClick={onOpenSettingsFromMenu}
                className="w-full text-left px-3 py-2 rounded-xl text-xs font-black hover:bg-black/5"
              >
                Book Settings
              </button>
              <button
                onClick={onCheck}
                className="w-full text-left px-3 py-2 rounded-xl text-xs font-black hover:bg-black/5"
              >
                Check
              </button>
              <button
                onClick={onReindex}
                className="w-full text-left px-3 py-2 rounded-xl text-xs font-black hover:bg-black/5"
              >
                Reindex
              </button>
              <button
                onClick={onFix}
                disabled={!hasIssues}
                className={`w-full text-left px-3 py-2 rounded-xl text-xs font-black ${hasIssues ? "hover:bg-black/5" : "opacity-40 cursor-not-allowed"}`}
              >
                Fix
              </button>
              {showAddVolume ? (
                <button
                  onClick={onAddVolume}
                  className="w-full text-left px-3 py-2 rounded-xl text-xs font-black hover:bg-black/5"
                >
                  Add Volume
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};

export default BookTopBar;
