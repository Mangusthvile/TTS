
import React from 'react';
import { Chapter, Rule } from '../types';
import { applyRules } from '../services/speechService';

interface ReaderProps {
  chapter: Chapter | null;
  rules: Rule[];
  currentOffset: number;
}

const Reader: React.FC<ReaderProps> = ({ chapter, rules, currentOffset }) => {
  if (!chapter) {
    return (
      <div className="flex-1 flex items-center justify-center bg-white p-8">
        <div className="text-center max-w-md">
          <h2 className="text-2xl font-bold text-slate-300 mb-2">No Chapter Selected</h2>
          <p className="text-slate-400">Select a chapter from your library or extract a new one from a URL to begin reading.</p>
        </div>
      </div>
    );
  }

  // To highlight current word, we split text
  const beforeText = chapter.content.substring(0, currentOffset);
  const restText = chapter.content.substring(currentOffset);
  
  // Find the end of the current word
  const nextSpace = restText.search(/\s/);
  const currentWord = nextSpace === -1 ? restText : restText.substring(0, nextSpace);
  const afterText = nextSpace === -1 ? '' : restText.substring(nextSpace);

  return (
    <div className="flex-1 bg-white overflow-y-auto p-12 lg:p-24 selection:bg-indigo-100">
      <div className="max-w-3xl mx-auto">
        <div className="mb-12 border-b border-slate-100 pb-8">
          <h1 className="text-4xl font-extrabold text-black mb-4">{chapter.title}</h1>
          <div className="flex items-center gap-4 text-slate-500 text-sm font-medium">
            <span>Chapter {chapter.index}</span>
            <span>•</span>
            <span>{chapter.wordCount} words</span>
            {chapter.sourceUrl && (
              <>
                <span>•</span>
                <a href={chapter.sourceUrl} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">Source</a>
              </>
            )}
          </div>
        </div>
        
        <div className="prose prose-slate prose-lg max-w-none leading-relaxed text-black whitespace-pre-wrap font-normal">
          {beforeText}
          <span className="bg-indigo-600 text-white rounded px-0.5 shadow-sm transition-all duration-150">
            {currentWord}
          </span>
          {afterText}
        </div>
      </div>
    </div>
  );
};

export default Reader;
