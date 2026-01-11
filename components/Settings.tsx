import React, { useState, useEffect, useMemo } from 'react';
import { ReaderSettings, Theme, SyncDiagnostics } from '../types';
import { RefreshCw, Cloud, CloudOff, Loader2, LogOut, Save, LogIn, Check, Sun, Coffee, Moon, FolderSync, Wrench, AlertTriangle, ChevronDown, ChevronUp, Terminal, Timer, ClipboardCopy, FileWarning, Bug, Smartphone, Type, Palette } from 'lucide-react';
import { getAuthSessionInfo, isTokenValid, getValidDriveToken } from '../services/driveAuth';

interface SettingsProps {
  settings: ReaderSettings;
  onUpdate: (settings: Partial<ReaderSettings>) => void;
  theme: Theme;
  onSetTheme: (theme: Theme) => void;
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
  driveRootName?: string;
  onSelectRoot?: () => void;
  onRunMigration?: () => void;
  syncDiagnostics?: SyncDiagnostics;
  autoSaveInterval: number;
  onSetAutoSaveInterval: (v: number) => void;
  isDirty?: boolean;
  showDiagnostics: boolean;
  onSetShowDiagnostics: (v: boolean) => void;
}

const Settings: React.FC<SettingsProps> = ({ 
  settings, onUpdate, theme, onSetTheme, keepAwake, onSetKeepAwake, onCheckForUpdates,
  onLinkCloud, onSyncNow, isSyncing,
  googleClientId, onUpdateGoogleClientId, onClearAuth,
  onSaveState, lastSavedAt,
  driveRootName, onSelectRoot, onRunMigration,
  syncDiagnostics, autoSaveInterval, onSetAutoSaveInterval, isDirty,
  showDiagnostics, onSetShowDiagnostics
}) => {
  const [session, setSession] = useState(getAuthSessionInfo());
  const [isDiagExpanded, setIsDiagExpanded] = useState(false);
  
  const lastFatalError = useMemo(() => {
    try {
      const raw = localStorage.getItem("talevox_last_fatal_error");
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }, []);

  useEffect(() => {
    const handleAuthChange = () => setSession(getAuthSessionInfo());
    window.addEventListener('talevox_auth_changed', handleAuthChange);
    window.addEventListener('talevox_auth_invalid', handleAuthChange);
    return () => {
      window.removeEventListener('talevox_auth_changed', handleAuthChange);
      window.removeEventListener('talevox_auth_invalid', handleAuthChange);
    };
  }, []);

  const isDark = theme === Theme.DARK;
  const isSepia = theme === Theme.SEPIA;
  const cardBg = isDark ? 'bg-slate-900 border-slate-800' : isSepia ? 'bg-[#f4ecd8] border-[#d8ccb6]' : 'bg-white border-black/10';
  const textClass = isDark ? 'text-slate-100' : isSepia ? 'text-[#3c2f25]' : 'text-black';
  const labelClass = `text-[11px] font-black uppercase tracking-[0.2em] mb-4 block ${isDark ? 'text-indigo-400' : 'text-indigo-600'}`;
  
  const isAuthorized = isTokenValid();
  const expiryMinutes = session.expiresAt > 0 ? Math.max(0, Math.round((session.expiresAt - Date.now()) / 60000)) : 0;

  const themes = [
    { id: Theme.LIGHT, name: 'Light Mode', icon: Sun, desc: 'Clean high contrast', color: 'bg-white border-slate-200' },
    { id: Theme.SEPIA, name: 'Sepia Mode', icon: Coffee, desc: 'Eye-friendly reading', color: 'bg-[#f4ecd8] border-[#d8ccb6]' },
    { id: Theme.DARK, name: 'Night Mode', icon: Moon, desc: 'Optimized for dark', color: 'bg-slate-950 border-slate-800' }
  ];

  const presetColors = ['#4f46e5', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6'];

  const handleCopyDiagnostics = () => {
    const data = {
      sync: syncDiagnostics,
      fatal: lastFatalError,
      version: window.__APP_VERSION__,
      userAgent: navigator.userAgent
    };
    navigator.clipboard.writeText(JSON.stringify(data, null, 2));
    alert("Full diagnostics copied to clipboard");
  };

  return (
    <div className={`p-4 sm:p-8 h-full overflow-y-auto transition-colors duration-500 ${isDark ? 'bg-slate-900' : isSepia ? 'bg-[#efe6d5]' : 'bg-slate-50'}`}>
      <div className="max-w-2xl mx-auto space-y-8 sm:space-y-12 pb-32">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-end gap-4">
          <div>
            <h2 className={`text-2xl sm:text-3xl font-black tracking-tight ${textClass}`}>Settings</h2>
            <p className={`text-xs sm:text-sm font-bold mt-1 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>VoxLib Engine v{window.__APP_VERSION__}</p>
          </div>
          <button 
            onClick={onCheckForUpdates} 
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-[10px] font-black uppercase transition-all shadow-sm ${isDark ? 'bg-slate-800 text-slate-100 hover:bg-slate-700' : isSepia ? 'bg-[#f4ecd8] text-[#3c2f25] hover:opacity-80' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
          >
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
        </div>

        {/* 1. Interface Appearance */}
        <div className={`p-5 sm:p-8 rounded-[1.5rem] border shadow-sm space-y-6 ${cardBg}`}>
          <label className={labelClass}>Interface Appearance</label>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {themes.map((t) => {
              const Icon = t.icon;
              const isActive = theme === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => onSetTheme(t.id)}
                  className={`flex flex-col items-center gap-3 p-5 rounded-2xl border-2 transition-all group relative ${t.color} ${isActive ? 'border-indigo-600 ring-4 ring-indigo-600/10' : 'hover:border-indigo-400 opacity-60 hover:opacity-100'}`}
                >
                  {isActive && <div className="absolute top-2 right-2 bg-indigo-600 text-white rounded-full p-0.5"><Check className="w-3 h-3" /></div>}
                  <Icon className={`w-6 h-6 ${isActive ? 'text-indigo-600' : ''}`} />
                  <div className="text-center">
                    <div className={`text-[11px] font-black uppercase tracking-tight ${textClass}`}>{t.name}</div>
                    <div className="text-[9px] font-bold opacity-40 mt-0.5">{t.desc}</div>
                  </div>
                </button>
              );
            })}
          </div>
          
          <div className="pt-4 border-t border-black/5">
             <label className="flex items-center justify-between cursor-pointer group">
               <div className="flex items-center gap-3">
                  <div className={`p-2.5 rounded-xl ${keepAwake ? 'bg-indigo-600 text-white' : 'bg-black/5 opacity-50'}`}><Smartphone className="w-4 h-4" /></div>
                  <div>
                     <div className={`text-sm font-black ${textClass}`}>Keep Awake</div>
                     <div className="text-[10px] opacity-60 font-bold">Prevent screen from sleeping while reading</div>
                  </div>
               </div>
               <div className={`w-12 h-6 rounded-full p-1 transition-all ${keepAwake ? 'bg-indigo-600' : 'bg-slate-200'}`}>
                  <input type="checkbox" className="hidden" checked={keepAwake} onChange={e => onSetKeepAwake(e.target.checked)} />
                  <div className={`w-4 h-4 rounded-full bg-white shadow-sm transition-all ${keepAwake ? 'translate-x-6' : ''}`} />
               </div>
             </label>
          </div>
        </div>
        
        {/* 2. Reading Experience */}
        <div className={`p-5 sm:p-8 rounded-[1.5rem] border shadow-sm space-y-6 ${cardBg}`}>
          <label className={labelClass}>Reading Experience</label>
          <div className="space-y-6">
            <div className="space-y-3">
               <div className="flex items-center justify-between">
                  <span className={`text-xs font-black uppercase opacity-60 flex items-center gap-2`}><Type className="w-3.5 h-3.5" /> Font Size</span>
                  <span className="text-xs font-black">{settings.fontSizePx}px</span>
               </div>
               <input type="range" min="14" max="32" step="1" value={settings.fontSizePx} onChange={e => onUpdate({ fontSizePx: parseInt(e.target.value) })} className="w-full h-1.5 bg-black/10 rounded-full appearance-none accent-indigo-600" />
            </div>

            <div className="space-y-3">
               <div className="flex items-center justify-between">
                  <span className={`text-xs font-black uppercase opacity-60 flex items-center gap-2`}><Palette className="w-3.5 h-3.5" /> Highlight Color</span>
                  <div className="w-4 h-4 rounded-full" style={{ backgroundColor: settings.highlightColor }} />
               </div>
               <div className="flex gap-2 flex-wrap">
                  {presetColors.map(c => (
                     <button key={c} onClick={() => onUpdate({ highlightColor: c })} className={`w-8 h-8 rounded-full border-2 transition-all ${settings.highlightColor === c ? 'border-black scale-110 shadow-lg' : 'border-transparent opacity-60 hover:opacity-100'}`} style={{ backgroundColor: c }} />
                  ))}
                  <input type="color" value={settings.highlightColor} onChange={e => onUpdate({ highlightColor: e.target.value })} className="w-8 h-8 rounded-full overflow-hidden opacity-0 absolute" id="colorpicker" />
                  <label htmlFor="colorpicker" className={`w-8 h-8 rounded-full border-2 flex items-center justify-center cursor-pointer ${isDark ? 'bg-white/10' : 'bg-black/5'}`}><span className="text-[8px] font-black opacity-50">Custom</span></label>
               </div>
            </div>

             <label className="flex items-center justify-between cursor-pointer group pt-2">
               <div className="flex items-center gap-3">
                  <div className={`text-sm font-black ${textClass}`}>Auto-Scroll</div>
                  <div className="text-[10px] opacity-60 font-bold">Follow text while playing</div>
               </div>
               <div className={`w-10 h-5 rounded-full p-1 transition-all ${settings.followHighlight ? 'bg-indigo-600' : 'bg-slate-200'}`}>
                  <input type="checkbox" className="hidden" checked={settings.followHighlight} onChange={e => onUpdate({ followHighlight: e.target.checked })} />
                  <div className={`w-3 h-3 rounded-full bg-white shadow-sm transition-all ${settings.followHighlight ? 'translate-x-5' : ''}`} />
               </div>
             </label>
          </div>
        </div>

        {/* 3. Cloud & Identity */}
        <div className={`p-5 sm:p-8 rounded-[1.5rem] border shadow-sm space-y-6 ${cardBg}`}>
          <label className={labelClass}>Cloud & Identity</label>
          <div className="space-y-6">
             <div className="space-y-2">
               <span className="text-[10px] font-black uppercase opacity-60">Google OAuth Client ID</span>
               <input type="text" value={googleClientId || ''} onChange={e => onUpdateGoogleClientId?.(e.target.value.trim())} placeholder="Google OAuth Client ID" className={`w-full px-4 py-3 rounded-xl border-none outline-none font-mono text-[14px] ${isDark ? 'bg-slate-950 text-white' : 'bg-slate-50 text-black'}`} />
             </div>

             <div className="p-5 rounded-2xl bg-indigo-600/5 border border-indigo-600/10 space-y-4">
                <div className="flex items-center justify-between">
                   <div className="flex items-center gap-4">
                      <div className={`p-3 rounded-xl ${isAuthorized ? 'bg-indigo-600 text-white shadow-lg' : 'bg-slate-200 text-slate-400'}`}>
                         {isAuthorized ? <Cloud className="w-5 h-5" /> : <CloudOff className="w-5 h-5" />}
                      </div>
                      <div>
                         <div className={`text-sm font-black ${textClass}`}>{isAuthorized ? 'Connected to Drive' : 'Disconnected'}</div>
                         <div className="text-[9px] opacity-60 font-black uppercase tracking-tighter">
                           {isAuthorized ? `Session expires in ${expiryMinutes}m` : 'Sign in to access cloud features'}
                         </div>
                      </div>
                   </div>
                   {isAuthorized && onClearAuth && (
                      <button onClick={onClearAuth} className="p-2 text-red-500 hover:bg-red-500/10 rounded-lg transition-all" title="Sign Out">
                         <LogOut className="w-5 h-5" />
                      </button>
                   )}
                </div>
                
                {!isAuthorized ? (
                  <button onClick={() => getValidDriveToken({ interactive: true })} className="w-full py-3 bg-indigo-600 text-white rounded-xl font-black uppercase tracking-widest text-xs flex items-center justify-center gap-2 hover:bg-indigo-700 transition-all shadow-lg">
                     <LogIn className="w-4 h-4" /> Sign In with Google
                  </button>
                ) : (
                  <div className="space-y-3 pt-2">
                     <div className="flex items-center justify-between p-3 bg-white/50 rounded-xl border border-indigo-600/10">
                        <div className="flex items-center gap-2 overflow-hidden">
                           <FolderSync className="w-4 h-4 text-indigo-600 flex-shrink-0" />
                           <span className="text-xs font-bold truncate">{driveRootName || 'No Folder Linked'}</span>
                        </div>
                        <button onClick={onSelectRoot} className="text-[9px] font-black uppercase bg-indigo-600 text-white px-3 py-1.5 rounded-lg hover:bg-indigo-700 whitespace-nowrap">
                           {driveRootName ? 'Change' : 'Link Folder'}
                        </button>
                     </div>
                     
                     {driveRootName && (
                        <div className="grid grid-cols-2 gap-3">
                           <button onClick={onSyncNow} disabled={isSyncing} className="py-3 bg-indigo-600 text-white rounded-xl font-black uppercase tracking-widest text-[10px] flex items-center justify-center gap-2 hover:bg-indigo-700 disabled:opacity-50">
                              {isSyncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Sync Now
                           </button>
                           <button onClick={onSaveState} className="py-3 bg-emerald-600 text-white rounded-xl font-black uppercase tracking-widest text-[10px] flex items-center justify-center gap-2 hover:bg-emerald-700">
                              <Save className="w-3.5 h-3.5" /> Manual Save
                           </button>
                        </div>
                     )}
                     
                     {isDirty && <div className="text-[10px] text-amber-600 font-bold flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> Unsaved changes pending upload</div>}
                     {lastSavedAt && <div className="text-[9px] opacity-40 text-center font-mono pt-1">Last Saved: {new Date(lastSavedAt).toLocaleTimeString()}</div>}
                  </div>
                )}
             </div>
          </div>
        </div>

        {/* 4. Storage & Advanced */}
        <div className={`p-5 sm:p-8 rounded-[1.5rem] border shadow-sm space-y-6 ${cardBg}`}>
           <label className={labelClass}>Storage & System</label>
           <div className="space-y-6">
              <div className="flex items-center justify-between">
                 <div className="space-y-1">
                    <div className={`text-sm font-black ${textClass}`}>Auto-Save Interval</div>
                    <div className="text-[10px] opacity-60 font-bold">Frequency of cloud backups</div>
                 </div>
                 <select value={autoSaveInterval} onChange={e => onSetAutoSaveInterval(parseInt(e.target.value))} className={`px-3 py-2 rounded-xl text-xs font-black border-none outline-none ${isDark ? 'bg-slate-950 text-white' : 'bg-slate-100 text-black'}`}>
                    <option value={5}>5 Minutes</option>
                    <option value={15}>15 Minutes</option>
                    <option value={30}>30 Minutes</option>
                    <option value={60}>1 Hour</option>
                 </select>
              </div>

              {onRunMigration && isAuthorized && (
                 <div className="p-4 rounded-xl border border-amber-500/20 bg-amber-500/5 space-y-3">
                    <div className="flex items-center gap-2 text-amber-600 font-black text-xs uppercase tracking-widest">
                       <Wrench className="w-4 h-4" /> Migration Tool
                    </div>
                    <p className="text-[10px] opacity-70 leading-relaxed">Use this if you are upgrading from v1 structure to organize books into subfolders.</p>
                    <button onClick={onRunMigration} disabled={isSyncing} className="w-full py-2 bg-amber-600 text-white rounded-lg font-black uppercase text-[10px] hover:bg-amber-700 disabled:opacity-50">
                       Run Folder Migration
                    </button>
                 </div>
              )}
           </div>
        </div>

        {/* 5. Diagnostics */}
        <div className={`p-5 sm:p-8 rounded-[1.5rem] border shadow-sm space-y-4 ${cardBg}`}>
           <div className="flex items-center justify-between cursor-pointer" onClick={() => setIsDiagExpanded(!isDiagExpanded)}>
              <label className={labelClass.replace('mb-4', 'mb-0')}>Diagnostics & Logs</label>
              {isDiagExpanded ? <ChevronUp className="w-4 h-4 opacity-40" /> : <ChevronDown className="w-4 h-4 opacity-40" />}
           </div>
           
           {isDiagExpanded && (
              <div className="space-y-6 animate-in slide-in-from-top-2">
                 <label className="flex items-center justify-between cursor-pointer group">
                   <div className="flex items-center gap-3">
                      <div className={`p-2 rounded-xl ${showDiagnostics ? 'bg-indigo-600 text-white' : 'bg-black/5 opacity-50'}`}><Terminal className="w-4 h-4" /></div>
                      <div>
                         <div className={`text-sm font-black ${textClass}`}>Show Overlay</div>
                         <div className="text-[10px] opacity-60 font-bold">Display tech specs during playback</div>
                      </div>
                   </div>
                   <div className={`w-10 h-5 rounded-full p-1 transition-all ${showDiagnostics ? 'bg-indigo-600' : 'bg-slate-200'}`}>
                      <input type="checkbox" className="hidden" checked={showDiagnostics} onChange={e => onSetShowDiagnostics(e.target.checked)} />
                      <div className={`w-3 h-3 rounded-full bg-white shadow-sm transition-all ${showDiagnostics ? 'translate-x-5' : ''}`} />
                   </div>
                 </label>

                 <div className="p-4 rounded-2xl bg-black/5 font-mono text-[10px] space-y-2 overflow-x-auto">
                    <div className="flex items-center justify-between opacity-50 uppercase font-black mb-2">
                       <span>Sync Status</span>
                       <Timer className="w-3 h-3" />
                    </div>
                    <div>Last Success: {syncDiagnostics?.lastSyncSuccessAt ? new Date(syncDiagnostics.lastSyncSuccessAt).toLocaleString() : 'Never'}</div>
                    <div>Last Attempt: {syncDiagnostics?.lastSyncAttemptAt ? new Date(syncDiagnostics.lastSyncAttemptAt).toLocaleString() : 'Never'}</div>
                    <div className={`${syncDiagnostics?.isDirty ? 'text-amber-600 font-bold' : 'text-emerald-600 font-bold'}`}>State: {syncDiagnostics?.isDirty ? 'Dirty (Needs Save)' : 'Clean'}</div>
                    {syncDiagnostics?.lastSyncError && (
                       <div className="text-red-500 font-bold mt-2 pt-2 border-t border-black/5 flex items-start gap-2">
                          <FileWarning className="w-3 h-3 mt-0.5 flex-shrink-0" />
                          <span>Error: {syncDiagnostics.lastSyncError}</span>
                       </div>
                    )}
                 </div>
                 
                 <div className="flex gap-3">
                    <button onClick={handleCopyDiagnostics} className="flex-1 py-3 bg-slate-800 text-white rounded-xl font-black uppercase text-[10px] flex items-center justify-center gap-2 hover:bg-slate-700">
                       <ClipboardCopy className="w-3.5 h-3.5" /> Copy Log
                    </button>
                    <button onClick={() => window.location.reload()} className="flex-1 py-3 bg-red-500/10 text-red-500 rounded-xl font-black uppercase text-[10px] flex items-center justify-center gap-2 hover:bg-red-500/20">
                       <Bug className="w-3.5 h-3.5" /> Force Reload
                    </button>
                 </div>
              </div>
           )}
        </div>

      </div>
    </div>
  );
};

export default Settings;