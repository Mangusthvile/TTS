
import React, { useMemo, useState } from 'react';
import { Chapter, Theme } from '../types';
import { List, Grid, FileText, Plus, Clock, Star } from 'lucide-react';

interface FolderViewProps {
  chapters: Chapter[];
  onSelectChapter: (id: string) => void;
  onAddChapter: () => void;
  theme: Theme;
}

const FolderView: React.FC<FolderViewProps> = ({ chapters, onSelectChapter, onAddChapter, theme }) => {
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [collapsedVolumes, setCollapsedVolumes] = useState<Record<string, boolean>>({});

  const isDark = theme === Theme.DARK;
  const isSepia = theme === Theme.SEPIA;
  const textClass = isDark ? 'text-slate-100' : isSepia ? 'text-[#3c2f25]' : 'text-slate-900';
  const cardClass = isDark ? 'bg-slate-800 hover:bg-slate-700 border-slate-700' : isSepia ? 'bg-[#f4ecd8] hover:bg-[#e6d8b5] border-[#d8ccb6]' : 'bg-white hover:bg-slate-50 border-slate-200';

  const volumeGroups = useMemo(() => {
    const groups = new Map<string, Chapter[]>();
    for (const ch of chapters || []) {
      const volumeName =
        typeof (ch as any).volumeName === "string" && (ch as any).volumeName.trim().length
          ? String((ch as any).volumeName).trim()
          : "Ungrouped";
      const arr = groups.get(volumeName) || [];
      arr.push(ch);
      groups.set(volumeName, arr);
    }

    const parsed = Array.from(groups.entries()).map(([volumeName, items]) => {
      const m = volumeName.match(/^(book|volume)\s*(\d+)/i);
      const volumeNumber = m ? parseInt(m[2], 10) : null;
      const sorted = [...items].sort((a, b) => a.index - b.index);
      return { volumeName, volumeNumber: Number.isFinite(volumeNumber) ? volumeNumber : null, chapters: sorted };
    });

    const NONE = 1_000_000_000;
    parsed.sort((a, b) => {
      const aUngrouped = a.volumeName.toLowerCase() === "ungrouped";
      const bUngrouped = b.volumeName.toLowerCase() === "ungrouped";
      if (aUngrouped !== bUngrouped) return aUngrouped ? 1 : -1;

      const aN = a.volumeNumber ?? NONE;
      const bN = b.volumeNumber ?? NONE;
      if (aN !== bN) return aN - bN;

      return a.volumeName.localeCompare(b.volumeName, undefined, { numeric: true });
    });

    return parsed;
  }, [chapters]);

  if (chapters.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-12 text-center">
        <div className={`p-6 rounded-full mb-6 ${isDark ? 'bg-slate-800' : 'bg-indigo-50 text-indigo-600'}`}>
          <FileText className="w-12 h-12 opacity-20" />
        </div>
        <h3 className={`text-xl font-bold mb-2 ${textClass}`}>No chapters yet</h3>
        <p className="text-sm opacity-50 max-w-xs mb-8">Add your first chapter to start reading with Talevox.</p>
        <button 
          onClick={onAddChapter}
          className="flex items-center gap-2 px-6 py-3 bg-indigo-600 text-white rounded-2xl font-bold shadow-lg hover:scale-105 transition-transform"
        >
          <Plus className="w-5 h-5" /> Add First Chapter
        </button>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="p-8 pb-4 flex items-center justify-between">
        <div>
          <h2 className={`text-2xl font-bold ${textClass}`}>Chapters</h2>
          <p className="text-xs opacity-50 font-bold uppercase tracking-widest">{chapters.length} files found</p>
        </div>
        <div className="flex items-center gap-2 p-1 rounded-xl bg-black/5">
          <button 
            onClick={() => setViewMode('list')}
            className={`p-1.5 rounded-lg transition-all ${viewMode === 'list' ? 'bg-white shadow-sm text-indigo-600' : 'opacity-40'}`}
          >
            <List className="w-4 h-4" />
          </button>
          <button 
            onClick={() => setViewMode('grid')}
            className={`p-1.5 rounded-lg transition-all ${viewMode === 'grid' ? 'bg-white shadow-sm text-indigo-600' : 'opacity-40'}`}
          >
            <Grid className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-8 pt-4">
        {viewMode === 'grid' ? (
          <div className="space-y-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              <button
                onClick={onAddChapter}
                className={`p-6 rounded-2xl border-2 border-dashed flex flex-col items-center justify-center gap-3 transition-all ${isDark ? 'border-slate-800 text-slate-500 hover:border-indigo-500 hover:text-indigo-400' : 'border-slate-200 text-slate-400 hover:border-indigo-500 hover:text-indigo-600'}`}
              >
                <Plus className="w-8 h-8" />
                <span className="text-xs font-bold uppercase tracking-widest">Add Chapter</span>
              </button>
            </div>

            {volumeGroups.map((group) => {
              const isCollapsed = !!collapsedVolumes[group.volumeName];
              return (
                <div key={group.volumeName}>
                  <button
                    onClick={() =>
                      setCollapsedVolumes((p) => ({ ...p, [group.volumeName]: !p[group.volumeName] }))
                    }
                    className={`w-full flex items-center justify-between px-2 py-2 rounded-xl ${isDark ? "hover:bg-slate-800" : "hover:bg-black/5"}`}
                  >
                    <div className={`text-xs font-black uppercase tracking-widest opacity-60 ${textClass}`}>
                      {group.volumeName}
                    </div>
                    <div className="text-[10px] font-black uppercase tracking-widest opacity-50">
                      {group.chapters.length} {isCollapsed ? "· +" : "· –"}
                    </div>
                  </button>

                  {!isCollapsed && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 mt-3">
                      {group.chapters.map((chapter) => {
                        const local = Number((chapter as any).volumeLocalChapter);
                        const localLabel = Number.isFinite(local) && local > 0 ? `Ch ${local}` : null;
                        return (
                          <div
                            key={chapter.id}
                            onClick={() => onSelectChapter(chapter.id)}
                            className={`p-6 rounded-2xl border transition-all cursor-pointer group flex flex-col h-40 justify-between ${cardClass}`}
                          >
                            <div className="flex justify-between items-start">
                              <div className={`p-2 rounded-xl ${isDark ? 'bg-slate-900 text-indigo-400' : 'bg-indigo-50 text-indigo-600'}`}>
                                <FileText className="w-5 h-5" />
                              </div>
                              {chapter.isFavorite && <Star className="w-4 h-4 text-amber-500 fill-current" />}
                            </div>
                            <div>
                              <div className="text-[10px] font-mono font-bold opacity-30 mb-1">
                                {localLabel ? `${localLabel} · ` : ""}#{chapter.index.toString().padStart(3, '0')}
                              </div>
                              <h4 className={`font-bold text-sm line-clamp-2 ${textClass}`}>{chapter.title}</h4>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="space-y-6">
            {volumeGroups.map((group) => {
              const isCollapsed = !!collapsedVolumes[group.volumeName];
              return (
                <div key={group.volumeName}>
                  <button
                    onClick={() =>
                      setCollapsedVolumes((p) => ({ ...p, [group.volumeName]: !p[group.volumeName] }))
                    }
                    className={`w-full flex items-center justify-between px-2 py-2 rounded-xl ${isDark ? "hover:bg-slate-800" : "hover:bg-black/5"}`}
                  >
                    <div className={`text-xs font-black uppercase tracking-widest opacity-60 ${textClass}`}>
                      {group.volumeName}
                    </div>
                    <div className="text-[10px] font-black uppercase tracking-widest opacity-50">
                      {group.chapters.length} {isCollapsed ? "· +" : "· –"}
                    </div>
                  </button>

                  {!isCollapsed && (
                    <div className="space-y-1 mt-2">
                      {group.chapters.map((chapter) => {
                        const local = Number((chapter as any).volumeLocalChapter);
                        const localLabel = Number.isFinite(local) && local > 0 ? `Ch ${local} · ` : "";
                        return (
                          <div
                            key={chapter.id}
                            onClick={() => onSelectChapter(chapter.id)}
                            className={`flex items-center gap-4 p-4 rounded-xl border cursor-pointer transition-all ${cardClass}`}
                          >
                            <div className={`p-2 rounded-lg ${isDark ? 'bg-slate-900 text-indigo-400' : 'bg-indigo-50 text-indigo-600'}`}>
                              <FileText className="w-4 h-4" />
                            </div>
                            <div className="font-mono text-xs opacity-30 w-24">
                              {localLabel}#{chapter.index.toString().padStart(3, '0')}
                            </div>
                            <div className={`flex-1 font-bold text-sm truncate ${textClass}`}>{chapter.title}</div>
                            {chapter.isFavorite && <Star className="w-3.5 h-3.5 text-amber-500 fill-current" />}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}

            <button
              onClick={onAddChapter}
              className={`w-full flex items-center gap-4 p-4 rounded-xl border-2 border-dashed mt-2 transition-all ${isDark ? 'border-slate-800 text-slate-500 hover:text-indigo-400' : 'border-slate-200 text-slate-400 hover:text-indigo-600'}`}
            >
              <Plus className="w-4 h-4" />
              <span className="text-xs font-bold uppercase tracking-widest">Add New Chapter</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default FolderView;
