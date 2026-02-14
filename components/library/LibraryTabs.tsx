import React from "react";

type Tab = { id: string; label: string };

type Props = {
  tabs?: Tab[];
  activeId?: string;
  onSelect?: (id: string) => void;
};

const LibraryTabs: React.FC<Props> = ({ tabs, activeId, onSelect }) => {
  if (!tabs || tabs.length === 0) return null;
  return (
    <div className="px-6 sm:px-10 pt-4 flex items-center gap-3 overflow-x-auto no-scrollbar">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onSelect?.(tab.id)}
          className={`px-3 py-2 rounded-full text-[10px] font-black uppercase tracking-widest transition-all ${
            tab.id === activeId ? "bg-indigo-600 text-white" : "bg-black/5 text-theme"
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
};

export default LibraryTabs;
