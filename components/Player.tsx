
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Play, Pause, SkipBack, SkipForward, FastForward, Rewind, Clock, Repeat, Loader2, ChevronUp, ChevronDown, X, Settings as SettingsIcon, AlertCircle, PlayCircle } from 'lucide-react';
import { Theme, ReaderSettings } from '../types';

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
  readerSettings: ReaderSettings;
  onUpdateReaderSettings: (settings: Partial<ReaderSettings>) => void;
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
  playbackCurrentTime?: number;
  playbackDuration?: number;
  isFetching?: boolean;
  onSeekToTime?: (targetMs: number) => void;
  autoplayBlocked?: boolean;
  onScrubStart?: () => void;
  onScrubMove?: (time: number) => void;
  onScrubEnd?: (targetMs: number) => void;
  onScrubEndOffset?: (offset: number) => void;
  isMobile: boolean;
  debugMode?: boolean;
}

const formatTime = (seconds: number) => {
  if (isNaN(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
};

const highlightPresetColors = ['#4f46e5', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6'];

const Player: React.FC<PlayerProps> = ({
  isPlaying, onPlay, onPause, speed, onSpeedChange, selectedVoice, onVoiceChange,
  theme, readerSettings, onUpdateReaderSettings, progressChars, totalLengthChars, wordCount, onSeekToOffset,
  sleepTimer, onSetSleepTimer, stopAfterChapter, onSetStopAfterChapter,
  useBookSettings, onSetUseBookSettings,
  onNext, onPrev, onSeek, playbackCurrentTime, playbackDuration, isFetching,
  onSeekToTime, autoplayBlocked, onScrubStart, onScrubMove, onScrubEnd, onScrubEndOffset, isMobile, debugMode
}) => {
  const [showSleepMenu, setShowSleepMenu] = useState(false);
  const [isExpandedMobile, setIsExpandedMobile] = useState(false);
  
  // Local state for scrubbing visualization
  const [isDragging, setIsDragging] = useState(false);
  const [dragValue, setDragValue] = useState(0);
  const progressTrackRef = useRef<HTMLDivElement | null>(null);

  const canTimeScrub =
    typeof playbackDuration === "number" &&
    playbackDuration > 0 &&
    (!!onScrubEnd || !!onSeekToTime);
  const canOffsetScrub = totalLengthChars > 0 && (!!onScrubEndOffset || !!onSeekToOffset);
  const scrubMode = canTimeScrub ? "time" : canOffsetScrub ? "offset" : "none";

  // When not dragging, sync local dragTime with actual prop
  useEffect(() => {
    if (isDragging) return;
    if (scrubMode === "time" && playbackCurrentTime !== undefined) {
      setDragValue(playbackCurrentTime);
    } else if (scrubMode === "offset") {
      setDragValue(progressChars ?? 0);
    }
  }, [isDragging, playbackCurrentTime, progressChars, scrubMode]);

  const displayTime = useMemo(() => {
    // Show drag time while dragging, else show prop
    const t = isDragging && scrubMode === "time" ? dragValue : (playbackCurrentTime || 0);
    if (t > 0) return formatTime(t / speed);
    return "0:00";
  }, [playbackCurrentTime, dragValue, isDragging, scrubMode, speed]);

  const displayTotal = useMemo(() => {
    if (playbackDuration !== undefined && playbackDuration > 0) {
      return formatTime(playbackDuration / speed);
    }
    return formatTime((wordCount / (170 * speed)) * 60);
  }, [playbackDuration, wordCount, speed]);

  const handleSpeedChange = (newSpeed: number) => {
    onSpeedChange(newSpeed);
  };

  const clamp = (value: number, min: number, max: number) => {
    if (value < min) return min;
    if (value > max) return max;
    return value;
  };

  const progressPercent = useMemo(() => {
    if (scrubMode === "time") {
      const t = isDragging ? clamp(dragValue, 0, playbackDuration || 0) : (playbackCurrentTime || 0);
      return playbackDuration && playbackDuration > 0 ? (t / playbackDuration) * 100 : 0;
    }
    if (scrubMode === "offset") {
      const o = isDragging
        ? clamp(dragValue, 0, totalLengthChars)
        : clamp(progressChars, 0, totalLengthChars);
      return totalLengthChars > 0 ? (o / totalLengthChars) * 100 : 0;
    }
    if (playbackDuration && playbackDuration > 0) {
      const t = isDragging ? clamp(dragValue, 0, playbackDuration) : (playbackCurrentTime || 0);
      return (t / playbackDuration) * 100;
    }
    return totalLengthChars > 0 ? (progressChars / totalLengthChars) * 100 : 0;
  }, [
    scrubMode,
    playbackDuration,
    playbackCurrentTime,
    progressChars,
    totalLengthChars,
    isDragging,
    dragValue,
  ]);

  const calcValueFromEvent = (e: React.PointerEvent<HTMLDivElement>, logTag?: string) => {
    const track = progressTrackRef.current ?? e.currentTarget;
    const rect = track.getBoundingClientRect();
    const width = rect.width;
    if (width < 20) {
      if (debugMode) {
        console.debug("[Player][scrub] invalid track width", { width, logTag });
      }
      if (scrubMode === "time") return playbackCurrentTime ?? 0;
      if (scrubMode === "offset") return progressChars ?? 0;
      return 0;
    }
    const ratio = clamp((e.clientX - rect.left) / width, 0, 1);
    if (debugMode && logTag) {
      const targetSec = scrubMode === "time" ? ratio * (playbackDuration || 0) : undefined;
      const targetOffset = scrubMode === "offset" ? Math.round(ratio * totalLengthChars) : undefined;
      console.debug("[Player][scrub]", {
        event: logTag,
        mode: scrubMode,
        clientX: e.clientX,
        rectLeft: rect.left,
        rectWidth: rect.width,
        ratio,
        durationSec: playbackDuration,
        targetSec,
        targetOffset,
      });
    }
    if (scrubMode === "time") {
      return ratio * (playbackDuration || 0);
    }
    if (scrubMode === "offset") {
      return Math.round(ratio * totalLengthChars);
    }
    return 0;
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (scrubMode === "none") return;
    
    // Capture pointer to track movement even outside element
    e.currentTarget.setPointerCapture(e.pointerId);
    
    setIsDragging(true);
    const value = calcValueFromEvent(e, "start");
    setDragValue(value);
    
    if (onScrubStart) onScrubStart();
    if (scrubMode === "time" && onScrubMove) onScrubMove(value);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isDragging) {
      const value = calcValueFromEvent(e);
      setDragValue(value);
      if (scrubMode === "time" && onScrubMove) onScrubMove(value);
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isDragging) {
      setIsDragging(false);
      e.currentTarget.releasePointerCapture(e.pointerId);
      const value = calcValueFromEvent(e, "end");
      
      // Commit scrub
      if (scrubMode === "time") {
        const targetMs = Math.round(value * 1000);
        if (onScrubEnd) onScrubEnd(targetMs);
        else if (onSeekToTime) onSeekToTime(targetMs);
      } else if (scrubMode === "offset") {
        if (onScrubEndOffset) onScrubEndOffset(value);
        else if (onSeekToOffset) onSeekToOffset(value);
      }
    }
  };

  const handlePointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isDragging) {
        setIsDragging(false);
        e.currentTarget.releasePointerCapture(e.pointerId);
        // Revert or commit? Commit is safer to avoid stuck state
        if (scrubMode === "time" && onScrubEnd) onScrubEnd(Math.round(dragValue * 1000));
    }
  };

  const isDark = theme === Theme.DARK;
  const isSepia = theme === Theme.SEPIA;
  const accentBg = isDark ? 'bg-indigo-500' : isSepia ? 'bg-[#9c6644]' : 'bg-indigo-600';
  const highlightColor = readerSettings.highlightColor || '#4f46e5';
  const followHighlight = readerSettings.followHighlight;

  return (
    <div className={`border-t transition-all duration-300 relative z-20 ${isDark ? 'bg-slate-900 border-slate-800 text-slate-100' : isSepia ? 'bg-[#efe6d5] border-[#d8ccb6] text-[#3c2f25]' : 'bg-white border-black/10 text-black'}`}>
      
      {/* Mobile Autoplay Blocker Overlay */}
      {autoplayBlocked && (
        <div className="absolute inset-0 z-50 bg-black/60 backdrop-blur-sm flex flex-col items-center justify-center animate-in fade-in duration-300">
           <button 
             onClick={onPlay}
             className="flex flex-col items-center gap-4 group"
           >
             <div className="p-6 bg-indigo-600 text-white rounded-full shadow-2xl group-hover:scale-110 transition-transform animate-bounce">
                <PlayCircle className="w-16 h-16" />
             </div>
             <div className="bg-white text-black px-6 py-3 rounded-2xl font-black uppercase text-xs tracking-widest shadow-xl">
               Tap to Continue
             </div>
           </button>
        </div>
      )}
      
      <div className="max-w-5xl mx-auto">
        {/* Progress Bar & Time */}
        <div className="flex items-center gap-4 px-4 lg:px-8 pt-4 select-none">
          <span className="text-[11px] font-black font-mono opacity-60 min-w-[40px] text-left">{displayTime}</span>
          <div 
            ref={progressTrackRef}
            className={`flex-1 h-4 sm:h-3 rounded-full cursor-pointer relative flex items-center touch-none ${isDark ? 'bg-slate-800' : 'bg-black/5'} ${isMobile ? 'touch-none' : ''}`}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            onPointerLeave={undefined} // handled by capture
            style={{ touchAction: 'none' }} // Critical for preventing scroll on mobile
          >
            <div className={`h-1.5 rounded-full ${accentBg} transition-all duration-75 shadow-sm pointer-events-none`} style={{ width: `${progressPercent}%` }} />
            {/* Visual thumb - larger on mobile */}
            {isDragging && (
                <div 
                    className={`absolute rounded-full shadow-lg border border-black/10 transform -translate-x-1/2 pointer-events-none bg-white ${isMobile ? 'h-6 w-6' : 'h-5 w-5'}`} 
                    style={{ left: `${progressPercent}%` }} 
                />
            )}
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
            <div className={`flex items-center ${isMobile ? 'gap-2' : 'gap-4 lg:gap-12'} flex-1 justify-center`}>
              <button onClick={onPrev} className="p-3 hover:scale-110 transition-transform"><SkipBack className="w-7 h-7 lg:w-8 lg:h-8" /></button>
              
              {/* Rewind: Always show on mobile (isMobile) OR on Desktop */}
              <button 
                onClick={() => onSeek(-10)} 
                className={`p-3 hover:scale-110 transition-transform opacity-60 ${isMobile ? 'block' : 'hidden sm:block'}`} 
                title="Back 10s"
              >
                <Rewind className="w-6 h-6 lg:w-7 lg:h-7" />
              </button>
              
              <button 
                disabled={isFetching}
                onClick={isPlaying ? onPause : onPlay} 
                className={`w-16 h-16 lg:w-20 lg:h-20 text-white rounded-full flex items-center justify-center shadow-2xl ${accentBg} transition-all active:scale-90 hover:scale-105 disabled:opacity-50`}
              >
                {isFetching ? (
                  <Loader2 className="w-8 h-8 animate-spin" />
                ) : (
                  <>
                    <Play className={`w-8 h-8 lg:w-10 lg:h-10 fill-current ${isPlaying ? 'hidden' : 'block ml-1'}`} />
                    <Pause className={`w-8 h-8 lg:w-10 lg:h-10 fill-current ${isPlaying ? 'block' : 'hidden'}`} />
                  </>
                )}
              </button>
              
              {/* Forward: Always show on mobile (isMobile) OR on Desktop */}
              <button 
                onClick={() => onSeek(10)} 
                className={`p-3 hover:scale-110 transition-transform opacity-60 ${isMobile ? 'block' : 'hidden sm:block'}`} 
                title="Forward 10s"
              >
                <FastForward className="w-6 h-6 lg:w-7 lg:h-7" />
              </button>
              
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

            </div>

            <div className="flex flex-col gap-2 w-full lg:w-auto">
              <span className="text-[10px] font-black uppercase tracking-widest opacity-60">Highlight</span>
              <label className={`flex items-center justify-between gap-4 px-3 py-2 rounded-xl border ${isDark ? 'bg-white/5 border-white/10' : 'bg-black/5 border-black/10'}`}>
                <span className="text-[10px] font-black uppercase tracking-widest">Auto-Scroll</span>
                <input
                  type="checkbox"
                  checked={followHighlight}
                  onChange={(e) => onUpdateReaderSettings({ followHighlight: e.target.checked })}
                  className="w-4 h-4 accent-indigo-600"
                />
              </label>
              <div className="flex flex-wrap gap-2 items-center">
                {highlightPresetColors.map((c) => (
                  <button
                    key={c}
                    onClick={() => onUpdateReaderSettings({ highlightColor: c })}
                    className={`w-6 h-6 rounded-full border-2 transition-transform hover:scale-110 ${highlightColor === c ? 'border-white ring-2 ring-black/20' : 'border-transparent'}`}
                    style={{ backgroundColor: c }}
                    aria-label={`Set highlight color ${c}`}
                  />
                ))}
                <input
                  type="color"
                  value={highlightColor}
                  onChange={(e) => onUpdateReaderSettings({ highlightColor: e.target.value })}
                  className="w-6 h-6 rounded-full overflow-hidden border-0 p-0 cursor-pointer"
                  aria-label="Pick highlight color"
                />
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
