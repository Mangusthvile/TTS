import React, { useState, useEffect, useMemo } from 'react';
import { Play, Pause, SkipBack, SkipForward, FastForward, Rewind, Clock, Type, AlignLeft, Sparkles, Repeat, Loader2, ChevronUp, ChevronDown, X, Settings as SettingsIcon, AlertCircle } from 'lucide-react';
import { Theme, HighlightMode } from '../types';
import { speechController } from '../services/speechService';

interface PlayerProps {
  isPlaying: boolean;
  onPlay: () => void;
  onPause: () => void;
  onStop: () => void;
  onNext: () => void;
  onPrev: () => void;
  onSeek: (delta: number) => void;
  speed: number;
  onSpeedChange: (speed: number) => void;
  selectedVoice: string;
  onVoiceChange: (voice: string) => void;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  progressChars: number; 
  totalLengthChars: number; 
  wordCount: number;
  onSeekToOffset: (offset: number) => void;
  sleepTimer: number | null;
  onSetSleepTimer: (seconds: number | null) => void;
  stopAfterChapter: boolean;
  onSetStopAfterChapter: (v: boolean) => void;
  useBookSettings: boolean;
  onSetUseBookSettings: (v: boolean) => void;
  highlightMode: HighlightMode;
  onSetHighlightMode: (v: HighlightMode) => void;
  playbackCurrentTime?: number;
  playbackDuration?: number;
  isFetching?: boolean;
  onSeekToTime?: (seconds: number) => void;
  autoplayBlocked?: boolean;
}

