import React from "react";
import { Cloud, RotateCcw, Trash2, Check, RefreshCw, FolderInput } from "lucide-react";

type Props = {
  isDark: boolean;
  canBulkUpload: boolean;
  selectedCount: number;
  onUpload: () => void;
  onRegen: () => void;
  onAssignVolume: () => void;
  onDone: () => void;
  onReset: () => void;
  onDelete: () => void;
};

const BulkActionDock: React.FC<Props> = ({
  isDark,
  canBulkUpload,
  selectedCount,
  onUpload,
  onRegen,
  onAssignVolume,
  onDone,
  onReset,
  onDelete,
}) => {
  return (
    <div
      className={`fixed bottom-0 left-0 right-0 z-50 border-t px-3 pt-2 pb-[calc(env(safe-area-inset-bottom)+12px)] ${
        isDark ? "bg-slate-950/80 border-slate-700 backdrop-blur" : "bg-white/90 border-black/10 backdrop-blur"
      }`}
    >
      <div className="grid grid-cols-3 gap-2">
        <button
          onClick={onUpload}
          disabled={!selectedCount || !canBulkUpload}
          className={`px-2 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest ${
            selectedCount && canBulkUpload ? "bg-black/5 hover:bg-black/10" : "opacity-40 bg-black/5 cursor-not-allowed"
          }`}
        >
          <Cloud className="w-4 h-4 mx-auto mb-1" />
          Upload
        </button>
        <button
          onClick={onRegen}
          disabled={!selectedCount}
          className={`px-2 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest ${
            selectedCount ? "bg-black/5 hover:bg-black/10" : "opacity-40 bg-black/5 cursor-not-allowed"
          }`}
        >
          <RotateCcw className="w-4 h-4 mx-auto mb-1" />
          Regen Audio
        </button>
        <button
          onClick={onAssignVolume}
          disabled={!selectedCount}
          className={`px-2 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest ${
            selectedCount ? "bg-black/5 hover:bg-black/10" : "opacity-40 bg-black/5 cursor-not-allowed"
          }`}
        >
          <FolderInput className="w-4 h-4 mx-auto mb-1" />
          Volume
        </button>
        <button
          onClick={onDone}
          disabled={!selectedCount}
          className={`px-2 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest ${
            selectedCount ? "bg-black/5 hover:bg-black/10" : "opacity-40 bg-black/5 cursor-not-allowed"
          }`}
        >
          <Check className="w-4 h-4 mx-auto mb-1" />
          Done
        </button>
        <button
          onClick={onReset}
          disabled={!selectedCount}
          className={`px-2 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest ${
            selectedCount ? "bg-black/5 hover:bg-black/10" : "opacity-40 bg-black/5 cursor-not-allowed"
          }`}
        >
          <RefreshCw className="w-4 h-4 mx-auto mb-1" />
          Reset
        </button>
        <button
          onClick={onDelete}
          disabled={!selectedCount}
          className={`px-2 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest ${
            selectedCount ? "bg-red-500/10 text-red-500 hover:bg-red-500/20" : "opacity-40 bg-black/5 cursor-not-allowed"
          }`}
        >
          <Trash2 className="w-4 h-4 mx-auto mb-1" />
          Delete
        </button>
      </div>
    </div>
  );
};

export default BulkActionDock;
