import React, { useState, useEffect, useMemo, useRef, useLayoutEffect, useCallback } from "react";
import { Capacitor } from "@capacitor/core";
import { ReaderSettings, Theme, SyncDiagnostics, UiMode, JobRecord } from "../types";
import type { DiagnosticsReport } from "../services/diagnosticsService";
import JobListPanel from "../src/features/settings/JobListPanel";
import {
  RefreshCw,
  Cloud,
  CloudOff,
  Loader2,
  LogOut,
  Save,
  LogIn,
  Check,
  Sun,
  Coffee,
  Moon,
  FolderSync,
  Wrench,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Terminal,
  Timer,
  ClipboardCopy,
  FileWarning,
  Bug,
  Smartphone,
  Type,
  Palette,
  Monitor,
  LayoutTemplate,
  Library,
  List,
  Bell,
  Highlighter,
} from "lucide-react";
import { getAuthSessionInfo, isTokenValid, getValidDriveToken } from "../services/driveAuth";
import { appConfig } from "../src/config/appConfig";
import { authManager } from "../services/authManager";
import { getTraceDump } from "../utils/trace";
import { getLogBuffer } from "../utils/logger";

const DIAG_LOG_POLL_INTERVAL_MS = 3000;

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
  jobs?: JobRecord[];
  onRefreshJobs?: () => void;
  onCancelJob?: (jobId: string) => void;
  onRetryJob?: (jobId: string) => void;
  onDeleteJob?: (jobId: string) => void;
  onClearJobs?: (statuses: string[]) => void;
  logJobs?: boolean;
  onToggleLogJobs?: (v: boolean) => void;
  notificationStatus?: { supported: boolean; granted: boolean; enabled: boolean } | null;
  jobRunnerAvailable?: boolean;
  onRequestNotifications?: () => void;
  onOpenNotificationSettings?: () => void;
  onSendTestNotification?: () => void;
  onRefreshNotificationStatus?: () => void;
  onRefreshJob?: (jobId: string) => void;
  onForceStartJob?: (jobId: string) => void;
  onShowWorkInfo?: (jobId: string) => void;
  diagnosticsReport?: DiagnosticsReport | null;
  onRefreshDiagnostics?: () => void;
  onSaveDiagnostics?: () => void;
}

