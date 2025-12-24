
import React from 'react';
import { ReaderSettings, Theme } from '../types';
import { Type, RefreshCw, Smartphone, Cloud, CloudOff, Loader2, Key, LogOut, Save, LogIn, Palette, Eye } from 'lucide-react';

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
  onSaveState?: () => void;
  lastSavedAt?: number;
}

const Settings: React.FC<SettingsProps> = ({ 
  settings, onUpdate, theme, keepAwake, onSetKeepAwake, onCheckForUpdates,
  isCloudLinked, onLinkCloud, onSyncNow, isSyncing,
  googleClientId, onUpdateGoogleClientId, onClearAuth,
  onSaveState, lastSavedAt
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
  const presetColors = ['#4f46e5', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6'];
  const isWakeLockSupported = 'wakeLock' in navigator;

  return (
    <div className={`p-4 sm:p-8 h-full overflow-y-auto transition-colors duration-500 ${isDark ? 'bg-slate-900' : isSepia ? 'bg-[#efe6d5]' : 'bg-slate-50'}`}>
      <div className="max-w-2xl mx-auto space-y-8 sm:space-y-12 pb-32">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-end gap-4">
          <div>
            <h2 className={`text-2xl sm:text-3xl font-black tracking-tight ${textClass}`}>Settings</h2>
            <p className={`text-xs sm:text-sm font-bold mt-1 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>VoxLib Engine v2.6.10</p>
          </div>
          <button 
            onClick={onCheckForUpdates} 
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-[10px] font-black uppercase transition-all shadow-sm ${isDark ? 'bg-slate-800 text-slate-100 hover:bg-slate-700' : isSepia ? 'bg-[#f4ecd8] text-[#3c2f25] hover:opacity-80' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
          >
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
        </div>

        <div className={`p-5 sm:p-8 rounded-[1.5rem] border shadow-sm space-y-6 ${cardBg}`}>
          <label className={labelClass}>Cloud & Identity</label>
          <div className="space-y-4">
             <input type="text" value={googleClientId || ''} onChange={e => onUpdateGoogleClientId?.(e.target.value.trim())} placeholder="Google OAuth Client ID" className={`w-full px-4 py-3 rounded-xl border-none outline-none font-mono text-[16px] ${isDark ? 'bg-slate-950 text-white' : 'bg-slate-50 text-black'}`} />
             <div className="flex flex-col gap-6 pt-4 border-t border-black/5 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex items-center gap-4">
                   <div className={`p-4 rounded-2xl ${isCloudLinked ? 'bg-indigo-600 text-white' : 'bg-black/5'}`}>{isCloudLinked ? <Cloud className="w-6 h-6" /> : <CloudOff className="w-6 h-6" />}</div>
                   <div><div className={`text-sm font-black ${textClass}`}>{isCloudLinked ? 'Library Linked' : 'Offline'}</div><div className="text-[10px] opacity-60">Sync state via snapshot</div></div>
                </div>
                <div className="flex flex-wrap gap-2">
                   <button onClick={onSaveState} className="p-3 rounded-xl border border-emerald-500/30 text-emerald-500" title="Freeze Snapshot"><Save className="w-4 h-4" /></button>
                   {isCloudLinked ? (
                      <>
                        <button onClick={onLinkCloud} title="Reconnect" className="p-3 rounded-xl border border-amber-500/30 text-amber-500"><LogIn className="w-4 h-4" /></button>
                        <button onClick={onSyncNow} disabled={isSyncing} className="px-6 py-3 bg-indigo-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest shadow-lg flex items-center gap-2">
                           {isSyncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Sync Now
                        </button>
                        <button onClick={onClearAuth} className="p-3 rounded-xl border opacity-40 hover:text-red-500 hover:border-red-500 transition-colors"><LogOut className="w-4 h-4" /></button>
                      </>
                   ) : <button onClick={onLinkCloud} disabled={!googleClientId} className="px-8 py-4 bg-indigo-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest">Link Account</button>}
                </div>
             </div>
          </div>
        </div>

        <div className={`p-5 sm:p-8 rounded-[1.5rem] border shadow-sm space-y-6 ${cardBg}`}>
          <label className={labelClass}>Reader Experience</label>
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Eye className={`w-5 h-5 ${isDark ? 'text-indigo-400' : 'text-indigo-600'}`} />
                <div className={`text-sm font-black ${textClass}`}>Follow Highlight</div>
              </div>
              <button onClick={() => onUpdate({ followHighlight: !settings.followHighlight })} className={`w-14 h-7 rounded-full transition-colors relative ${settings.followHighlight ? 'bg-indigo-600' : 'bg-slate-300'}`}>
                <div className={`absolute top-1 w-5 h-5 bg-white rounded-full transition-all ${settings.followHighlight ? 'left-8' : 'left-1'}`} />
              </button>
            </div>
            <div className="flex items-center justify-between border-t border-black/5 pt-4">
              <div className="flex items-center gap-3">
                <Smartphone className={`w-5 h-5 ${isDark ? 'text-indigo-400' : 'text-indigo-600'}`} />
                <div className={`text-sm font-black ${textClass}`}>Keep screen awake</div>
              </div>
              <button disabled={!isWakeLockSupported} onClick={() => onSetKeepAwake(!keepAwake)} className={`w-14 h-7 rounded-full transition-colors relative ${!isWakeLockSupported ? 'opacity-30' : ''} ${keepAwake ? 'bg-indigo-600' : 'bg-slate-300'}`}>
                <div className={`absolute top-1 w-5 h-5 bg-white rounded-full transition-all ${keepAwake ? 'left-8' : 'left-1'}`} />
              </button>
            </div>
          </div>
        </div>

        <div className={`p-5 sm:p-8 rounded-[1.5rem] border shadow-sm space-y-6 ${cardBg}`}>
          <label className={labelClass}>Visual Customization</label>
          <div className="space-y-6">
            <div className="space-y-4">
              <div className="flex justify-between items-center"><span className={`text-sm font-black ${textClass}`}>Font Size</span><span className="text-xs font-mono font-black opacity-60">{settings.fontSizePx}px</span></div>
              <input type="range" min="16" max="40" value={settings.fontSizePx} onChange={e => onUpdate({ fontSizePx: parseInt(e.target.value) })} className="w-full h-1.5 accent-indigo-600 rounded-full cursor-pointer" />
            </div>
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <div className="flex items-center gap-2"><Palette className={`w-5 h-5 ${isDark ? 'text-indigo-400' : 'text-indigo-600'}`} /><span className={`text-sm font-black ${textClass}`}>Highlight Color</span></div>
                <input type="color" value={settings.highlightColor} onChange={e => onUpdate({ highlightColor: e.target.value })} className="w-8 h-8 rounded-lg border-none bg-transparent cursor-pointer" />
              </div>
              <div className="flex flex-wrap gap-3">
                {presetColors.map(color => (
                  <button key={color} onClick={() => onUpdate({ highlightColor: color })} className={`w-8 h-8 rounded-full border-2 transition-all ${settings.highlightColor === color ? 'border-white ring-2 ring-indigo-600' : 'border-transparent opacity-60'}`} style={{ backgroundColor: color }} />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Settings;
