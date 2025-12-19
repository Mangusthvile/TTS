import React, { useState, useEffect, useMemo } from 'react';
import { Play, Pause, SkipBack, SkipForward, FastForward, Rewind, Clock, Type, AlignLeft, Sparkles, Repeat } from 'lucide-react';
import { Theme, HighlightMode } from '../types';

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
  progress: number;
  totalLength: number;
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
}

const formatTime = (seconds: number) => {
  if (isNaN(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
};

const Player: React.FC<PlayerProps> = ({
  isPlaying, onPlay, onPause, speed, onSpeedChange, selectedVoice, onVoiceChange,
  theme, progress, totalLength, wordCount, onSeekToOffset,
  sleepTimer, onSetSleepTimer, stopAfterChapter, onSetStopAfterChapter,
  useBookSettings, onSetUseBookSettings, highlightMode, onSetHighlightMode,
  onNext, onPrev, onSeek, playbackCurrentTime, playbackDuration
}) => {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [showSleepMenu, setShowSleepMenu] = useState(false);
  
  // High-precision time display using real audio metadata if available
  const totalSecondsEstimate = useMemo(() => Math.max(1, (wordCount / (170 * speed)) * 60), [wordCount, speed]);
  const elapsedSecondsEstimate = useMemo(() => totalSecondsEstimate * (progress / Math.max(1, totalLength)), [totalSecondsEstimate, progress, totalLength]);

  const displayTime = playbackCurrentTime !== undefined && isPlaying ? formatTime(playbackCurrentTime) : formatTime(elapsedSecondsEstimate);
  const displayTotal = playbackDuration !== undefined && isPlaying && playbackDuration > 0 ? formatTime(playbackDuration) : formatTime(totalSecondsEstimate);

  useEffect(() => {
    const loadVoices = () => {
      const v = window.speechSynthesis.getVoices();
      const finalVoices = v.filter(v => v.lang.includes('en')).length > 0 ? v.filter(v => v.lang.includes('en')) : v;
      setVoices(finalVoices);
      if (!selectedVoice && finalVoices.length > 0) onVoiceChange(finalVoices[0].name);
    };
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
  }, [selectedVoice, onVoiceChange]);

  const progressPercent = totalLength > 0 ? (progress / totalLength) * 100 : 0;

  const isDark = theme === Theme.DARK;
  const isSepia = theme === Theme.SEPIA;
  const accentBg = isDark ? 'bg-indigo-500' : isSepia ? 'bg-[#9c6644]' : 'bg-indigo-600';

  return (
    <div className={`border-t transition-colors duration-500 relative z-20 ${isDark ? 'bg-slate-900 border-slate-800 text-slate-100' : isSepia ? 'bg-[#efe6d5] border-[#d8ccb6] text-[#3c2f25]' : 'bg-white border-black/10 text-black'}`}>
      <div className="flex items-center gap-4 px-4 lg:px-8 pt-4">
        <span className="text-[11px] font-black font-mono opacity-60 min-w-[40px]">{displayTime}</span>
        <div 
          className={`flex-1 h-1.5 rounded-full cursor-pointer relative ${isDark ? 'bg-slate-800' : 'bg-black/5'}`}
          onClick={e => {
            const rect = e.currentTarget.getBoundingClientRect();
            onSeekToOffset(Math.floor(totalLength * ((e.clientX - rect.left) / rect.width)));
          }}
        >
          <div className={`h-full rounded-full ${accentBg} transition-all duration-75 shadow-sm`} style={{ width: `${progressPercent}%` }} />
        </div>
        <span className="text-[11px] font-black font-mono opacity-60 min-w-[40px]">{displayTotal}</span>
      </div>

      <div className="max-w-7xl mx-auto px-4 lg:px-8 py-4 lg:py-6 flex flex-col gap-6">
        <div className="flex flex-col lg:flex-row items-center justify-between gap-6">
          <div className="flex flex-wrap items-center justify-center lg:justify-start gap-4 lg:gap-8 w-full lg:w-auto">
            <div className="flex flex-col gap-1.5">
              <span className="text-[10px] font-black uppercase tracking-widest opacity-60">Speed</span>
              <div className="flex items-center gap-2">
                <button onClick={() => onSetUseBookSettings(!useBookSettings)} className={`px-2.5 py-1 rounded-lg text-[10px] font-black border transition-all ${useBookSettings ? 'bg-indigo-600 text-white border-indigo-500' : 'bg-black/5 text-inherit opacity-60'}`}>{useBookSettings ? 'Book' : 'Global'}</button>
                <input type="range" min="0.5" max="3.0" step="0.1" value={speed} onChange={e => onSpeedChange(parseFloat(e.target.value))} className="h-1.5 w-16 accent-indigo-600" />
                <span className="text-xs font-black min-w-[20px]">{speed}x</span>
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-[10px] font-black uppercase tracking-widest opacity-60">Highlight</span>
              <div className={`flex items-center p-1 rounded-xl gap-0.5 ${isDark ? 'bg-slate-950/40' : 'bg-black/5'}`}>
                {[{ m: HighlightMode.WORD, i: Type }, { m: HighlightMode.SENTENCE, i: AlignLeft }, { m: HighlightMode.KARAOKE, i: Sparkles }].map(({ m, i: Icon }) => (
                  <button key={m} onClick={() => onSetHighlightMode(m)} className={`p-2 rounded-lg transition-all ${highlightMode === m ? accentBg + ' text-white' : 'opacity-40 hover:opacity-100'}`}><Icon className="w-4 h-4" /></button>
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-[10px] font-black uppercase tracking-widest opacity-60">Voice</span>
              <select value={selectedVoice} onChange={e => onVoiceChange(e.target.value)} className="text-[11px] font-black bg-transparent outline-none max-w-[140px] truncate cursor-pointer">
                {voices.map(v => <option key={v.name} value={v.name} className={isDark ? 'bg-slate-800 text-slate-100' : 'bg-white text-black'}>{v.name}</option>)}
              </select>
            </div>
          </div>

          <div className="flex items-center gap-4 lg:gap-8 order-first lg:order-none">
            <button onClick={onPrev} className="p-2 hover:scale-110 transition-transform"><SkipBack className="w-6 h-6 lg:w-8 lg:h-8" /></button>
            <button onClick={() => onSeek(-500)} className="p-2 hover:scale-110 transition-transform opacity-60"><Rewind className="w-5 h-5 lg:w-6 lg:h-6" /></button>
            <button onClick={isPlaying ? onPause : onPlay} className={`w-14 h-14 lg:w-16 lg:h-16 text-white rounded-full flex items-center justify-center shadow-xl ${accentBg} transition-all active:scale-90 hover:scale-105`}><Play className={`w-7 h-7 fill-current ${isPlaying ? 'hidden' : 'block ml-1'}`} /><Pause className={`w-7 h-7 fill-current ${isPlaying ? 'block' : 'hidden'}`} /></button>
            <button onClick={() => onSeek(500)} className="p-2 hover:scale-110 transition-transform opacity-60"><FastForward className="w-5 h-5 lg:w-6 lg:h-6" /></button>
            <button onClick={onNext} className="p-2 hover:scale-110 transition-transform"><SkipForward className="w-6 h-6 lg:w-8 lg:h-8" /></button>
          </div>

          <div className="hidden lg:flex items-center gap-4 relative">
            <button onClick={() => setShowSleepMenu(!showSleepMenu)} className={`flex items-center gap-2 px-5 py-2.5 rounded-xl border text-xs font-black shadow-sm transition-all ${sleepTimer || stopAfterChapter ? 'bg-indigo-600 text-white' : 'opacity-60'}`}><Clock className="w-4 h-4" /> {sleepTimer ? formatTime(sleepTimer) : 'Sleep'}</button>
            {showSleepMenu && (
              <div className={`absolute bottom-full mb-3 right-0 w-56 rounded-2xl border shadow-2xl p-2 z-[60] ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-black/10'}`}>
                {[15, 30, 60].map(m => <button key={m} onClick={() => { onSetSleepTimer(m * 60); setShowSleepMenu(false); }} className={`w-full text-left px-3 py-2.5 text-[13px] font-bold rounded-xl ${isDark ? 'hover:bg-slate-700' : 'hover:bg-black/5'}`}>{m} Minutes</button>)}
                <div className={`h-px my-1 ${isDark ? 'bg-slate-700' : 'bg-black/5'}`} />
                <button onClick={() => { onSetStopAfterChapter(!stopAfterChapter); setShowSleepMenu(false); }} className={`w-full text-left px-3 py-2.5 text-[13px] font-black rounded-xl flex items-center justify-between ${stopAfterChapter ? 'text-indigo-500' : ''}`}>Stop after Chapter <Repeat className="w-3.5 h-3.5" /></button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default Player;