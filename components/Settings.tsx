
import React, { useState, useEffect, useMemo } from 'react';
import { ReaderSettings, Theme, SyncDiagnostics } from '../types';
import { Type, RefreshCw, Smartphone, Cloud, CloudOff, Loader2, Key, LogOut, Save, LogIn, Palette, Eye, ShieldCheck, Clock, Sun, Coffee, Moon, Check, FolderSync, Wrench, AlertTriangle, ChevronDown, ChevronUp, Terminal, Timer, ClipboardCopy, FileWarning } from 'lucide-react';
import { getAuthSessionInfo, isTokenValid } from '../services/driveAuth';

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
}

const Settings: React.FC<SettingsProps> = ({ 
  settings, onUpdate, theme, onSetTheme, keepAwake, onSetKeepAwake, onCheckForUpdates,
  onLinkCloud, onSyncNow, isSyncing,
  googleClientId, onUpdateGoogleClientId, onClearAuth,
  onSaveState, lastSavedAt,
  driveRootName, onSelectRoot, onRunMigration,
  syncDiagnostics, autoSaveInterval, onSetAutoSaveInterval, isDirty
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
        </div>

        {/* 2. Cloud & Identity */}
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
                   {!isAuthorized && (
                      <button onClick={onLinkCloud} disabled={!googleClientId} className="px-5 py-2.5 bg-indigo-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest shadow-md hover:bg-indigo-700 transition-all">
                         Reconnect
                      </button>
                   )}
                </div>

                {isAuthorized && (
                  <div className="space-y-4 pt-4 border-t border-indigo-600/10">
                    <div className="flex flex-col gap-3">
                       <span className="text-[10px] font-black uppercase text-indigo-600">Active Storage Root</span>
                       <div className="flex items-center justify-between gap-3 p-3 bg-white/40 dark:bg-black/20 rounded-xl">
                          <div className="flex items-center gap-2 truncate">
                             <FolderSync className="w-4 h-4 text-indigo-500 flex-shrink-0" />
                             <span className="text-xs font-bold truncate">{driveRootName || 'Not Selected'}</span>
                          </div>
                          <button onClick={onSelectRoot} className="text-[9px] font-black uppercase bg-indigo-600 text-white px-3 py-1.5 rounded-lg shadow-sm">Change</button>
                       </div>
                    </div>

                    <div className="space-y-3 pt-2">
                       <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                             <Timer className="w-4 h-4 text-indigo-600" />
                             <span className={`text-xs font-black ${textClass}`}>Auto Cloud Save</span>
                          </div>
                          <select 
                             value={autoSaveInterval} 
                             onChange={e => onSetAutoSaveInterval(parseInt(e.target.value))}
                             className={`text-xs font-black p-2 rounded-xl border-none outline-none ${isDark ? 'bg-slate-950 text-white' : 'bg-white text-black'}`}
                          >
                             <option value={15}>15 Minutes</option>
                             <option value={30}>30 Minutes</option>
                             <option value={45}>45 Minutes</option>
                             <option value={60}>60 Minutes</option>
                          </select>
                       </div>
                       <p className="text-[9px] font-bold opacity-40 uppercase tracking-tighter">Saves only when changes are detected</p>
                    </div>
                    
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                       <button onClick={onRunMigration} className="flex items-center justify-center gap-2 px-4 py-3 rounded-xl border border-indigo-600/20 text-indigo-600 text-[10px] font-black uppercase hover:bg-indigo-600/5 transition-all">
                          <Wrench className="w-3.5 h-3.5" /> File Checkup / Migration
                       </button>
                       <button onClick={onSyncNow} disabled={isSyncing} className="flex items-center justify-center gap-2 px-4 py-3 bg-indigo-600 text-white rounded-xl text-[10px] font-black uppercase hover:bg-indigo-700 transition-all shadow-md">
                          {isSyncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Force Cloud Sync
                       </button>
                    </div>
                  </div>
                )}
             </div>

             {isAuthorized && (
               <div className="flex items-center justify-between gap-4 pt-2">
                 <button onClick={onSaveState} className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl border border-emerald-500/30 text-emerald-500 text-[10px] font-black uppercase hover:bg-emerald-500/5 transition-all">
                    <Save className="w-3.5 h-3.5" /> Manual State Backup
                 </button>
                 <button onClick={onClearAuth} title="Disconnect Account" className="p-3 rounded-xl border border-red-500/20 text-red-500 hover:bg-red-500/10 transition-all"><LogOut className="w-4 h-4" /></button>
               </div>
             )}
          </div>
        </div>

        {/* Sync Diagnostics */}
        {isAuthorized && (
          <div className={`p-5 rounded-[1.5rem] border shadow-sm ${cardBg}`}>
            <button 
              onClick={() => setIsDiagExpanded(!isDiagExpanded)}
              className="w-full flex items-center justify-between font-black text-[11px] uppercase tracking-[0.2em] text-indigo-500"
            >
              <div className="flex items-center gap-2">
                <Terminal className="w-4 h-4" /> Sync Diagnostics
              </div>
              <div className="flex items-center gap-3">
                 {syncDiagnostics?.cloudDirty && <span className="bg-amber-500 text-white text-[8px] px-1.5 py-0.5 rounded-full animate-pulse">Unsaved Changes</span>}
                 {isDiagExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </div>
            </button>
            {isDiagExpanded && (
              <div className="mt-6 space-y-4 animate-in slide-in-from-top-2 duration-200">
                <div className="grid grid-cols-1 gap-2 text-[10px] font-mono p-4 bg-black/5 dark:bg-black/40 rounded-xl border border-black/5 overflow-x-auto whitespace-pre">
                   <div>Dirty: {syncDiagnostics?.cloudDirty ? 'YES' : 'NO'}</div>
                   <div>Dirty Since: {syncDiagnostics?.dirtySince ? new Date(syncDiagnostics.dirtySince).toLocaleTimeString() : 'N/A'}</div>
                   <div>Interval: {autoSaveInterval}m</div>
                   <div>Last Save: {syncDiagnostics?.lastCloudSaveAt ? new Date(syncDiagnostics.lastCloudSaveAt).toLocaleString() : 'Never'}</div>
                   <div>Trigger: {syncDiagnostics?.lastCloudSaveTrigger?.toUpperCase() || 'NONE'}</div>
                   <div className="opacity-50 mt-2 border-t border-black/5 pt-2">Details:</div>
                   <div>Sync Attempt: {syncDiagnostics?.lastSyncAttemptAt ? new Date(syncDiagnostics.lastSyncAttemptAt).toLocaleString() : 'Never'}</div>
                   <div>Sync Success: {syncDiagnostics?.lastSyncSuccessAt ? new Date(syncDiagnostics.lastSyncSuccessAt).toLocaleString() : 'Never'}</div>
                   {syncDiagnostics?.lastSyncError && <div className="text-red-500">Sync Error: {syncDiagnostics.lastSyncError}</div>}
                   <div className="opacity-50 mt-2 border-t border-black/5 pt-2">Auto-Save:</div>
                   <div>Auto Attempt: {syncDiagnostics?.lastAutoSaveAttemptAt ? new Date(syncDiagnostics.lastAutoSaveAttemptAt).toLocaleString() : 'Never'}</div>
                   <div>Auto Success: {syncDiagnostics?.lastAutoSaveSuccessAt ? new Date(syncDiagnostics.lastAutoSaveSuccessAt).toLocaleString() : 'Never'}</div>
                   {syncDiagnostics?.lastAutoSaveError && <div className="text-red-500">Auto Error: {syncDiagnostics.lastAutoSaveError}</div>}
                   
                   {lastFatalError && (
                     <>
                       <div className="opacity-50 mt-2 border-t border-black/5 pt-2 text-red-500 flex items-center gap-1">
                         <FileWarning className="w-3 h-3" /> Last Fatal Crash:
                       </div>
                       <div className="text-red-500 truncate">{lastFatalError.message}</div>
                       <div className="text-slate-500">{new Date(lastFatalError.timestamp).toLocaleString()}</div>
                     </>
                   )}

                   <div className="opacity-50 mt-2 border-t border-black/5 pt-2">IDs:</div>
                   <div>Root: {syncDiagnostics?.driveRootFolderId || 'N/A'}</div>
                   <div>Saves: {syncDiagnostics?.resolvedCloudSavesFolderId || 'N/A'}</div>
                </div>
                <button 
                  onClick={handleCopyDiagnostics}
                  className="w-full py-2 bg-indigo-600/10 text-indigo-600 rounded-lg text-[9px] font-black uppercase hover:bg-indigo-600/20 flex items-center justify-center gap-2"
                >
                  <ClipboardCopy className="w-3.5 h-3.5" /> Copy Full Logs for Support
                </button>
              </div>
            )}
          </div>
        )}

        {/* 3. Session Integrity */}
        <div className={`p-5 sm:p-8 rounded-[1.5rem] border shadow-sm space-y-4 ${cardBg}`}>
           <label className={labelClass}>Cloud Health</label>
           <div className="space-y-3">
              <div className="flex items-center justify-between text-xs">
                 <span className="opacity-60 font-bold flex items-center gap-2"><ShieldCheck className="w-3.5 h-3.5" /> Security Token</span>
                 <span className={`font-black uppercase tracking-widest ${isAuthorized ? 'text-emerald-500' : 'text-red-500'}`}>
                    {isAuthorized ? 'Authenticated' : 'Expired / Off'}
                 </span>
              </div>
              <div className="flex items-center justify-between text-xs">
                 <span className="opacity-60 font-bold flex items-center gap-2"><Clock className="w-3.5 h-3.5" /> Session Ends</span>
                 <span className={`font-mono font-bold ${textClass}`}>
                    {session.expiresAt > 0 ? new Date(session.expiresAt).toLocaleTimeString() : 'N/A'}
                 </span>
              </div>
              {lastSavedAt && (
                <div className="flex items-center justify-between text-xs pt-2 border-t border-black/5">
                   <span className="opacity-60 font-bold">Last Successful State Save</span>
                   <span className={`font-bold ${textClass}`}>{new Date(lastSavedAt).toLocaleString()}</span>
                </div>
              )}
           </div>
        </div>

        {/* 4. Reader Experience */}
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
              <button onClick={() => onSetKeepAwake(!keepAwake)} className={`w-14 h-7 rounded-full transition-colors relative ${keepAwake ? 'bg-indigo-600' : 'bg-slate-300'}`}>
                <div className={`absolute top-1 w-5 h-5 bg-white rounded-full transition-all ${keepAwake ? 'left-8' : 'left-1'}`} />
              </button>
            </div>
          </div>
        </div>

        {/* 5. Visual Customization */}
        <div className={`p-5 sm:p-8 rounded-[1.5rem] border shadow-sm space-y-6 ${cardBg}`}>
          <label className={labelClass}>Visual Customization</label>
          <div className="space-y-6">
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <span className={`text-sm font-black ${textClass}`}>Font Size</span>
                <span className="text-xs font-mono font-black opacity-60">{settings.fontSizePx}px</span>
              </div>
              <input 
                type="range" 
                min="16" 
                max="40" 
                value={settings.fontSizePx} 
                onChange={e => onUpdate({ fontSizePx: parseInt(e.target.value) })} 
                className="w-full h-1.5 accent-indigo-600 rounded-full cursor-pointer" 
              />
            </div>
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <div className="flex items-center gap-2">
                  <Palette className={`w-5 h-5 ${isDark ? 'text-indigo-400' : 'text-indigo-600'}`} />
                  <span className={`text-sm font-black ${textClass}`}>Highlight Color</span>
                </div>
                <input 
                  type="color" 
                  value={settings.highlightColor} 
                  onChange={e => onUpdate({ highlightColor: e.target.value })} 
                  className="w-8 h-8 rounded-lg border-none bg-transparent cursor-pointer" 
                />
              </div>
              <div className="flex flex-wrap gap-3">
                {presetColors.map(color => (
                  <button 
                    key={color} 
                    onClick={() => onUpdate({ highlightColor: color })} 
                    className={`w-8 h-8 rounded-full border-2 transition-all ${settings.highlightColor === color ? 'border-white ring-2 ring-indigo-600' : 'border-transparent opacity-60'}`} 
                    style={{ backgroundColor: color }} 
                  />
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
