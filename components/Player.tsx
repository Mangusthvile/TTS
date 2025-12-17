
import React, { useState, useEffect } from 'react';
import { 
  Play, Pause, SkipBack, SkipForward, 
  FastForward, Rewind, Clock, Type, 
  AlignLeft, Sparkles, ChevronUp, Repeat, Volume2
} from 'lucide-react';
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
}

const formatTime = (seconds: number) => {
  if (isNaN(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
};

const Player: React.FC<PlayerProps> = ({
  isPlaying, onPlay, onPause, onStop, onNext, onPrev, onSeek,
  speed, onSpeedChange, selectedVoice, onVoiceChange,
  theme, onThemeChange, progress, totalLength, wordCount, onSeekToOffset,
  sleepTimer, onSetSleepTimer, stopAfterChapter, onSetStopAfterChapter,
  useBookSettings, onSetUseBookSettings, highlightMode, onSetHighlightMode
}) => {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [showSleepMenu, setShowSleepMenu] = useState(false);

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
  const totalSeconds = Math.max(1, (wordCount / (170 * speed)) * 60);
  const elapsedSeconds = totalSeconds * (progress / Math.max(1, totalLength));

  const isDark = theme === Theme.DARK;
  const isSepia = theme === Theme.SEPIA;
  const accentBg = isDark ? 'bg-indigo-500' : isSepia ? 'bg-[#9c6644]' : 'bg-indigo-600';
  const controlBg = isDark ? 'bg-slate-800 border-slate-700' : isSepia ? 'bg-[#f4ecd8] border-[#d8ccb6]' : 'bg-slate-100 border-black/5';
  const textPrimary = isDark ? 'text-slate-100' : isSepia ? 'text-[#3c2f25]' : 'text-black';
  const textSecondary = isDark ? 'text-slate-400' : isSepia ? 'text-[#3c2f25]/70' : 'text-slate-600';

  return (
    <div className={`border-t transition-colors duration-500 relative z-20 ${isDark ? 'bg-slate-900 border-slate-800 text-slate-100' : isSepia ? 'bg-[#efe6d5] border-[#d8ccb6] text-[#3c2f25]' : 'bg-white border-black/10 text-black'}`}>
      <div className="flex items-center gap-4 px-4 lg:px-8 pt-4">
        <span className={`text-[11px] font-black font-mono ${textSecondary}`}>{formatTime(elapsedSeconds)}</span>
        <div 
          className={`flex-1 h-2 rounded-full cursor-pointer relative ${isDark ? 'bg-slate-800' : 'bg-black/5'}`}
          onClick={e => {
            const rect = e.currentTarget.getBoundingClientRect();
            onSeekToOffset(Math.floor(totalLength * ((e.clientX - rect.left) / rect.width)));
          }}
        >
          <div className={`h-full rounded-full ${accentBg} transition-all duration-300 shadow-sm`} style={{ width: `${progressPercent}%` }} />
        </div>
        <span className={`text-[11px] font-black font-mono ${textSecondary}`}>{formatTime(totalSeconds)}</span>
      </div>

      <div className="max-w-7xl mx-auto px-4 lg:px-8 py-4 lg:py-6 flex flex-col gap-6">
        <div className="flex flex-col lg:flex-row items-center justify-between gap-6">
          
          {/* Settings & Voice */}
          <div className="flex flex-wrap items-center justify-center lg:justify-start gap-4 lg:gap-8 w-full lg:w-auto">
            <div className="flex flex-col gap-1.5">
              <span className={`text-[10px] font-black uppercase tracking-widest ${textSecondary}`}>Speed</span>
              <div className="flex items-center gap-2">
                <button onClick={() => onSetUseBookSettings(!useBookSettings)} className={`px-2.5 py-1 rounded-lg text-[10px] font-black border transition-all ${useBookSettings ? 'bg-indigo-600 text-white border-indigo-500' : isDark ? 'bg-slate-800 border-slate-700 text-slate-100' : 'bg-black/5 border-black/5 text-black'}`}>{useBookSettings ? 'Book' : 'Global'}</button>
                <div className="flex items-center gap-2">
                  <input type="range" min="0.5" max="3.0" step="0.1" value={speed} onChange={e => onSpeedChange(parseFloat(e.target.value))} className="h-1.5 w-16 accent-indigo-600" />
                  <span className={`text-xs font-black min-w-[20px] ${textPrimary}`}>{speed}x</span>
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <span className={`text-[10px] font-black uppercase tracking-widest ${textSecondary}`}>Highlight</span>
              <div className={`flex items-center p-1 rounded-xl gap-0.5 ${isDark ? 'bg-slate-950/40' : 'bg-black/5'}`}>
                {[{ m: HighlightMode.WORD, i: Type }, { m: HighlightMode.SENTENCE, i: AlignLeft }, { m: HighlightMode.KARAOKE, i: Sparkles }].map(({ m, i: Icon }) => (
                  <button key={m} onClick={() => onSetHighlightMode(m)} className={`p-2 rounded-lg transition-all ${highlightMode === m ? accentBg + ' text-white' : isDark ? 'text-slate-400 hover:text-white' : 'text-slate-600 hover:text-black'}`}><Icon className="w-4 h-4" /></button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <span className={`text-[10px] font-black uppercase tracking-widest ${textSecondary}`}>Voice</span>
              <select value={selectedVoice} onChange={e => onVoiceChange(e.target.value)} className={`text-[11px] font-black bg-transparent outline-none max-w-[140px] truncate ${textPrimary} cursor-pointer`}>
                {voices.map(v => <option key={v.name} value={v.name} className={isDark ? 'bg-slate-800 text-slate-100' : 'bg-white text-black'}>{v.name}</option>)}
              </select>
            </div>
          </div>

          {/* Main Controls */}
          <div className="flex items-center gap-4 lg:gap-8 order-first lg:order-none">
            <button onClick={onPrev} className={`p-2 hover:scale-110 transition-transform ${textPrimary}`}><SkipBack className="w-6 h-6 lg:w-8 lg:h-8" /></button>
            <button onClick={() => onSeek(-500)} className={`p-2 hover:scale-110 transition-transform ${textSecondary}`}><Rewind className="w-5 h-5 lg:w-6 lg:h-6" /></button>
            <button onClick={isPlaying ? onPause : onPlay} className={`w-14 h-14 lg:w-18 lg:h-18 text-white rounded-full flex items-center justify-center shadow-xl ${accentBg} transition-all active:scale-90 hover:scale-105`}><Play className={`w-7 h-7 fill-current ${isPlaying ? 'hidden' : 'block ml-1'}`} /><Pause className={`w-7 h-7 fill-current ${isPlaying ? 'block' : 'hidden'}`} /></button>
            <button onClick={() => onSeek(500)} className={`p-2 hover:scale-110 transition-transform ${textSecondary}`}><FastForward className="w-5 h-5 lg:w-6 lg:h-6" /></button>
            <button onClick={onNext} className={`p-2 hover:scale-110 transition-transform ${textPrimary}`}><SkipForward className="w-6 h-6 lg:w-8 lg:h-8" /></button>
          </div>

          {/* Extra Group */}
          <div className="hidden lg:flex items-center gap-4">
            <div className="relative">
              <button onClick={() => setShowSleepMenu(!showSleepMenu)} className={`flex items-center gap-2 px-5 py-2.5 rounded-xl border text-xs font-black shadow-sm transition-all ${sleepTimer || stopAfterChapter ? 'bg-indigo-600 text-white border-indigo-600' : controlBg + ' ' + textPrimary}`}><Clock className="w-4 h-4" /> {sleepTimer ? formatTime(sleepTimer) : 'Sleep'}</button>
              {showSleepMenu && (
                <div className={`absolute bottom-full mb-3 right-0 w-56 rounded-2xl border shadow-2xl p-2 z-[60] animate-in fade-in slide-in-from-bottom-2 ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-black/10'}`}>
                  <p className={`text-[10px] font-black uppercase px-3 py-2 ${textSecondary}`}>Timer</p>
                  {[15, 30, 60].map(m => <button key={m} onClick={() => { onSetSleepTimer(m * 60); setShowSleepMenu(false); }} className={`w-full text-left px-3 py-2.5 text-[13px] font-bold rounded-xl transition-colors ${isDark ? 'hover:bg-slate-700 text-slate-100' : 'hover:bg-black/5 text-black'}`}>{m} Minutes</button>)}
                  <div className={`h-px my-1 ${isDark ? 'bg-slate-700' : 'bg-black/5'}`} />
                  <button onClick={() => { onSetStopAfterChapter(!stopAfterChapter); setShowSleepMenu(false); }} className={`w-full text-left px-3 py-2.5 text-[13px] font-black rounded-xl flex items-center justify-between transition-colors ${stopAfterChapter ? 'text-indigo-500 bg-indigo-500/5' : isDark ? 'hover:bg-slate-700 text-slate-100' : 'hover:bg-black/5 text-black'}`}>Stop after Chapter <Repeat className="w-3.5 h-3.5" /></button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Player;