const Settings: React.FC<SettingsProps> = ({
  settings,
  onUpdate,
  theme,
  onSetTheme,
  keepAwake,
  onSetKeepAwake,
  onCheckForUpdates,
  onLinkCloud,
  onSyncNow,
  isSyncing,
  googleClientId,
  onUpdateGoogleClientId,
  onClearAuth,
  onSaveState,
  lastSavedAt,
  driveRootName,
  onSelectRoot,
  onRunMigration,
  syncDiagnostics,
  autoSaveInterval,
  onSetAutoSaveInterval,
  isDirty,
  showDiagnostics,
  onSetShowDiagnostics,
  onRecalculateProgress,
  jobs = [],
  onRefreshJobs,
  onCancelJob,
  onRetryJob,
  onDeleteJob,
  onClearJobs,
  logJobs = false,
  onToggleLogJobs,
  notificationStatus = null,
  jobRunnerAvailable = false,
  onRequestNotifications,
  onOpenNotificationSettings,
  onSendTestNotification,
  onRefreshNotificationStatus,
  onRefreshJob,
  onForceStartJob,
  onShowWorkInfo,
  diagnosticsReport = null,
  onRefreshDiagnostics,
  onSaveDiagnostics,
}) => {
  const [authState, setAuthState] = useState(authManager.getState());
  const [isDiagExpanded, setIsDiagExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<"general" | "jobs">("general");
  const [recentLogs, setRecentLogs] = useState(() => getLogBuffer(20));
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    appearance: true,
    interface: true,
    typography: true,
    highlight: false,
    notifications: false,
    library: false,
    system: false,
  });
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrollTopRef = useRef(0);
  const restoringRef = useRef(false);
  const restoreRafRef = useRef<number | null>(null);

  const lastFatalError = useMemo(() => {
    try {
      const raw = localStorage.getItem("talevox_last_fatal_error");
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    const unsubscribe = authManager.subscribe(setAuthState);
    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!isDiagExpanded) return;
    const interval = setInterval(() => {
      setRecentLogs(getLogBuffer(20));
    }, DIAG_LOG_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [isDiagExpanded]);

  useEffect(() => {
    return () => {
      if (restoreRafRef.current !== null) {
        cancelAnimationFrame(restoreRafRef.current);
        restoreRafRef.current = null;
      }
    };
  }, []);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    if (restoringRef.current) return;
    scrollTopRef.current = e.currentTarget.scrollTop;
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    scrollTopRef.current = 0;
    if (!el) return;
    restoringRef.current = true;
    if (typeof el.scrollTo === "function") {
      el.scrollTo({ top: 0, behavior: "auto" });
    } else {
      el.scrollTop = 0;
    }
    restoringRef.current = false;
  }, [activeTab]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (scrollTopRef.current <= 0) return;
    if (el.scrollTop !== 0) return;

    if (restoreRafRef.current !== null) {
      cancelAnimationFrame(restoreRafRef.current);
      restoreRafRef.current = null;
    }

    restoringRef.current = true;
    restoreRafRef.current = requestAnimationFrame(() => {
      const target = scrollRef.current;
      if (target) {
        target.scrollTop = scrollTopRef.current;
      }
      restoreRafRef.current = null;
      restoringRef.current = false;
    });
  }, [settings, openSections, theme, activeTab]);

  const isDark = theme === Theme.DARK;
  const isSepia = theme === Theme.SEPIA;
  const cardBg = isDark
    ? "bg-slate-900 border-slate-800"
    : isSepia
      ? "bg-[#f4ecd8] border-[#d8ccb6]"
      : "bg-white border-black/10";
  const textClass = "text-theme";
  const labelClass = `text-[11px] font-black uppercase tracking-[0.2em] mb-4 block ${isDark ? "text-indigo-400" : "text-indigo-600"}`;
  const sectionLabelClass = `text-[11px] font-black uppercase tracking-[0.2em] ${isDark ? "text-indigo-400" : "text-indigo-600"}`;

  const isAuthorized = authState.status === "signed_in";
  const expiryMinutes =
    authState.expiresAt > 0
      ? Math.max(0, Math.round((authState.expiresAt - Date.now()) / 60000))
      : 0;
  const jobCount = jobs.length;

  const themes = [
    {
      id: Theme.LIGHT,
      name: "Light Mode",
      icon: Sun,
      desc: "Clean high contrast",
      color: "bg-white border-slate-200",
    },
    {
      id: Theme.SEPIA,
      name: "Sepia Mode",
      icon: Coffee,
      desc: "Eye-friendly reading",
      color: "bg-[#f4ecd8] border-[#d8ccb6]",
    },
    {
      id: Theme.DARK,
      name: "Night Mode",
      icon: Moon,
      desc: "Optimized for dark",
      color: "bg-slate-950 border-slate-800",
    },
  ];

  const handleCopyDiagnostics = () => {
    const data = {
      sync: syncDiagnostics,
      fatal: lastFatalError,
      auth: { status: authState.status, hasToken: !!authState.accessToken },
      diagnostics: diagnosticsReport,
      version: window.__APP_VERSION__,
      userAgent: navigator.userAgent,
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

  const logPagingChecklist = () => {
    const lines = [
      "[QA][Paging] 1) Open a large book in Mobile UiMode",
      "[QA][Paging] 2) Scroll near bottom; expect next page to load (IO or fallback)",
      "[QA][Paging] 3) Confirm no duplicate rows and sentinel shows/hides correctly",
    ];
    console.log(lines.join("\n"));
    alert("Paging checklist logged to console.");
  };

  const logImportChecklist = () => {
    const lines = [
      "[QA][Import] 1) Switch UiMode to Mobile",
      "[QA][Import] 2) Tap Import -> pick a .txt/.md file via mobile picker",
      "[QA][Import] 3) Confirm chapter appears and survives app restart",
    ];
    console.log(lines.join("\n"));
    alert("Import checklist logged to console.");
  };

  const logBuildChecklist = () => {
    const lines = [
      `[QA][Build] Tailwind bundled; version ${window.__APP_VERSION__}`,
      "[QA][Build] No importmap/CDN overrides; run vite build --mode capacitor",
      "[QA][Build] Prod preview shows styles/colors intact",
    ];
    console.log(lines.join("\n"));
    alert("Build checklist logged to console.");
  };

  const notifSummary = notificationStatus
    ? `${notificationStatus.granted ? "granted" : "denied"} · enabled:${notificationStatus.enabled ? "yes" : "no"}${notificationStatus.supported ? "" : " · unsupported"}`
    : "unknown";
  const showUpdateControls = !import.meta.env.PROD;

  const toggleSection = (key: string) => {
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const Section = ({
    id,
    title,
    icon: Icon,
    children,
  }: {
    id: string;
    title: string;
    icon: React.ComponentType<{ className?: string }>;
    children: React.ReactNode;
  }) => {
    const open = openSections[id] ?? false;
    return (
      <div className={`p-6 sm:p-8 rounded-[2rem] border shadow-sm ${cardBg}`}>
        <button
          onClick={() => toggleSection(id)}
          className="w-full flex items-center justify-between gap-4 text-left"
        >
          <span className={`${sectionLabelClass}`}>
            <Icon className="w-3.5 h-3.5 inline mr-2" /> {title}
          </span>
          {open ? (
            <ChevronUp className="w-4 h-4 opacity-60" />
          ) : (
            <ChevronDown className="w-4 h-4 opacity-60" />
          )}
        </button>
        {open && <div className="mt-6">{children}</div>}
      </div>
    );
  };

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="p-4 sm:p-8 h-full overflow-y-auto transition-colors duration-500 bg-surface text-theme"
    >
      <div className="max-w-2xl mx-auto space-y-8 sm:space-y-12 pb-32">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-end gap-4">
          <div>
            <h2 className={`text-2xl sm:text-3xl font-black tracking-tight ${textClass}`}>
              Settings
            </h2>
            <p
              className={`text-xs sm:text-sm font-bold mt-1 ${isDark ? "text-slate-400" : "text-slate-500"}`}
            >
              VoxLib Engine v{window.__APP_VERSION__}
            </p>
          </div>
          {showUpdateControls && (
            <button
              onClick={onCheckForUpdates}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-[10px] font-black uppercase transition-all shadow-sm ${isDark ? "bg-slate-800 text-slate-100 hover:bg-slate-700" : isSepia ? "bg-[#e6d8b5] text-[#3c2f25] hover:bg-[#d9cab0]" : "bg-white text-black hover:bg-slate-50"}`}
            >
              <RefreshCw className="w-3.5 h-3.5" /> Check Updates
            </button>
          )}
        </div>

        <div
          className={`flex items-center gap-2 p-1 rounded-2xl ${isDark ? "bg-black/20" : "bg-black/5"}`}
        >
          <button
            onClick={() => setActiveTab("general")}
            className={`flex-1 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === "general" ? "bg-indigo-600 text-white shadow-md" : "opacity-60 hover:opacity-100"}`}
          >
            General
          </button>
          <button
            onClick={() => setActiveTab("jobs")}
            className={`flex-1 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center justify-center gap-2 ${activeTab === "jobs" ? "bg-indigo-600 text-white shadow-md" : "opacity-60 hover:opacity-100"}`}
          >
            <List className="w-3.5 h-3.5" /> Jobs {jobCount > 0 ? `(${jobCount})` : ""}
          </button>
        </div>

        <div className={activeTab === "general" ? "space-y-8 sm:space-y-12" : "hidden"}>
          <Section id="appearance" title="Appearance" icon={Palette}>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {themes.map((t) => (
                <button
                  key={t.id}
                  onClick={() => onSetTheme(t.id)}
                  className={`flex flex-col items-center gap-3 p-4 rounded-2xl border-2 transition-all ${theme === t.id ? "border-indigo-600 ring-1 ring-indigo-600/20" : "border-transparent hover:border-black/5"} ${t.color}`}
                >
                  <t.icon
                    className={`w-6 h-6 ${theme === t.id ? "text-indigo-600" : "opacity-40"}`}
                  />
                  <div className="text-center">
                    <div className={`text-xs font-black ${textClass}`}>{t.name}</div>
                    <div className="text-[10px] font-bold opacity-40">{t.desc}</div>
                  </div>
                </button>
              ))}
            </div>
          </Section>

          {!__ANDROID_ONLY__ && (
            <Section id="interface" title="Interface Mode" icon={LayoutTemplate}>
              <div className={`flex p-1 rounded-xl gap-1 ${isDark ? "bg-black/20" : "bg-black/5"}`}>
                {[
                  { id: "auto" as const, label: "Auto", icon: Smartphone },
                  { id: "desktop" as const, label: "Desktop", icon: Monitor },
                  { id: "mobile" as const, label: "Mobile", icon: Smartphone },
                ].map((m) => {
                  const isActive = settings.uiMode === m.id;
                  return (
                    <button
                      key={m.id}
                      onClick={() => handleSetUiMode(m.id)}
                      className={`flex-1 py-2.5 rounded-lg text-xs font-black transition-all flex items-center justify-center gap-2 ${isActive ? "bg-indigo-600 text-white shadow-md" : "opacity-60 hover:opacity-100"}`}
                    >
                      <m.icon className="w-3.5 h-3.5" />
                      {m.label}
                    </button>
                  );
                })}
              </div>
              <p className="text-[10px] opacity-60 mt-3 px-1">
                <b>Auto:</b> Picks the best UI for your device. <b>Mobile:</b> Touch‑optimized +
                background jobs. <b>Desktop:</b> Mouse‑friendly + precision tools.
              </p>
            </Section>
          )}

          {!!(appConfig.cloud?.batchJobsEndpoint || (import.meta as any)?.env?.VITE_TALEVOX_BATCH_JOBS_ENDPOINT || (import.meta as any)?.env?.VITE_BATCH_JOBS_ENDPOINT) && (
            <Section id="cloud-batch" title="Cloud audio generation" icon={Cloud}>
              <label
                className={`flex items-center justify-between gap-4 p-4 rounded-2xl cursor-pointer ${
                  theme === Theme.DARK
                    ? "bg-white/5 border border-white/10"
                    : "bg-black/5 border border-black/10"
                }`}
              >
                <div>
                  <div className="text-xs font-black">Use cloud batch for audio</div>
                  <div className="text-[10px] opacity-60 mt-0.5">
                    When on, all generate-audio jobs use the cloud (good for 50+ chapters).
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={!!settings.useCloudBatchForAudio}
                  onChange={(e) => onUpdate({ useCloudBatchForAudio: e.target.checked })}
                  className="rounded border-black/20 accent-indigo-600"
                />
              </label>
            </Section>
          )}

          <Section id="typography" title="Typography & Reading" icon={Type}>
            <div className="space-y-6">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <span className="text-[10px] font-black uppercase opacity-50">Font Family</span>
                  <select
                    value={settings.fontFamily}
                    onChange={(e) => onUpdate({ fontFamily: e.target.value })}
                    className={`w-full p-3 rounded-xl text-xs font-bold outline-none border ${isDark ? "bg-slate-950 border-slate-800" : "bg-slate-50 border-slate-200"}`}
                  >
                    <option value="'Source Serif 4', serif">Source Serif 4 (Book)</option>
                    <option value="'Inter', sans-serif">Inter (Modern)</option>
                    <option value="'Lora', serif">Lora (Elegant)</option>
                    <option value="'Merriweather', serif">Merriweather (Readability)</option>
                    <option value="'Open Dyslexic', sans-serif">Open Dyslexic</option>
                  </select>
                </div>
                <div className="space-y-2">
                  <span className="text-[10px] font-black uppercase opacity-50">
                    Base Size ({settings.fontSizePx}px)
                  </span>
                  <input
                    type="range"
                    min="14"
                    max="32"
                    step="1"
                    value={settings.fontSizePx}
                    onChange={(e) => onUpdate({ fontSizePx: parseInt(e.target.value) })}
                    className="w-full h-2 rounded-lg appearance-none bg-black/5 accent-indigo-600"
                  />
                </div>

                <div className="space-y-2">
                  <span className="text-[10px] font-black uppercase opacity-50">
                    Line Spacing ({settings.lineHeight.toFixed(2)})
                  </span>
                  <input
                    type="range"
                    min="1.2"
                    max="2.2"
                    step="0.05"
                    value={settings.lineHeight}
                    onChange={(e) => onUpdate({ lineHeight: parseFloat(e.target.value) })}
                    className="w-full h-2 rounded-lg appearance-none bg-black/5 accent-indigo-600"
                  />
                </div>

                <div className="space-y-2">
                  <span className="text-[10px] font-black uppercase opacity-50">
                    Paragraph Spacing
                  </span>
                  <select
                    value={settings.paragraphSpacing}
                    onChange={(e) => onUpdate({ paragraphSpacing: parseInt(e.target.value) })}
                    className={`w-full px-3 py-2 rounded-xl font-black text-sm ${
                      theme === Theme.DARK
                        ? "bg-white/5 border border-white/10"
                        : "bg-black/5 border border-black/10"
                    }`}
                  >
                    <option value={0}>Tight</option>
                    <option value={1}>Normal</option>
                    <option value={2}>Wide</option>
                    <option value={3}>Extra Wide</option>
                  </select>
                </div>

                <label
                  className={`flex items-center justify-between gap-4 p-4 rounded-2xl ${
                    theme === Theme.DARK
                      ? "bg-white/5 border border-white/10"
                      : "bg-black/5 border border-black/10"
                  }`}
                >
                  <div>
                    <div className="text-xs font-black">Reflow Line Breaks</div>
                    <div className="text-[10px] opacity-60">
                      Fix line wrapped chapters and make paragraphs look normal
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={settings.reflowLineBreaks}
                    onChange={(e) => onUpdate({ reflowLineBreaks: e.target.checked })}
                    className="w-5 h-5 accent-indigo-600"
                  />
                </label>

                <label
                  className={`flex items-center justify-between gap-4 p-4 rounded-2xl ${
                    theme === Theme.DARK
                      ? "bg-white/5 border border-white/10"
                      : "bg-black/5 border border-black/10"
                  }`}
                >
                  <div>
                    <div className="text-xs font-black">Speak Chapter Intro</div>
                    <div className="text-[10px] opacity-60">
                      Read “Chapter {`{number}`}. {`{title}`}.“ before content
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={settings.speakChapterIntro !== false}
                    onChange={(e) => onUpdate({ speakChapterIntro: e.target.checked })}
                    className="w-5 h-5 accent-indigo-600"
                  />
                </label>
              </div>
            </div>
          </Section>

          <Section id="highlight" title="Highlight" icon={Highlighter}>
            <div className="space-y-4">
              <label
                className={`flex items-center justify-between gap-4 p-4 rounded-2xl ${
                  theme === Theme.DARK
                    ? "bg-white/5 border border-white/10"
                    : "bg-black/5 border border-black/10"
                }`}
              >
                <div>
                  <div className="text-xs font-black">Highlight Text</div>
                  <div className="text-[10px] opacity-60">Toggle paragraph highlight sync</div>
                </div>
                <input
                  type="checkbox"
                  checked={settings.highlightEnabled !== false}
                  onChange={(e) => onUpdate({ highlightEnabled: e.target.checked })}
                  className="w-5 h-5 accent-indigo-600"
                />
              </label>

              <div
                className={`p-4 rounded-2xl ${theme === Theme.DARK ? "bg-white/5 border border-white/10" : "bg-black/5 border border-black/10"}`}
              >
                <div className="text-[10px] font-black uppercase opacity-50 mb-3">Update Rate</div>
                <div className="flex flex-wrap gap-2">
                  {[100, 200, 250, 300, 500].map((ms) => (
                    <button
                      key={ms}
                      onClick={() => onUpdate({ highlightUpdateRateMs: ms })}
                      className={`px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest border transition-all ${
                        (settings.highlightUpdateRateMs ?? (Capacitor.isNativePlatform?.() ? 250 : 100)) === ms
                          ? "bg-indigo-600 text-white border-indigo-600"
                          : "hover:bg-black/5 border-transparent"
                      }`}
                    >
                      {ms}ms
                    </button>
                  ))}
                </div>
              </div>

              {import.meta.env.DEV && (
                <label
                  className={`flex items-center justify-between gap-4 p-4 rounded-2xl ${
                    theme === Theme.DARK
                      ? "bg-white/5 border border-white/10"
                      : "bg-black/5 border border-black/10"
                  }`}
                >
                  <div>
                    <div className="text-xs font-black">Highlight Debug Overlay</div>
                    <div className="text-[10px] opacity-60">Show cue/paragraph sync data</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={settings.highlightDebugOverlay === true}
                    onChange={(e) => onUpdate({ highlightDebugOverlay: e.target.checked })}
                    className="w-5 h-5 accent-indigo-600"
                  />
                </label>
              )}
            </div>
          </Section>

          <Section id="library" title="Library Tools" icon={Library}>
            <div className="space-y-6">
              <div>
                <div className="flex justify-between items-center mb-4">
                  <label className={`${labelClass} mb-0`}>
                    <Cloud className="w-3.5 h-3.5 inline mr-2" /> Google Drive Sync
                  </label>
                  {isAuthorized && (
                    <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 text-[9px] font-black uppercase">
                      Active
                    </span>
                  )}
                </div>

                {!isAuthorized ? (
                  <div className="text-center py-8">
                    <p className="text-sm font-bold opacity-60 mb-6">
                      Connect Google Drive to sync books and progress across devices.
                    </p>
                    <button
                      onClick={() => authManager.signIn()}
                      disabled={authState.status === "signing_in"}
                      className="px-6 py-3 bg-indigo-600 text-white rounded-xl font-black uppercase text-xs tracking-widest shadow-xl hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2 mx-auto"
                    >
                      {authState.status === "signing_in" ? (
                        <>
                          <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />{" "}
                          Signing In...
                        </>
                      ) : (
                        <>
                          <LogIn className="w-4 h-4" /> Connect Drive
                        </>
                      )}
                    </button>
                    {authState.status === "signing_in" && (
                      <div className="mt-4 text-xs font-bold text-indigo-500 animate-pulse">
                        Check popup window...
                      </div>
                    )}
                    {authState.lastError && (
                      <div className="mt-4 space-y-3">
                        <div className="text-xs font-bold text-red-500">
                          {authState.lastError}
                        </div>
                        <button
                          type="button"
                          onClick={() => authManager.signInWithPrompt()}
                          disabled={authState.status === "signing_in"}
                          className="text-xs font-bold text-amber-600 hover:text-amber-700 underline disabled:opacity-50"
                        >
                          Try again (open account picker)
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="space-y-6">
                    <div
                      className={`p-4 rounded-xl border flex flex-col gap-2 ${isDark ? "bg-slate-950/50 border-slate-800" : "bg-slate-50 border-slate-200"}`}
                    >
                      <div className="flex justify-between items-center">
                        <span className="text-[10px] font-black uppercase opacity-50">
                          Sync Status
                        </span>
                        <span className="text-[10px] font-mono opacity-50">
                          Token expires in {expiryMinutes}m
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div
                          className={`w-2 h-2 rounded-full ${isSyncing ? "bg-indigo-500 animate-pulse" : isDirty ? "bg-amber-500" : "bg-emerald-500"}`}
                        />
                        <span className="text-xs font-bold">
                          {isSyncing ? "Syncing..." : isDirty ? "Changes Pending" : "Up to Date"}
                        </span>
                      </div>
                      {authState.userEmail && (
                        <div className="text-[10px] font-bold text-indigo-500">
                          {authState.userEmail}
                        </div>
                      )}
                      {lastSavedAt && (
                        <div className="text-[10px] opacity-40">
                          Last saved: {new Date(lastSavedAt).toLocaleString()}
                        </div>
                      )}
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <button
                        onClick={onSyncNow}
                        disabled={isSyncing}
                        className="flex items-center justify-center gap-2 px-4 py-3 bg-indigo-600 text-white rounded-xl text-xs font-black uppercase tracking-widest hover:bg-indigo-700 disabled:opacity-50"
                      >
                        {isSyncing ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <RefreshCw className="w-4 h-4" />
                        )}{" "}
                        Sync Now
                      </button>
                      <button
                        onClick={onSaveState}
                        disabled={isSyncing}
                        className="flex items-center justify-center gap-2 px-4 py-3 bg-indigo-600/10 text-indigo-600 rounded-xl text-xs font-black uppercase tracking-widest hover:bg-indigo-600/20 disabled:opacity-50"
                      >
                        <Save className="w-4 h-4" /> Force Cloud Save
                      </button>
                    </div>

                    <div className="space-y-2 pt-2 border-t border-black/5">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-black uppercase opacity-60">
                          Root Folder
                        </span>
                        <button
                          onClick={onSelectRoot}
                          className="text-[10px] font-black uppercase text-indigo-600 hover:underline"
                        >
                          Change
                        </button>
                      </div>
                      <div className="text-xs font-mono truncate opacity-80 flex items-center gap-2">
                        <FolderSync className="w-3 h-3" />
                        {driveRootName || "Not selected"}
                      </div>
                    </div>

                    <div className="space-y-2">
                      <span className="text-[10px] font-black uppercase opacity-60">
                        Auto-Save Interval
                      </span>
                      <div className="flex gap-2">
                        {[5, 15, 30].map((m) => (
                          <button
                            key={m}
                            onClick={() => onSetAutoSaveInterval(m)}
                            className={`flex-1 py-2 rounded-lg text-[10px] font-black border transition-all ${autoSaveInterval === m ? "bg-indigo-600 text-white border-indigo-600" : "hover:bg-black/5 border-transparent"}`}
                          >
                            {m}m
                          </button>
                        ))}
                      </div>
                    </div>

                    {onRunMigration && (
                      <button
                        onClick={onRunMigration}
                        className="w-full py-3 rounded-xl border-2 border-dashed border-amber-500/30 text-amber-600 hover:bg-amber-50 text-[10px] font-black uppercase tracking-widest flex items-center justify-center gap-2"
                      >
                        <Wrench className="w-3.5 h-3.5" /> Migrate Old Folder Structure
                      </button>
                    )}

                    <div className="flex flex-col gap-2 pt-4">
                      <button
                        onClick={handleForceReauth}
                        className="w-full text-center text-[10px] font-black uppercase tracking-widest opacity-40 hover:opacity-100 hover:text-indigo-600"
                      >
                        Re-check Connection
                      </button>
                      <button
                        onClick={onClearAuth}
                        className="w-full text-center text-red-500 text-[10px] font-black uppercase tracking-widest opacity-60 hover:opacity-100"
                      >
                        Sign Out / Unlink
                      </button>
                    </div>
                  </div>
                )}
              </div>
              <div className="space-y-4 pt-4 border-t border-black/5">
                {onRecalculateProgress && (
                  <button
                    onClick={onRecalculateProgress}
                    className="w-full py-3 rounded-xl bg-indigo-600/10 text-indigo-600 hover:bg-indigo-600/20 text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2 transition-all"
                  >
                    <RefreshCw className="w-4 h-4" /> Reconcile Progress From Saves
                  </button>
                )}
                <p className="text-[10px] opacity-50 px-1">
                  Fix inconsistent progress bars or "Done" status without resetting your actual
                  reading position.
                </p>
              </div>
            </div>
          </Section>

          <Section id="notifications" title="Notifications" icon={Bell}>
            {!jobRunnerAvailable && (
              <div className="text-[10px] font-bold text-amber-500 mb-2">
                Background notifications require the native Android plugin.
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                disabled={!onRequestNotifications || !jobRunnerAvailable}
                onClick={onRequestNotifications}
                className="px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest bg-indigo-600 text-white disabled:opacity-50"
              >
                Enable job notifications
              </button>
              <button
                disabled={!onOpenNotificationSettings || !jobRunnerAvailable}
                onClick={onOpenNotificationSettings}
                className={`px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest disabled:opacity-50 ${isDark ? "bg-white/10 text-slate-100" : "bg-black/10 text-black"}`}
              >
                Open notification settings
              </button>
              <button
                disabled={!onSendTestNotification || !jobRunnerAvailable}
                onClick={() => onSendTestNotification && onSendTestNotification()}
                className="px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest bg-white text-indigo-600 border border-indigo-600/20 disabled:opacity-50"
              >
                Send test notification
              </button>
              <button
                disabled={!onRefreshNotificationStatus || !jobRunnerAvailable}
                onClick={onRefreshNotificationStatus}
                className={`px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest disabled:opacity-50 ${isDark ? "bg-white/10 text-slate-100" : "bg-black/5 text-black"}`}
              >
                Refresh notification status
              </button>
            </div>
            <div className="mt-3 text-[10px] font-mono opacity-60">Status: {notifSummary}</div>
          </Section>

          <Section id="system" title="System" icon={Terminal}>
            <div className="space-y-4">
              <label className="flex items-center justify-between cursor-pointer">
                <div className="flex items-center gap-3">
                  <div
                    className={`p-2 rounded-lg ${keepAwake ? "bg-emerald-500 text-white" : "bg-black/5"}`}
                  >
                    <Smartphone className="w-4 h-4" />
                  </div>
                  <div>
                    <div className="text-xs font-black">Keep Awake</div>
                    <div className="text-[10px] opacity-60">Prevent screen sleep</div>
                    <div className="text-[10px] opacity-60">May increase device temperature and battery use.</div>
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={keepAwake}
                  onChange={(e) => onSetKeepAwake(e.target.checked)}
                  className="w-5 h-5 accent-indigo-600"
                />
              </label>

              <label className="flex items-center justify-between cursor-pointer">
                <div className="flex items-center gap-3">
                  <div
                    className={`p-2 rounded-lg ${showDiagnostics ? "bg-indigo-500 text-white" : "bg-black/5"}`}
                  >
                    <Bug className="w-4 h-4" />
                  </div>
                  <div>
                    <div className="text-xs font-black">Show Diagnostics</div>
                    <div className="text-[10px] opacity-60">Overlay debug info</div>
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={showDiagnostics}
                  onChange={(e) => onSetShowDiagnostics(e.target.checked)}
                  className="w-5 h-5 accent-indigo-600"
                />
              </label>

              <div
                className={`p-4 rounded-xl border ${isDark ? "border-slate-800 bg-slate-950/40" : "border-black/5 bg-white"}`}
              >
                <div className="text-[10px] font-black uppercase tracking-widest opacity-60 mb-2">
                  QA Sweep Shortcuts
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <button
                    onClick={logPagingChecklist}
                    className="px-3 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest bg-indigo-600/10 text-indigo-600 hover:bg-indigo-600/20"
                  >
                    Paging Test
                  </button>
                  <button
                    onClick={logImportChecklist}
                    className="px-3 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest bg-indigo-600/10 text-indigo-600 hover:bg-indigo-600/20"
                  >
                    Import Test
                  </button>
                  <button
                    onClick={logBuildChecklist}
                    className="px-3 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest bg-indigo-600/10 text-indigo-600 hover:bg-indigo-600/20"
                  >
                    Build/Tailwind Check
                  </button>
                </div>
                <p className="text-[10px] opacity-50 mt-2">
                  Each button logs a 3-step checklist to the console so you can sweep the main
                  features in under 10 minutes.
                </p>
              </div>

              <div
                className={`rounded-xl overflow-hidden border ${isDark ? "bg-black/20 border-slate-800" : "bg-black/5 border-black/5"}`}
              >
                <button
                  onClick={() => setIsDiagExpanded(!isDiagExpanded)}
                  className="w-full px-4 py-3 flex items-center justify-between text-[10px] font-black uppercase tracking-widest opacity-60 hover:opacity-100"
                >
                  <span>Debug Data</span>
                  {isDiagExpanded ? (
                    <ChevronUp className="w-3 h-3" />
                  ) : (
                    <ChevronDown className="w-3 h-3" />
                  )}
                </button>
                {isDiagExpanded && (
                  <div className="p-4 pt-0 space-y-3">
                    {syncDiagnostics && (
                      <div className="space-y-1">
                        <div className="text-[9px] font-black uppercase opacity-40">Sync State</div>
                        <pre className="text-[9px] font-mono opacity-60 overflow-x-auto">
                          {JSON.stringify(syncDiagnostics, null, 2)}
                        </pre>
                        {syncDiagnostics.lastSyncError && (
                          <div className="text-[10px] text-red-500 font-bold flex gap-1">
                            <AlertTriangle className="w-3 h-3" /> {syncDiagnostics.lastSyncError}
                          </div>
                        )}
                      </div>
                    )}
                    {lastFatalError && (
                      <div className="p-2 bg-red-500/10 rounded-lg border border-red-500/20">
                        <div className="text-[9px] font-black uppercase text-red-500 mb-1">
                          Last Crash
                        </div>
                        <div className="text-[10px] font-mono opacity-80">
                          {lastFatalError.message}
                        </div>
                        <div className="text-[9px] opacity-50 mt-1">
                          {new Date(lastFatalError.timestamp).toLocaleString()}
                        </div>
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-2 pt-2">
                      <button
                        onClick={handleCopyDiagnostics}
                        className="p-2 bg-indigo-600/10 text-indigo-600 rounded-lg text-[10px] font-black uppercase flex items-center justify-center gap-2 hover:bg-indigo-600/20"
                      >
                        <ClipboardCopy className="w-3 h-3" /> Copy Diag
                      </button>
                      <button
                        onClick={handleCopyTrace}
                        className="p-2 bg-emerald-600/10 text-emerald-600 rounded-lg text-[10px] font-black uppercase flex items-center justify-center gap-2 hover:bg-emerald-600/20"
                      >
                        <FileWarning className="w-3 h-3" /> Copy Trace
                      </button>
                    </div>
                    <div className="pt-3 border-t border-white/10">
                      <div className="text-[9px] font-black uppercase opacity-40 mb-1">
                        Recent Logs
                      </div>
                      <div className="text-[9px] font-mono space-y-1 max-h-40 overflow-auto">
                        {recentLogs.length === 0 && <div className="opacity-50">No logs yet.</div>}
                        {recentLogs.map((entry, idx) => (
                          <div key={`${entry.ts}-${idx}`} className="opacity-70">
                            [{new Date(entry.ts).toLocaleTimeString()}] {entry.level.toUpperCase()}{" "}
                            {entry.tag}: {entry.message}
                            {entry.context ? ` ${JSON.stringify(entry.context)}` : ""}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </Section>
        </div>

        <div className={activeTab === "jobs" ? "space-y-6" : "hidden"}>
          <JobListPanel
            jobs={jobs}
            theme={theme}
            settings={settings}
            notificationStatus={notificationStatus}
            jobRunnerAvailable={jobRunnerAvailable}
            diagnosticsReport={diagnosticsReport}
            onRefreshJobs={onRefreshJobs}
            onCancelJob={onCancelJob}
            onRetryJob={onRetryJob}
            onDeleteJob={onDeleteJob}
            onClearJobs={onClearJobs}
            onRefreshJob={onRefreshJob}
            onForceStartJob={onForceStartJob}
            onShowWorkInfo={onShowWorkInfo}
            logJobs={logJobs}
            onToggleLogJobs={onToggleLogJobs}
            onRefreshDiagnostics={onRefreshDiagnostics}
            onSaveDiagnostics={onSaveDiagnostics}
            onCopyDiagnostics={handleCopyDiagnostics}
          />
        </div>
      </div>
    </div>
  );
};

export default Settings;
