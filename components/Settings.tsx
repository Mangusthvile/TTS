
import React from 'react';
import { ReaderSettings, Theme } from '../types';
import { Type, AlignJustify, MoveVertical, Minus, Plus, RefreshCw, Smartphone, MonitorOff, AlertTriangle, Cloud, CloudOff, Loader2 } from 'lucide-react';

interface SettingsProps {
  settings: ReaderSettings;
  onUpdate: (settings: Partial<ReaderSettings>) => void;
  theme: Theme;
  keepAwake: boolean;
  onSetKeepAwake: (v: boolean) => void;
  onCheckForUpdates: () => void;
  isCloudLinked?: boolean;
  onLinkCloud?: () => void;
  onSyncNow?: () => void;
  isSyncing?: boolean;
}

const Settings: React.FC<SettingsProps> = ({ 
  settings, onUpdate, theme, keepAwake, onSetKeepAwake, onCheckForUpdates,
  isCloudLinked, onLinkCloud, onSyncNow, isSyncing
}) => {
  const isDark = theme === Theme.DARK;
  const isSepia = theme === Theme.SEPIA;
  
  const cardBg = isDark ? 'bg-slate-900 border-slate-800' : isSepia ? 'bg-[#f4ecd8] border-[#d8ccb6]' : 'bg-white border-black/10';
  const textClass = isDark ? 'text-slate-100' : isSepia ? 'text-[#3c2f25]' : 'text-black';
  const labelClass = `text-[11px] font-black uppercase tracking-[0.2em] mb-4 block ${isDark ? 'text-indigo-400' : 'text-indigo-600'}`;

  const fonts = [
    { name: 'Source Serif 4', font: "'Source Serif 4', serif" },
    { name: 'Literata', font: "'Literata', serif" },
    { name: 'Inter', font: "'Inter', sans-serif" },
    { name: 'System Serif', font: "serif" },
  ];

  const controlBg = isDark ? 'bg-slate-950/40 border-slate-800' : 'bg-black/5 border-black/5';

  const isWakeLockSupported = 'wakeLock' in navigator;
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as any).MSStream;

  return (
    <div className={`p-8 h-full overflow-y-auto transition-colors duration-500 ${isDark ? 'bg-slate-900' : isSepia ? 'bg-[#efe6d5]' : 'bg-slate-50'}`}>
      <div className="max-w-2xl mx-auto space-y-12 pb-32">
        <div className="flex justify-between items-end">
          <div>
            <h2 className={`text-3xl font-black tracking-tight ${textClass}`}>Settings</h2>
            <p className={`text-sm font-bold mt-1 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>VoxLib v{ (window as any).__APP_VERSION__ || '1.2.0' }</p>
          </div>
          <button 
            onClick={onCheckForUpdates}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${isDark ? 'bg-slate-800 text-slate-100 hover:bg-slate-700' : 'bg-white text-slate-600 shadow-sm hover:bg-slate-50'}`}
          >
            <RefreshCw className="w-3 h-3" /> Check for updates
          </button>
        </div>

        {/* Cloud Sync */}
        <div className={`p-8 rounded-[2.5rem] border shadow-sm space-y-6 ${cardBg}`}>
          <label className={labelClass}>Cloud Synchronization</label>
          <div className="flex items-center justify-between gap-6">
             <div className="flex items-center gap-4 min-w-0">
                <div className={`p-4 rounded-2xl ${isCloudLinked ? 'bg-indigo-600 text-white' : 'bg-black/5 text-slate-400'}`}>
                   {isCloudLinked ? <Cloud className="w-6 h-6" /> : <CloudOff className="w-6 h-6" />}
                </div>
                <div className="min-w-0">
                   <div className={`text-sm font-black ${textClass}`}>{isCloudLinked ? 'Library Linked' : 'Offline Mode'}</div>
                   <div className="text-[10px] font-bold opacity-60 truncate">
                      {isCloudLinked ? 'Connected to Google Drive' : 'Sync libraries between PC and Mobile'}
                   </div>
                </div>
             </div>
             {isCloudLinked ? (
                <button 
                  onClick={onSyncNow}
                  disabled={isSyncing}
                  className="px-6 py-2.5 bg-indigo-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest shadow-lg flex items-center gap-2 hover:scale-105 transition-all disabled:opacity-50"
                >
                   {isSyncing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                   Sync Now
                </button>
             ) : (
                <button 
                  onClick={onLinkCloud}
                  className="px-6 py-2.5 bg-indigo-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest shadow-lg flex items-center gap-2 hover:scale-105 transition-all"
                >
                   <Cloud className="w-3 h-3" />
                   Link Account
                </button>
             )}
          </div>
          {isCloudLinked && (
            <div className="p-4 rounded-2xl bg-indigo-600/5 border border-indigo-600/10">
              <p className="text-[10px] font-bold text-indigo-600 leading-relaxed italic">
                Talevox automatically synchronizes your books and settings to a JSON manifest on your Google Drive. 
                Local Folder books sync their structure, but their raw files remain on your PC for security.
              </p>
            </div>
          )}
        </div>

        {/* System Settings */}
        <div className={`p-8 rounded-[2.5rem] border shadow-sm space-y-6 ${cardBg}`}>
          <label className={labelClass}>System</label>
          
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Smartphone className={`w-5 h-5 ${isDark ? 'text-indigo-400' : 'text-indigo-600'}`} />
              <div>
                <div className={`text-sm font-black ${textClass}`}>Keep screen awake</div>
                <div className="text-[10px] font-bold opacity-60">Prevents screen from dimming during playback</div>
              </div>
            </div>
            <button 
              disabled={!isWakeLockSupported}
              onClick={() => onSetKeepAwake(!keepAwake)}
              className={`w-12 h-6 rounded-full transition-colors relative ${!isWakeLockSupported ? 'opacity-30' : ''} ${keepAwake ? 'bg-indigo-600' : 'bg-slate-300'}`}
            >
              <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${keepAwake ? 'left-7' : 'left-1'}`} />
            </button>
          </div>
          
          {!isWakeLockSupported && (
            <div className="flex items-start gap-2 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20">
              <MonitorOff className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
              <div className="text-[10px] font-bold text-amber-600 leading-tight">Screen Wake Lock is not supported by your browser or environment.</div>
            </div>
          )}

          {isIOS && (
            <div className="flex items-start gap-2 p-3 rounded-xl bg-indigo-500/10 border border-indigo-500/20">
              <AlertTriangle className="w-4 h-4 text-indigo-500 flex-shrink-0 mt-0.5" />
              <div className="text-[10px] font-bold text-indigo-600 leading-tight">iOS Safari often limits background TTS. Installing to Home Screen and using specific voices may help, but playback might still pause when the device locks.</div>
            </div>
          )}
        </div>

        {/* Font Picker */}
        <div className={`p-8 rounded-[2.5rem] border shadow-sm ${cardBg}`}>
          <label className={labelClass}>Typography</label>
          <div className="grid grid-cols-2 gap-4">
            {fonts.map((f) => (
              <button
                key={f.name}
                onClick={() => onUpdate({ fontFamily: f.font })}
                className={`p-6 rounded-2xl border text-left transition-all hover:scale-[1.02] active:scale-95 flex flex-col items-center justify-center text-center ${
                  settings.fontFamily === f.font
                    ? 'border-indigo-600 bg-indigo-600/5 ring-1 ring-indigo-600 text-indigo-600'
                    : `border-transparent ${controlBg} ${textClass}`
                }`}
              >
                <div style={{ fontFamily: f.font }} className="text-3xl mb-2">Aa</div>
                <div className="text-[11px] font-black uppercase tracking-tight">{f.name}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Sliders Group */}
        <div className={`p-8 rounded-[2.5rem] border shadow-sm space-y-10 ${cardBg}`}>
          <div>
            <div className="flex justify-between items-center mb-5">
              <label className={labelClass}>Font Size</label>
              <span className={`text-sm font-black ${isDark ? 'text-indigo-400' : 'text-indigo-600'}`}>{settings.fontSizePx}px</span>
            </div>
            <div className="flex items-center gap-6">
              <button onClick={() => onUpdate({ fontSizePx: Math.max(12, settings.fontSizePx - 2) })} className={`p-3 rounded-xl transition-colors ${controlBg} ${textClass}`}><Minus className="w-5 h-5" /></button>
              <input 
                type="range" min="12" max="48" step="1"
                value={settings.fontSizePx}
                onChange={(e) => onUpdate({ fontSizePx: parseInt(e.target.value) })}
                className="flex-1 h-2 bg-indigo-600/20 rounded-full accent-indigo-600 cursor-pointer"
              />
              <button onClick={() => onUpdate({ fontSizePx: Math.min(48, settings.fontSizePx + 2) })} className={`p-3 rounded-xl transition-colors ${controlBg} ${textClass}`}><Plus className="w-5 h-5" /></button>
            </div>
          </div>

          <div>
            <div className="flex justify-between items-center mb-5">
              <label className={labelClass}>Line Height</label>
              <span className={`text-sm font-black ${isDark ? 'text-indigo-400' : 'text-indigo-600'}`}>{settings.lineHeight.toFixed(1)}</span>
            </div>
            <div className="flex items-center gap-6">
              <button onClick={() => onUpdate({ lineHeight: Math.max(1, settings.lineHeight - 0.1) })} className={`p-3 rounded-xl transition-colors ${controlBg} ${textClass}`}><Minus className="w-5 h-5" /></button>
              <input 
                type="range" min="1" max="2.5" step="0.1"
                value={settings.lineHeight}
                onChange={(e) => onUpdate({ lineHeight: parseFloat(e.target.value) })}
                className="flex-1 h-2 bg-indigo-600/20 rounded-full accent-indigo-600 cursor-pointer"
              />
              <button onClick={() => onUpdate({ lineHeight: Math.min(2.5, settings.lineHeight + 0.1) })} className={`p-3 rounded-xl transition-colors ${controlBg} ${textClass}`}><Plus className="w-5 h-5" /></button>
            </div>
          </div>
        </div>

        <div className={`p-8 rounded-[2.5rem] border shadow-sm ${cardBg}`}>
           <label className={labelClass}>Paragraph Spacing</label>
           <div className={`flex p-1 rounded-2xl gap-1 ${isDark ? 'bg-slate-950/40' : 'bg-black/5'}`}>
              <button 
                onClick={() => onUpdate({ paragraphSpacing: 1 })}
                className={`flex-1 flex items-center justify-center gap-3 py-4 rounded-xl text-xs font-black transition-all ${settings.paragraphSpacing === 1 ? (isDark ? 'bg-white/10 text-white shadow-md' : 'bg-white text-black shadow-md') : 'opacity-60 hover:opacity-100'}`}
              >
                <AlignJustify className="w-4 h-4" /> Compact
              </button>
              <button 
                onClick={() => onUpdate({ paragraphSpacing: 2 })}
                className={`flex-1 flex items-center justify-center gap-3 py-4 rounded-xl text-xs font-black transition-all ${settings.paragraphSpacing === 2 ? (isDark ? 'bg-white/10 text-white shadow-md' : 'bg-white text-black shadow-md') : 'opacity-60 hover:opacity-100'}`}
              >
                <MoveVertical className="w-4 h-4" /> Wide
              </button>
           </div>
        </div>

        <div className={`text-center font-black uppercase tracking-[0.4em] text-[11px] pt-12 ${isDark ? 'text-white/20' : 'text-black/30'}`}>
          VoxLib Engine v{ (window as any).__APP_VERSION__ || '1.2.0' }
        </div>
      </div>
    </div>
  );
};

export default Settings;
