import React from "react";
import { CheckSquare, MoreVertical, Repeat2, X } from "lucide-react";

type Props = {
  tapTarget: string;
  selectedCount: number;
  onClose: () => void;
  onSelectAll: () => void;
  onInvert: () => void;
  showOverflow: boolean;
  onToggleOverflow: () => void;
  onAssignVolume: () => void;
  canAssign: boolean;
  isDark: boolean;
};

const SelectionBar: React.FC<Props> = ({
  tapTarget,
  selectedCount,
  onClose,
  onSelectAll,
  onInvert,
  showOverflow,
  onToggleOverflow,
  onAssignVolume,
  canAssign,
  isDark,
}) => {
  return (
    <div className="p-3 flex items-center justify-between gap-3">
      <button
        onClick={onClose}
        className={`${tapTarget} flex items-center justify-center rounded-xl bg-black/5 hover:bg-black/10`}
        title="Close selection"
      >
        <X className="w-4 h-4" />
      </button>
      <div className="font-black text-xs uppercase tracking-widest">{selectedCount} selected</div>
      <div className="flex items-center gap-1">
        <button
          onClick={onSelectAll}
          className={`${tapTarget} flex items-center justify-center rounded-xl bg-black/5 hover:bg-black/10`}
          title="Select all visible"
        >
          <CheckSquare className="w-4 h-4" />
        </button>
        <button
          onClick={onInvert}
          className={`${tapTarget} flex items-center justify-center rounded-xl bg-black/5 hover:bg-black/10`}
          title="Invert selection"
        >
          <Repeat2 className="w-4 h-4" />
        </button>
        <div className="relative">
          <button
            onClick={onToggleOverflow}
            className={`${tapTarget} flex items-center justify-center rounded-xl bg-black/5 hover:bg-black/10`}
            title="More"
          >
            <MoreVertical className="w-4 h-4" />
          </button>
          {showOverflow ? (
            <div
              className={`absolute right-0 mt-2 w-44 rounded-2xl border shadow-2xl p-2 z-[60] ${
                isDark ? "bg-slate-900 border-white/10" : "bg-white border-black/10"
              }`}
            >
              <button
                onClick={onAssignVolume}
                disabled={!canAssign}
                className={`w-full text-left px-3 py-2 rounded-xl text-xs font-black ${
                  canAssign ? "hover:bg-black/5" : "opacity-40 cursor-not-allowed"
                }`}
              >
                Assign Volume
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};

export default SelectionBar;
