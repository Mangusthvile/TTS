
import React, { useState, useEffect } from 'react';
import { 
  Play, Pause, Square, SkipBack, SkipForward, 
  Volume2, Settings, FastForward, Rewind 
} from 'lucide-react';

interface PlayerProps {
  isPlaying: boolean;
  onPlay: () => void;
  onPause: () => void;
  onStop: () => void;
  onNext: () => void;
  onPrev: () => void;
  onSeek: (seconds: number) => void;
  speed: number;
  onSpeedChange: (speed: number) => void;
  selectedVoice: string;
  onVoiceChange: (voice: string) => void;
}

const Player: React.FC<PlayerProps> = ({
  isPlaying, onPlay, onPause, onStop, onNext, onPrev, onSeek,
  speed, onSpeedChange, selectedVoice, onVoiceChange
}) => {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);

  useEffect(() => {
    const loadVoices = () => {
      const v = window.speechSynthesis.getVoices();
      setVoices(v.filter(v => v.lang.includes('en')));
    };
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
  }, []);

  return (
    <div className="bg-white border-t border-slate-200 p-4 sticky bottom-0 z-50 shadow-[0_-4px_20px_-5px_rgba(0,0,0,0.1)]">
      <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6">
        
        {/* Left: Speed & Voice */}
        <div className="flex items-center gap-4 order-2 md:order-1 shrink-0">
          <div className="flex flex-col">
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Playback Speed</label>
            <div className="flex items-center gap-2">
              <input 
                type="range" min="0.5" max="2.5" step="0.1" 
                value={speed}
                onChange={(e) => onSpeedChange(parseFloat(e.target.value))}
                className="w-24 h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-indigo-600"
              />
              <span className="text-xs font-bold text-slate-600 w-8">{speed}x</span>
            </div>
          </div>
          <div className="h-8 w-px bg-slate-100 hidden md:block"></div>
          <div className="flex flex-col">
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Voice</label>
            <select 
              value={selectedVoice}
              onChange={(e) => onVoiceChange(e.target.value)}
              className="text-xs font-medium bg-slate-50 border-none rounded-lg p-1.5 text-slate-600 focus:ring-2 focus:ring-indigo-500 outline-none max-w-[150px]"
            >
              {voices.map(v => (
                <option key={v.name} value={v.name}>{v.name}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Center: Playback Controls */}
        <div className="flex items-center gap-3 order-1 md:order-2">
          <button onClick={onPrev} className="p-2 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-full transition-all">
            <SkipBack className="w-6 h-6 fill-current" />
          </button>
          <button onClick={() => onSeek(-10)} className="p-2 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-full transition-all">
            <Rewind className="w-5 h-5" />
          </button>
          
          <button 
            onClick={isPlaying ? onPause : onPlay}
            className="w-14 h-14 bg-indigo-600 text-white rounded-full flex items-center justify-center hover:bg-indigo-700 hover:scale-105 active:scale-95 transition-all shadow-lg shadow-indigo-200"
          >
            {isPlaying ? <Pause className="w-7 h-7 fill-current" /> : <Play className="w-7 h-7 fill-current ml-1" />}
          </button>

          <button onClick={() => onSeek(10)} className="p-2 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-full transition-all">
            <FastForward className="w-5 h-5" />
          </button>
          <button onClick={onNext} className="p-2 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-full transition-all">
            <SkipForward className="w-6 h-6 fill-current" />
          </button>
          
          <div className="h-8 w-px bg-slate-100"></div>
          
          <button onClick={onStop} className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-full transition-all">
            <Square className="w-5 h-5" />
          </button>
        </div>

        {/* Right: Progress (Simplified for now) */}
        <div className="hidden lg:flex items-center gap-3 order-3">
          <div className="flex flex-col items-end">
             <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Status</span>
             <span className="text-xs font-semibold text-slate-600">{isPlaying ? 'Playing...' : 'Paused'}</span>
          </div>
          <div className="p-2 bg-slate-50 rounded-full text-slate-400">
            <Settings className="w-5 h-5" />
          </div>
        </div>

      </div>
    </div>
  );
};

export default Player;
