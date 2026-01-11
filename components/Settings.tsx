
import React, { useState, useEffect, useMemo } from 'react';
import { ReaderSettings, Theme, SyncDiagnostics, UiMode } from '../types';
import { RefreshCw, Cloud, CloudOff, Loader2, LogOut, Save, LogIn, Check, Sun, Coffee, Moon, FolderSync, Wrench, AlertTriangle, ChevronDown, ChevronUp, Terminal, Timer, ClipboardCopy, FileWarning, Bug, Smartphone, Type, Palette, Monitor, LayoutTemplate, Library } from 'lucide-react';
import { getAuthSessionInfo, isTokenValid, getValidDriveToken } from '../services/driveAuth';
import { authManager } from '../services/authManager';
import { getTraceDump } from '../utils/trace';

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
  onRecalculateProgress?: () => void;
}

const Settings: React.FC<SettingsProps> = ({ 
  settings, onUpdate, theme, onSetTheme, keepAwake, onSetKeepAwake, onCheckForUpdates,
  onLinkCloud, onSyncNow, isSyncing,
  googleClientId, onUpdateGoogleClientId, onClearAuth,
  onSaveState, lastSavedAt,
  driveRootName, onSelectRoot, onRunMigration,
  syncDiagnostics, autoSaveInterval, onSetAutoSaveInterval, isDirty,
  showDiagnostics, onSetShowDiagnostics,
  onRecalculateProgress
}) => {
  const [authState, setAuthState] = useState(authManager.getState());
  const [isDiagExpanded, setIsDiagExpanded] = useState(false);
  
  const lastFatalError = useMemo(() => {
    try {
      const raw = localStorage.getItem("talevox_last_fatal_error");
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }, []);

  useEffect(() => {
    const unsubscribe = authManager.subscribe(setAuthState);
    return () => { unsubscribe(); };
  }, []);

  const isDark = theme === Theme.DARK;
  const isSepia = theme === Theme.SEPIA;
  const cardBg = isDark ? 'bg-slate-900 border-slate-800' : isSepia ? 'bg-[#f4ecd8] border-[#d8ccb6]' : 'bg-white border-black/10';
  const textClass = isDark ? 'text-slate-100' : isSepia ? 'text-[#3c2f25]' : 'text-black';
  const labelClass = `text-[11px] font-black uppercase tracking-[0.2em] mb-4 block ${isDark ? 'text-indigo-400' : 'text-indigo-600'}`;
  
  const isAuthorized = authState.status === 'signed_in';
  const expiryMinutes = authState.expiresAt > 0 ? Math.max(0, Math.round((authState.expiresAt - Date.now()) / 60000)) : 0;

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
      auth: { status: authState.status, hasToken: !!authState.accessToken },
      version: window.__APP_VERSION__,
      userAgent: navigator.userAgent
    };
    navigator.clipboard.writeText(JSON.stringify(data, null, 2));
    alert("System diagnostics copied to clipboard");
  };

  const handleCopyTrace = () => {
    navigator.clipboard.writeText(getTraceDump());
    alert("Full playback trace copied to clipboard");
  };

  const handleSetUiMode = (mode: UiMode) => {
    onUpdate({ uiMode: mode });
  };

  const handleForceReauth = () => {
    authManager.validateToken();
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
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-[10px] font-black uppercase transition-all shadow-sm ${isDark ? 'bg-slate-800 text-slate-100 hover:bg-slate-700' : isSepia ? 'bg-[#e6d8b5] text-[#3c2f25] hover:bg-[#d9cab0]' : 'bg-white text-black hover:bg-slate-50'}`}
          >
            <RefreshCw className="w-3.5 h-3.5" /> Check Updates
          </button>
        </div>

        {/* --- APPEARANCE --- */}
        <div className={`p-6 sm:p-8 rounded-[2rem] border shadow-sm ${cardBg}`}>
          <label className={labelClass}><Palette className="w-3.5 h-3.5 inline mr-2" /> Appearance</label>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {themes.map(t => (
              <button 
                key={t.id} 
                onClick={() => onSetTheme(t.id)}
                className={`flex flex-col items-center gap-3 p-4 rounded-2xl border-2 transition-all ${theme === t.id ? 'border-indigo-600 ring-1 ring-indigo-600/20' : 'border-transparent hover:border-black/5'} ${t.color}`}
              >
                <t.icon className={`w-6 h-6 ${theme === t.id ? 'text-indigo-600' : 'opacity-40'}`} />
                <div className="text-center">
                  <div className={`text-xs font-black ${textClass}`}>{t.name}</div>
                  <div className="text-[10px] font-bold opacity-40">{t.desc}</div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* --- UI MODE --- */}
        <div className={`p-6 sm:p-8 rounded-[2rem] border shadow-sm ${cardBg}`}>
          <label className={labelClass}><LayoutTemplate className="w-3.5 h-3.5 inline mr-2" /> Interface Mode</label>
          <div className={`flex p-1 rounded-xl gap-1 ${isDark ? 'bg-black/20' : 'bg-black/5'}`}>
            {[
              { id: 'auto' as const, label: 'Auto', icon: Smartphone },
              { id: 'desktop' as const, label: 'Desktop', icon: Monitor },
              { id: 'mobile' as const, label: 'Mobile', icon: Smartphone }
            ].map(m => {
              const isActive = settings.uiMode === m.id;
              return (
                <button
                  key={m.id}
                  onClick={() => handleSetUiMode(m.id)}
                  className={`flex-1 py-2.5 rounded-lg text-xs font-black transition-all flex items-center justify-center gap-2 ${isActive ? 'bg-indigo-600 text-white shadow-md' : 'opacity-60 hover:opacity-100'}`}
                >
                  <m.icon className="w-3.5 h-3.5" />
                  {m.label}
                </button>
              );
            })}
          </div>
          <p className="text-[10px] opacity-50 mt-3 px-1">
            <b>Auto:</b> Detects device capabilities. <b>Mobile:</b> Enables touch gestures and battery-saving sync. <b>Desktop:</b> Enables precision sync and mouse interactions.
          </p>
        </div>

        {/* --- TYPOGRAPHY --- */}
        <div className={`p-6 sm:p-8 rounded-[2rem] border shadow-sm ${cardBg}`}>
          <label className={labelClass}><Type className="w-3.5 h-3.5 inline mr-2" /> Typography & Reading</label>
          <div className="space-y-6">
             <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
               <div className="space-y-2">
                 <span className="text-[10px] font-black uppercase opacity-50">Font Family</span>
                 <select 
                   value={settings.fontFamily} 
                   onChange={e => onUpdate({ fontFamily: e.target.value })} 
                   className={`w-full p-3 rounded-xl text-xs font-bold outline-none border ${isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'}`}
                 >
                   <option value="'Source Serif 4', serif">Source Serif 4 (Book)</option>
                   <option value="'Inter', sans-serif">Inter (Modern)</option>
                   <option value="'Lora', serif">Lora (Elegant)</option>
                   <option value="'Merriweather', serif">Merriweather (Readability)</option>
                   <option value="'Open Dyslexic', sans-serif">Open Dyslexic</option>
                 </select>
               </div>
               <div className="space-y-2">
                 <span className="text-[10px] font-black uppercase opacity-50">Base Size ({settings.fontSizePx}px)</span>
                 <input 
                   type="range" min="14" max="32" step="1" 
                   value={settings.fontSizePx} 
                   onChange={e => onUpdate({ fontSizePx: parseInt(e.target.value) })}
                   className="w-full h-2 rounded-lg appearance-none bg-black/5 accent-indigo-600"
                 />
               </div>
             </div>

             <div className="space-y-3">
               <span className="text-[10px] font-black uppercase opacity-50">Highlight Color</span>
               <div className="flex flex-wrap gap-2">
                 {presetColors.map(c => (
                   <button 
                     key={c} 
                     onClick={() => onUpdate({ highlightColor: c })}
                     className={`w-8 h-8 rounded-full border-2 transition-transform hover:scale-110 ${settings.highlightColor === c ? 'border-white ring-2 ring-black/20' : 'border-transparent'}`}
                     style={{ backgroundColor: c }}
                   />
                 ))}
                 <input 
                   type="color" 
                   value={settings.highlightColor}
                   onChange={e => onUpdate({ highlightColor: e.target.value })}
                   className="w-8 h-8 rounded-full overflow-hidden border-0 p-0 cursor-pointer"
                 />
               </div>
             </div>
             
             <label className="flex items-center gap-3 p-3 rounded-xl border border-dashed hover:bg-black/5 cursor-pointer">
               <input type="checkbox" checked={settings.followHighlight} onChange={e => onUpdate({ followHighlight: e.target.checked })} className="w-4 h-4 accent-indigo-600" />
               <div className="flex-1">
                 <div className="text-xs font-black">Auto-Scroll</div>
                 <div className="text-[10px] opacity-60">Keep highlighted text in view</div>
               </div>
             </label>
          </div>
        </div>

        {/* --- CLOUD SYNC --- */}
        <div className={`p-6 sm:p-8 rounded-[2rem] border shadow-sm ${cardBg}`}>
           <div className="flex justify-between items-center mb-4">
             <label className={`${labelClass} mb-0`}><Cloud className="w-3.5 h-3.5 inline mr-2" /> Google Drive Sync</label>
             {isAuthorized && <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 text-[9px] font-black uppercase">Active</span>}
           </div>

           {!isAuthorized ? (
             <div className="text-center py-8">
               <p className="text-sm font-bold opacity-60 mb-6">Connect Google Drive to sync books and progress across devices.</p>
               <button onClick={() => authManager.signIn()} className="px-6 py-3 bg-indigo-600 text-white rounded-xl font-black uppercase text-xs tracking-widest shadow-xl hover:bg-indigo-700 transition-all flex items-center justify-center gap-2 mx-auto">
                 <LogIn className="w-4 h-4" /> Connect Drive
               </button>
               {authState.status === 'signing_in' && <div className="mt-4 text-xs font-bold text-indigo-500 animate-pulse">Check popup window...</div>}
               {authState.lastError && <div className="mt-4 text-xs font-bold text-red-500">{authState.lastError}</div>}
             </div>
           ) : (
             <div className="space-y-6">
                <div className={`p-4 rounded-xl border flex flex-col gap-2 ${isDark ? 'bg-slate-950/50 border-slate-800' : 'bg-slate-50 border-slate-200'}`}>
                   <div className="flex justify-between items-center">
                     <span className="text-[10px] font-black uppercase opacity-50">Sync Status</span>
                     <span className="text-[10px] font-mono opacity-50">Token expires in {expiryMinutes}m</span>
                   </div>
                   <div className="flex items-center gap-2">
                      <div className={`w-2 h-2 rounded-full ${isSyncing ? 'bg-indigo-500 animate-pulse' : isDirty ? 'bg-amber-500' : 'bg-emerald-500'}`} />
                      <span className="text-xs font-bold">{isSyncing ? 'Syncing...' : isDirty ? 'Changes Pending' : 'Up to Date'}</span>
                   </div>
                   {authState.userEmail && <div className="text-[10px] font-bold text-indigo-500">{authState.userEmail}</div>}
                   {lastSavedAt && <div className="text-[10px] opacity-40">Last saved: {new Date(lastSavedAt).toLocaleString()}</div>}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                   <button onClick={onSyncNow} disabled={isSyncing} className="flex items-center justify-center gap-2 px-4 py-3 bg-indigo-600 text-white rounded-xl text-xs font-black uppercase tracking-widest hover:bg-indigo-700 disabled:opacity-50">
                     {isSyncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Sync Now
                   </button>
                   <button onClick={onSaveState} disabled={isSyncing} className="flex items-center justify-center gap-2 px-4 py-3 bg-indigo-600/10 text-indigo-600 rounded-xl text-xs font-black uppercase tracking-widest hover:bg-indigo-600/20 disabled:opacity-50">
                     <Save className="w-4 h-4" /> Force Cloud Save
                   </button>
                </div>

                <div className="space-y-2 pt-2 border-t border-black/5">
                   <div className="flex items-center justify-between">
                      <span className="text-[10px] font-black uppercase opacity-60">Root Folder</span>
                      <button onClick={onSelectRoot} className="text-[10px] font-black uppercase text-indigo-600 hover:underline">Change</button>
                   </div>
                   <div className="text-xs font-mono truncate opacity-80 flex items-center gap-2">
                      <FolderSync className="w-3 h-3" />
                      {driveRootName || 'Not selected'}
                   </div>
                </div>
                
                <div className="space-y-2">
                   <span className="text-[10px] font-black uppercase opacity-60">Auto-Save Interval</span>
                   <div className="flex gap-2">
                      {[5, 15, 30].map(m => (
                        <button 
                          key={m} 
                          onClick={() => onSetAutoSaveInterval(m)}
                          className={`flex-1 py-2 rounded-lg text-[10px] font-black border transition-all ${autoSaveInterval === m ? 'bg-indigo-600 text-white border-indigo-600' : 'hover:bg-black/5 border-transparent'}`}
                        >
                          {m}m
                        </button>
                      ))}
                   </div>
                </div>

                {onRunMigration && (
                  <button onClick={onRunMigration} className="w-full py-3 rounded-xl border-2 border-dashed border-amber-500/30 text-amber-600 hover:bg-amber-50 text-[10px] font-black uppercase tracking-widest flex items-center justify-center gap-2">
                    <Wrench className="w-3.5 h-3.5" /> Migrate Old Folder Structure
                  </button>
                )}

                <div className="flex flex-col gap-2 pt-4">
                   <button onClick={handleForceReauth} className="w-full text-center text-[10px] font-black uppercase tracking-widest opacity-40 hover:opacity-100 hover:text-indigo-600">Re-check Connection</button>
                   <button onClick={onClearAuth} className="w-full text-center text-red-500 text-[10px] font-black uppercase tracking-widest opacity-60 hover:opacity-100">Sign Out / Unlink</button>
                </div>
             </div>
           )}
        </div>

        {/* --- LIBRARY TOOLS --- */}
        <div className={`p-6 sm:p-8 rounded-[2rem] border shadow-sm ${cardBg}`}>
           <label className={labelClass}><Library className="w-3.5 h-3.5 inline mr-2" /> Library Tools</label>
           
           <div className="space-y-4">
              {onRecalculateProgress && (
                <button onClick={onRecalculateProgress} className="w-full py-3 rounded-xl bg-indigo-600/10 text-indigo-600 hover:bg-indigo-600/20 text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2 transition-all">
                  <RefreshCw className="w-4 h-4" /> Reconcile Progress From Saves
                </button>
              )}
              <p className="text-[10px] opacity-50 px-1">
                Fix inconsistent progress bars or "Done" status without resetting your actual reading position.
              </p>
           </div>
        </div>

        {/* --- SYSTEM --- */}
        <div className={`p-6 sm:p-8 rounded-[2rem] border shadow-sm ${cardBg}`}>
           <label className={labelClass}><Terminal className="w-3.5 h-3.5 inline mr-2" /> System</label>
           
           <div className="space-y-4">
              <label className="flex items-center justify-between cursor-pointer">
                 <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-lg ${keepAwake ? 'bg-emerald-500 text-white' : 'bg-black/5'}`}><Smartphone className="w-4 h-4" /></div>
                    <div><div className="text-xs font-black">Keep Awake</div><div className="text-[10px] opacity-60">Prevent screen sleep</div></div>
                 </div>
                 <input type="checkbox" checked={keepAwake} onChange={e => onSetKeepAwake(e.target.checked)} className="w-5 h-5 accent-indigo-600" />
              </label>

              <label className="flex items-center justify-between cursor-pointer">
                 <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-lg ${showDiagnostics ? 'bg-indigo-500 text-white' : 'bg-black/5'}`}><Bug className="w-4 h-4" /></div>
                    <div><div className="text-xs font-black">Show Diagnostics</div><div className="text-[10px] opacity-60">Overlay debug info</div></div>
                 </div>
                 <input type="checkbox" checked={showDiagnostics} onChange={e => onSetShowDiagnostics(e.target.checked)} className="w-5 h-5 accent-indigo-600" />
              </label>

              <div className={`rounded-xl overflow-hidden border ${isDark ? 'bg-black/20 border-slate-800' : 'bg-black/5 border-black/5'}`}>
                 <button onClick={() => setIsDiagExpanded(!isDiagExpanded)} className="w-full px-4 py-3 flex items-center justify-between text-[10px] font-black uppercase tracking-widest opacity-60 hover:opacity-100">
                    <span>Debug Data</span>
                    {isDiagExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                 </button>
                 {isDiagExpanded && (
                    <div className="p-4 pt-0 space-y-3">
                       {syncDiagnostics && (
                         <div className="space-y-1">
                            <div className="text-[9px] font-black uppercase opacity-40">Sync State</div>
                            <pre className="text-[9px] font-mono opacity-60 overflow-x-auto">{JSON.stringify(syncDiagnostics, null, 2)}</pre>
                            {syncDiagnostics.lastSyncError && <div className="text-[10px] text-red-500 font-bold flex gap-1"><AlertTriangle className="w-3 h-3" /> {syncDiagnostics.lastSyncError}</div>}
                         </div>
                       )}
                       {lastFatalError && (
                          <div className="p-2 bg-red-500/10 rounded-lg border border-red-500/20">
                             <div className="text-[9px] font-black uppercase text-red-500 mb-1">Last Crash</div>
                             <div className="text-[10px] font-mono opacity-80">{lastFatalError.message}</div>
                             <div className="text-[9px] opacity-50 mt-1">{new Date(lastFatalError.timestamp).toLocaleString()}</div>
                          </div>
                       )}
                       <div className="grid grid-cols-2 gap-2 pt-2">
                          <button onClick={handleCopyDiagnostics} className="p-2 bg-indigo-600/10 text-indigo-600 rounded-lg text-[10px] font-black uppercase flex items-center justify-center gap-2 hover:bg-indigo-600/20"><ClipboardCopy className="w-3 h-3" /> Copy Diag</button>
                          <button onClick={handleCopyTrace} className="p-2 bg-emerald-600/10 text-emerald-600 rounded-lg text-[10px] font-black uppercase flex items-center justify-center gap-2 hover:bg-emerald-600/20"><FileWarning className="w-3 h-3" /> Copy Trace</button>
                       </div>
                    </div>
                 )}
              </div>
           </div>
        </div>
      </div>
    </div>
  );
};

export default Settings;
