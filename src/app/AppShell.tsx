import React, { Suspense, lazy } from "react";
import { Theme } from "../../types";
import NotificationHost from "../../components/notifications/NotificationHost";
import {
  Loader2,
  Library as LibraryIcon,
  Zap,
  Settings as SettingsIcon,
  LogIn,
  RefreshCw,
  Save,
  List,
} from "lucide-react";

const LazyPlaybackDiagnosticsOverlay = lazy(
  () => import("../features/reader/PlaybackDiagnosticsOverlay")
);

export type DiagnosticsConfig = {
  playbackPhase: string;
  chapterSession: number;
  audioDuration: number;
  autoplayBlocked: boolean;
  isMobile: boolean;
};

export type AppShellProps = {
  theme: Theme;
  activeTab: "library" | "collection" | "reader" | "rules" | "settings";
  authStatus: "signed_in" | "signed_out" | "signing_in" | "expired" | string;
  isAuthorized: boolean;
  isSyncing: boolean;
  isSaving?: boolean;
  isDirty: boolean;
  isLoadingChapter: boolean;
  playbackPhase: string;
  showDiagnostics: boolean;
  diagnosticsConfig?: DiagnosticsConfig | null;
  linkModal?: React.ReactNode;
  onOpenSidebar: () => void;
  onLibraryNavClick: () => void;
  onSetTab: (tab: "library" | "collection" | "reader" | "rules" | "settings") => void;
  onReconnectDrive: () => void;
  onSync: () => void;
  onSaveState: () => void;
  children: React.ReactNode;
};

const AppShell: React.FC<AppShellProps> = React.memo(({
  theme,
  activeTab,
  authStatus,
  isAuthorized,
  isSyncing,
  isSaving = false,
  isDirty,
  isLoadingChapter,
  playbackPhase,
  showDiagnostics,
  diagnosticsConfig,
  linkModal,
  onOpenSidebar,
  onLibraryNavClick,
  onSetTab,
  onReconnectDrive,
  onSync,
  onSaveState,
  children,
}) => {
  return (
    <div className="flex flex-col h-screen overflow-hidden font-sans transition-colors duration-500 bg-theme text-theme">
      {linkModal}
      {showDiagnostics && diagnosticsConfig && (
        <Suspense fallback={null}>
          <LazyPlaybackDiagnosticsOverlay {...diagnosticsConfig} />
        </Suspense>
      )}
      <NotificationHost />

      <header
        className={`h-16 border-b flex items-center justify-between px-4 lg:px-8 z-10 sticky top-0 transition-colors ${theme === Theme.DARK ? "border-slate-800 bg-slate-900/80 backdrop-blur-md" : theme === Theme.SEPIA ? "border-[#d8ccb6] bg-[#efe6d5]/90 backdrop-blur-md" : "border-black/5 bg-white/90 backdrop-blur-md"}`}
      >
        <div className="flex items-center gap-4">
          {activeTab === "reader" && (
            <button
              onClick={onOpenSidebar}
              className="flex items-center gap-2 px-3 py-2 bg-black/5 rounded-xl text-[10px] font-black uppercase tracking-widest lg:hidden hover:bg-black/10"
            >
              <List className="w-4 h-4" /> <span className="hidden xs:inline">Chapters</span>
            </button>
          )}
          <nav className="flex items-center gap-4 sm:gap-6 overflow-x-auto no-scrollbar">
            <button
              onClick={onLibraryNavClick}
              className={`flex items-center gap-2 h-16 border-b-2 font-black uppercase text-[10px] tracking-widest flex-shrink-0 ${activeTab === "library" || activeTab === "collection" ? "border-indigo-600 text-indigo-600" : "border-transparent opacity-60"}`}
            >
              <LibraryIcon className="w-4 h-4" /> <span className="hidden sm:inline">Library</span>
            </button>
            <button
              onClick={() => onSetTab("rules")}
              className={`flex items-center gap-2 h-16 border-b-2 font-black uppercase text-[10px] tracking-widest flex-shrink-0 ${activeTab === "rules" ? "border-indigo-600 text-indigo-600" : "border-transparent opacity-60"}`}
            >
              <Zap className="w-4 h-4" /> <span className="hidden sm:inline">Rules</span>
            </button>
            <button
              onClick={() => onSetTab("settings")}
              className={`flex items-center gap-2 h-16 border-b-2 font-black uppercase text-[10px] tracking-widest flex-shrink-0 ${activeTab === "settings" ? "border-indigo-600 text-indigo-600" : "border-transparent opacity-60"}`}
            >
              <SettingsIcon className="w-4 h-4" />{" "}
              <span className="hidden sm:inline">Settings</span>
            </button>
          </nav>
        </div>
        <div className="flex items-center gap-2 sm:gap-4">
          {/* Second button: Sign in when not signed in, Sync when signed in. Save is always the rightmost. */}
          {authStatus === "signing_in" ? (
            <span
              className="flex items-center gap-2 px-3 py-2 bg-black/5 rounded-xl text-[10px] font-black uppercase tracking-widest"
              aria-busy="true"
            >
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Signing In...
            </span>
          ) : authStatus === "expired" || authStatus === "signed_out" || authStatus === "error" ? (
            <button
              type="button"
              onClick={onReconnectDrive}
              className="flex items-center gap-2 px-3 py-2 bg-amber-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-amber-700 transition-all shadow-md"
              title="Sign in to Google Drive"
              aria-label="Sign in"
            >
              <LogIn className="w-3.5 h-3.5" aria-hidden />
              <span className="hidden xs:inline">Sign in</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={onSync}
              disabled={isSyncing}
              className={`flex items-center gap-2 px-3 py-2 bg-indigo-600/10 text-indigo-600 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-indigo-600/20 transition-all ${isSyncing ? "animate-pulse" : ""}`}
              title="Sync with Google Drive"
              aria-label="Sync"
            >
              <RefreshCw className="w-3.5 h-3.5" aria-hidden />
              <span className="hidden xs:inline">Sync</span>
            </button>
          )}
          <button
            type="button"
            onClick={onSaveState}
            disabled={isSaving}
            className={`p-2.5 rounded-xl bg-indigo-600/10 text-indigo-600 hover:bg-indigo-600/20 transition-all disabled:opacity-60 disabled:cursor-not-allowed ${isDirty ? "ring-2 ring-indigo-600 animate-pulse" : ""}`}
            title={isSaving ? "Saving..." : "Manual Cloud Save"}
            aria-label="Save"
          >
            {isSaving ? (
              <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
            ) : (
              <Save className="w-4 h-4" aria-hidden />
            )}
          </button>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-hidden relative flex">
        {activeTab === "reader" &&
          (isLoadingChapter ||
            playbackPhase === "LOADING_TEXT" ||
            playbackPhase === "LOADING_AUDIO") && (
            <div className="absolute inset-0 flex items-center justify-center bg-inherit z-[70]">
              <div className="flex flex-col items-center gap-3">
                <Loader2 className="w-10 h-10 text-indigo-600 animate-spin" />
                <span className="text-[10px] font-black uppercase tracking-widest opacity-60">
                  {playbackPhase === "LOADING_TEXT" ? "Loading Text..." : "Loading Audio..."}
                </span>
              </div>
            </div>
          )}
        {children}
      </div>
    </div>
  );
});

export default AppShell;
