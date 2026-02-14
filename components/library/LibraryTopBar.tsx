import React from "react";
import { BookOpen, Plus } from "lucide-react";

type Props = {
  title: string;
  headerIconColor: string;
  textPrimary: string;
  onAdd: () => void;
};

const LibraryTopBar: React.FC<Props> = ({ title, headerIconColor, textPrimary, onAdd }) => {
  return (
    <div className="px-6 sm:px-10 pt-10 sm:pt-12 flex items-center justify-between flex-shrink-0">
      <div className="flex items-center gap-3">
        <BookOpen className={`w-7 h-7 sm:w-8 sm:h-8 ${headerIconColor}`} />
        <h2 className={`text-3xl sm:text-4xl font-black tracking-tight heading-font ${textPrimary}`}>{title}</h2>
      </div>

      <button
        onClick={onAdd}
        className="w-12 h-12 rounded-full flex items-center justify-center shadow-xl transition-all active:scale-95 btn-primary"
        aria-label="Add Book"
      >
        <Plus className="w-6 h-6" />
      </button>
    </div>
  );
};

export default LibraryTopBar;