const formatTime = (seconds: number) => {
  if (isNaN(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
};

const Player: React.FC<PlayerProps> = ({
  isPlaying, onPlay, onPause, speed, onSpeedChange, selectedVoice, onVoiceChange,
  theme, progressChars, totalLengthChars, wordCount, onSeekToOffset,
  sleepTimer, onSetSleepTimer, stopAfterChapter, onSetStopAfterChapter,
  useBookSettings, onSetUseBookSettings, highlightMode, onSetHighlightMode,
  onNext, onPrev, onSeek, playbackCurrentTime, playbackDuration, isFetching,
  onSeekToTime, autoplayBlocked
}) => {
  const [showSleepMenu, setShowSleepMenu] = useState(false);
  const [isExpandedMobile, setIsExpandedMobile] = useState(false);
  
  const displayTime = useMemo(() => {
    if (playbackCurrentTime !== undefined && playbackCurrentTime > 0) {
      return formatTime(playbackCurrentTime / speed);
    }
    return "0:00";
  }, [playbackCurrentTime, speed]);

  const displayTotal = useMemo(() => {
    if (playbackDuration !== undefined && playbackDuration > 0) {
      return formatTime(playbackDuration / speed);
    }
    return formatTime((wordCount / (170 * speed)) * 60);
  }, [playbackDuration, wordCount, speed]);

  const handleSpeedChange = (newSpeed: number) => {
    onSpeedChange(newSpeed);
    speechController.setPlaybackRate(newSpeed);
  };

  const progressPercent = useMemo(() => {
    if (playbackDuration && playbackDuration > 0 && playbackCurrentTime !== undefined) {
      return (playbackCurrentTime / playbackDuration) * 100;
    }
    return totalLengthChars > 0 ? (progressChars / totalLengthChars) * 100 : 0;
  }, [playbackDuration, playbackCurrentTime, progressChars, totalLengthChars]);

  const handleProgressAction = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    
    if (playbackDuration && onSeekToTime) {
      onSeekToTime(ratio * playbackDuration);
    } else {
      onSeekToOffset(Math.floor(totalLengthChars * ratio));
    }
  };

  const isDark = theme === Theme.DARK;
  const isSepia = theme === Theme.SEPIA;
  const accentBg = isDark ? 'bg-indigo-500' : isSepia ? 'bg-[#9c6644]' : 'bg-indigo-600';

  return (
    <div className={`border-t transition-all duration-300 relative z-20 ${isDark ? 'bg-slate-900 border-slate-800 text-slate-100' : isSepia ? 'bg-[#efe6d5] border-[#d8ccb6] text-[#3c2f25]' : 'bg-white border-black/10 text-black'}`}>
      {autoplayBlocked && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-4 animate-bounce z-30">
          <div className="bg-amber-600 text-white px-4 py-2 rounded-xl shadow-2xl flex items-center gap-2 font-black text-[10px] uppercase tracking-widest whitespace-nowrap">
            <AlertCircle className="w-3.5 h-3.5" /> Autoplay blocked — tap Play
          </div>
        </div>
      )}
      
      <div className="max-w-5xl mx-auto">
        {/* Progress Bar & Time */}
        <div className="flex items-center gap-4 px-4 lg:px-8 pt-4">
          <span className="text-[11px] font-black font-mono opacity-60 min-w-[40px] text-left">{displayTime}</span>
          <div 
            className={`flex-1 h-3 rounded-full cursor-pointer relative flex items-center ${isDark ? 'bg-slate-800' : 'bg-black/5'}`}
            onPointerDown={handleProgressAction}
          >
            <div className={`h-1.5 rounded-full ${accentBg} transition-all duration-75 shadow-sm`} style={{ width: `${progressPercent}%` }} />
          </div>
          <span className="text-[11px] font-black font-mono opacity-60 min-w-[40px] text-right">{displayTotal}</span>
        </div>

        <div className="px-4 lg:px-8 py-2 lg:py-6 flex flex-col gap-2">
          {/* Main Control Layer */}
          <div className="flex items-center justify-between w-full">
            <button 
              onClick={() => setIsExpandedMobile(!isExpandedMobile)}
              className="lg:hidden p-3 hover:bg-black/5 rounded-xl transition-all"
              aria-label="Advanced Controls"
            >
              <SettingsIcon className={`w-6 h-6 ${isExpandedMobile ? 'text-indigo-600' : ''}`} />
            </button>

            {/* Centered Controls */}
            <div className="flex items-center gap-4 lg:gap-12 flex-1 justify-center">
              <button onClick={onPrev} className="p-3 hover:scale-110 transition-transform"><SkipBack className="w-7 h-7 lg:w-8 lg:h-8" /></button>
              <button onClick={() => onSeek(-500)} className="hidden sm:block p-3 hover:scale-110 transition-transform opacity-60"><Rewind className="w-6 h-6 lg:w-7 lg:h-7" /></button>
              <button 
                disabled={isFetching}
                onClick={isPlaying ? onPause : onPlay} 
                className={`w-14 h-14 lg:w-20 lg:h-20 text-white rounded-full flex items-center justify-center shadow-2xl ${accentBg} transition-all active:scale-90 hover:scale-105 disabled:opacity-50`}
              >
                {isFetching ? (
                  <Loader2 className="w-7 h-7 animate-spin" />
                ) : (
                  <>
                    <Play className={`w-8 h-8 lg:w-10 lg:h-10 fill-current ${isPlaying ? 'hidden' : 'block ml-1'}`} />
                    <Pause className={`w-8 h-8 lg:w-10 lg:h-10 fill-current ${isPlaying ? 'block' : 'hidden'}`} />
                  </>
                )}
              </button>
              <button onClick={() => onSeek(500)} className="hidden sm:block p-3 hover:scale-110 transition-transform opacity-60"><FastForward className="w-6 h-6 lg:w-7 lg:h-7" /></button>
              <button onClick={onNext} className="p-3 hover:scale-110 transition-transform"><SkipForward className="w-7 h-7 lg:w-8 lg:h-8" /></button>
            </div>

            {/* Desktop Sleep Timer (Standalone) */}
            <div className="hidden lg:flex items-center gap-4 relative">
              <button onClick={() => setShowSleepMenu(!showSleepMenu)} className={`flex items-center gap-2 px-5 py-3 rounded-xl border text-xs font-black shadow-sm transition-all ${sleepTimer || stopAfterChapter ? 'bg-indigo-600 text-white' : 'opacity-60'}`}><Clock className="w-4 h-4" /> {sleepTimer ? formatTime(sleepTimer / speed) : 'Sleep'}</button>
              {showSleepMenu && (
                <div className={`absolute bottom-full mb-3 right-0 w-56 rounded-2xl border shadow-2xl p-2 z-[60] ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-black/10'}`}>
                  {[15, 30, 60].map(m => <button key={m} onClick={() => { onSetSleepTimer(m * 60); setShowSleepMenu(false); }} className={`w-full text-left px-3 py-3 text-[13px] font-bold rounded-xl ${isDark ? 'hover:bg-slate-700' : 'hover:bg-black/5'}`}>{m} Minutes</button>)}
                  <div className={`h-px my-1 ${isDark ? 'bg-slate-700' : 'bg-black/5'}`} />
                  <button onClick={() => { onSetStopAfterChapter(!stopAfterChapter); setShowSleepMenu(false); }} className={`w-full text-left px-3 py-3 text-[13px] font-black rounded-xl flex items-center justify-between ${stopAfterChapter ? 'text-indigo-500' : ''}`}>Stop after Chapter <Repeat className="w-3.5 h-3.5" /></button>
                </div>
              )}
            </div>

            {/* Mobile spacer for centering */}
            <div className="lg:hidden w-12"></div>
          </div>

          {/* Advanced Controls: Always expanded on Desktop, Toggled on Mobile */}
          <div className={`${isExpandedMobile ? 'flex' : 'hidden'} lg:flex flex-col lg:flex-row items-center justify-center gap-6 lg:gap-12 py-4 lg:py-2 border-t lg:border-t-0 mt-2 lg:mt-0 animate-in slide-in-from-bottom-2`}>
            <div className="flex flex-col lg:flex-row items-center gap-6 lg:gap-12">
              <div className="flex flex-col gap-1.5 items-center lg:items-start">
                <span className="text-[10px] font-black uppercase tracking-widest opacity-60 ml-0.5">Playback Speed</span>
                <div className="flex items-center gap-3">
                  <input type="range" min="0.5" max="3.0" step="0.1" value={speed} onChange={e => handleSpeedChange(parseFloat(e.target.value))} className="h-1.5 w-32 accent-indigo-600" />
                  <span className="text-xs font-black min-w-[24px]">{speed}x</span>
                </div>
              </div>

              <div className="flex flex-col gap-1.5 items-center lg:items-start">
                <span className="text-[10px] font-black uppercase tracking-widest opacity-60 ml-0.5">Highlight Mode</span>
                <div className={`flex items-center p-1 rounded-xl gap-0.5 ${isDark ? 'bg-slate-950/40' : 'bg-black/5'}`}>
                  {[{ m: HighlightMode.WORD, i: Type }, { m: HighlightMode.SENTENCE, i: AlignLeft }, { m: HighlightMode.KARAOKE, i: Sparkles }].map(({ m, i: Icon }) => (
                    <button key={m} onClick={() => onSetHighlightMode(m)} className={`p-2.5 rounded-lg transition-all ${highlightMode === m ? accentBg + ' text-white shadow-lg' : 'opacity-40 hover:opacity-100'}`}><Icon className="w-4 h-4" /></button>
                  ))}
                </div>
              </div>
            </div>

            {/* Mobile-only Sleep Timer inside expansion drawer */}
            <div className="lg:hidden flex flex-col items-center gap-3 w-full border-t border-black/5 pt-4">
              <span className="text-[10px] font-black uppercase tracking-widest opacity-60">Sleep Timer</span>
              <div className="flex gap-2 w-full max-w-xs">
                {[15, 30].map(m => (
                  <button key={m} onClick={() => onSetSleepTimer(m * 60)} className={`flex-1 py-3 rounded-xl border text-[10px] font-black ${sleepTimer === m * 60 ? 'bg-indigo-600 text-white' : 'opacity-60'}`}>{m}m</button>
                ))}
                <button onClick={() => onSetStopAfterChapter(!stopAfterChapter)} className={`flex-1 py-3 rounded-xl border text-[10px] font-black ${stopAfterChapter ? 'bg-indigo-600 text-white' : 'opacity-60'}`}>CH Stop</button>
                {(sleepTimer || stopAfterChapter) && (
                  <button onClick={() => {onSetSleepTimer(null); onSetStopAfterChapter(false);}} className="p-3 bg-red-500/10 text-red-500 rounded-xl"><X className="w-4 h-4" /></button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Player;