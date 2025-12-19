import React from 'react';
import { ReaderSettings, Theme } from '../types';
import { Type, AlignJustify, MoveVertical, Minus, Plus, RefreshCw, Smartphone, MonitorOff, AlertTriangle, Cloud, CloudOff, Loader2, Key, LogOut } from 'lucide-react';

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
  googleClientId?: string;
  onUpdateGoogleClientId?: (id: string) => void;
  onClearAuth?: () => void;
}

const Settings: React.FC<SettingsProps> = ({ 
  settings, onUpdate, theme, keepAwake, onSetKeepAwake, onCheckForUpdates,
  isCloudLinked, onLinkCloud, onSyncNow, isSyncing,
  googleClientId, onUpdateGoogleClientId, onClearAuth
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

  const controlBg = isDark ? 'bg-slate-950/40 border-slate-800' : isSepia ? 'bg-[#efe6d5] border-[#d8ccb6]' : 'bg-white border-black/5';

  const isWakeLockSupported = 'wakeLock' in navigator;

  return (
    <div className={`p-4 sm:p-8 h-full overflow-y-auto transition-colors duration-500 ${isDark ? 'bg-slate-900' : isSepia ? 'bg-[#efe6d5]' : 'bg-slate-50'}`}>
      <div className="max-w-2xl mx-auto space-y-8 sm:space-y-12 pb-32">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-end gap-4">
          <div>
            <h2 className={`text-2xl sm:text-3xl font-black tracking-tight ${textClass}`}>Settings</h2>
            <p className={`text-xs sm:text-sm font-bold mt-1 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>VoxLib Engine v2.4.2</p>
          </div>
          <button 
            onClick={onCheckForUpdates}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all shadow-sm ${isDark ? 'bg-slate-800 text-slate-100 hover:bg-slate-700' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
          >
            <RefreshCw className="w-3.5 h-3.5" /> Force Refresh App
          </button>
        </div>

        {/* Cloud Sync */}
        <div className={`p-5 sm:p-8 rounded-[1.5rem] sm:rounded-[2.5rem] border shadow-sm space-y-6 ${cardBg}`}>
          <label className={labelClass}>Cloud Synchronization</label>

          <div className="space-y-4">
             <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2 mb-1">
                   <Key className="w-3.5 h-3.5 text-indigo-500" />
                   <span className="text-[10px] font-black uppercase tracking-widest opacity-60">Google OAuth Client ID</span>
                </div>
                <input 
                  type="text"
                  value={googleClientId || ''}
                  onChange={e => onUpdateGoogleClientId?.(e.target.value.trim())}
                  placeholder="...apps.googleusercontent.com"
                  className={`w-full px-4 py-3 rounded-xl border-none outline-none font-mono text-[16px] ${isDark ? 'bg-slate-950 text-white' : 'bg-slate-50 text-black'}`}
                />
                <p className="text-[9px] font-bold opacity-40 leading-relaxed">
                   Authorized Origin: <span className="text-indigo-500 select-all font-mono">{window.location.origin}</span>
                </p>
             </div>

             <div className="flex flex-col gap-6 pt-4 border-t border-black/5 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex items-center gap-4 min-w-0">
                   <div className={`p-3.5 sm:p-4 rounded-2xl flex-shrink-0 ${isCloudLinked ? 'bg-indigo-600 text-white' : 'bg-black/5 text-slate-400'}`}>
                      {isCloudLinked ? <Cloud className="w-5 h-5 sm:w-6 sm:h-6" /> : <CloudOff className="w-5 h-5 sm:w-6 sm:h-6" />}
                   </div>
                   <div className="min-w-0">
                      <div className={`text-sm font-black ${textClass}`}>{isCloudLinked ? 'Library Linked' : 'Offline Mode'}</div>
                      <div className="text-[10px] font-bold opacity-60 truncate">
                         {isCloudLinked ? 'Syncing to Google Drive' : 'Sync libraries across devices'}
                      </div>
                   </div>
                </div>
                <div className="flex items-center gap-2 w-full sm:w-auto">
                   {isCloudLinked ? (
                      <>
                        <button 
                          onClick={onSyncNow}
                          disabled={isSyncing}
                          className="flex-1 sm:flex-none px-6 py-3 bg-indigo-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest shadow-lg flex items-center justify-center gap-2 hover:scale-105 transition-all disabled:opacity-50"
                        >
                           {isSyncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                           Sync
                        </button>
                        <button 
                          onClick={onClearAuth}
                          className={`p-3 rounded-xl border transition-all ${isDark ? 'bg-slate-800 text-slate-400 hover:text-red-500' : 'bg-white text-slate-400 hover:text-red-600'}`}
                          title="Unlink Account"
                        >
                           <LogOut className="w-4 h-4" />
                        </button>
                      </>
                   ) : (
                      <button 
                        onClick={onLinkCloud}
                        className="w-full sm:w-auto px-8 py-4 bg-indigo-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest shadow-lg flex items-center justify-center gap-2 hover:scale-105 transition-all"
                      >
                         <Cloud className="w-3.5 h-3.5" />
                         Link Account
                      </button>
                   )}
                </div>
             </div>
          </div>
        </div>

        {/* System Settings */}
        <div className={`p-5 sm:p-8 rounded-[1.5rem] sm:rounded-[2.5rem] border shadow-sm space-y-6 ${cardBg}`}>
          <label className={labelClass}>System</label>
          
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Smartphone className={`w-5 h-5 ${isDark ? 'text-indigo-400' : 'text-indigo-600'}`} />
              <div>
                <div className={`text-sm font-black ${textClass}`}>Keep screen awake</div>
                <div className="text-[10px] font-bold opacity-60">Prevents dimming during playback</div>
              </div>
            </div>
            <button 
              disabled={!isWakeLockSupported}
              onClick={() => onSetKeepAwake(!keepAwake)}
              className={`w-14 h-7 rounded-full transition-colors relative ${!isWakeLockSupported ? 'opacity-30' : ''} ${keepAwake ? 'bg-indigo-600' : 'bg-slate-300'}`}
            >
              <div className={`absolute top-1 w-5 h-5 bg-white rounded-full transition-all ${keepAwake ? 'left-8' : 'left-1'}`} />
            </button>
          </div>
        </div>

        {/* Font Picker */}
        <div className={`p-5 sm:p-8 rounded-[1.5rem] sm:rounded-[2.5rem] border shadow-sm ${cardBg}`}>
          <label className={labelClass}>Typography</label>
          <div className="grid grid-cols-2 gap-3 sm:gap-4">
            {fonts.map((f) => (
              <button
                key={f.name}
                onClick={() => onUpdate({ fontFamily: f.font })}
                className={`p-4 sm:p-6 rounded-2xl border text-left transition-all hover:scale-[1.02] flex flex-col items-center justify-center text-center ${
                  settings.fontFamily === f.font
                    ? 'border-indigo-600 bg-indigo-600/5 ring-1 ring-indigo-600 text-indigo-600'
                    : `border-transparent ${controlBg} ${textClass}`
                }`}
              >
                <div style={{ fontFamily: f.font }} className="text-2xl sm:text-3xl mb-1 sm:mb-2">Aa</div>
                <div className="text-[9px] sm:text-[11px] font-black uppercase tracking-tight">{f.name}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Sliders Group */}
        <div className={`p-5 sm:p-8 rounded-[1.5rem] sm:rounded-[2.5rem] border shadow-sm space-y-8 sm:space-y-10 ${cardBg}`}>
          <div>
            <div className="flex justify-between items-center mb-4 sm:mb-5">
              <label className={labelClass}>Font Size</label>
              <span className={`text-sm font-black ${isDark ? 'text-indigo-400' : 'text-indigo-600'}`}>{settings.fontSizePx}px</span>
            </div>
            <div className="flex items-center gap-4 sm:gap-6">
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
        </div>

        <div className="text-center font-black uppercase tracking-[0.4em] text-[9px] sm:text-[11px] pt-8 sm:pt-12 opacity-30">
          VoxLib Engine v2.4.2
        </div>
      </div>
    </div>
  );
};

export default Settings;