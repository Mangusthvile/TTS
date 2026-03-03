import React, { useState, useMemo } from "react";
import { Theme, JobRecord } from "../../../types";
import { List, ChevronDown, ChevronUp } from "lucide-react";
import { Capacitor } from "@capacitor/core";
import type { DiagnosticsReport } from "../../../services/diagnosticsService";

const labelClass = (isDark: boolean) =>
  `text-[11px] font-black uppercase tracking-[0.2em] mb-4 block ${isDark ? "text-indigo-400" : "text-indigo-600"}`;

export interface JobListPanelProps {
  jobs: JobRecord[];
  theme: Theme;
  settings: { uiMode: string };
  notificationStatus?: { supported: boolean; granted: boolean; enabled: boolean } | null;
  jobRunnerAvailable?: boolean;
  diagnosticsReport?: DiagnosticsReport | null;
  onRefreshJobs?: () => void;
  onCancelJob?: (jobId: string) => void;
  onRetryJob?: (jobId: string) => void;
  onDeleteJob?: (jobId: string) => void;
  onClearJobs?: (statuses: string[]) => void;
  onRefreshJob?: (jobId: string) => void;
  onForceStartJob?: (jobId: string) => void;
  onShowWorkInfo?: (jobId: string) => void;
  logJobs?: boolean;
  onToggleLogJobs?: (v: boolean) => void;
  onRefreshDiagnostics?: () => void;
  onSaveDiagnostics?: () => void;
  onCopyDiagnostics?: () => void;
}

const JobListPanel: React.FC<JobListPanelProps> = ({
  jobs,
  theme,
  settings,
  notificationStatus = null,
  jobRunnerAvailable = false,
  diagnosticsReport = null,
  onRefreshJobs,
  onCancelJob,
  onRetryJob,
  onDeleteJob,
  onClearJobs,
  onRefreshJob,
  onForceStartJob,
  onShowWorkInfo,
  logJobs = false,
  onToggleLogJobs,
  onRefreshDiagnostics,
  onSaveDiagnostics,
  onCopyDiagnostics,
}) => {
  const [jobBusy, setJobBusy] = useState(false);
  const [isJobsDiagnosticsOpen, setIsJobsDiagnosticsOpen] = useState(false);
  const [isSystemDiagnosticsOpen, setIsSystemDiagnosticsOpen] = useState(false);

  const isDark = theme === Theme.DARK;
  const cardBg = isDark ? "bg-slate-900 border-slate-800" : "bg-white border-black/10";

  const sortedJobs = useMemo(
    () => [...jobs].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)),
    [jobs]
  );
  const queuedJobs = useMemo(() => sortedJobs.filter((j) => j.status === "queued"), [sortedJobs]);
  const activeJobs = useMemo(
    () => sortedJobs.filter((j) => j.status === "running" || j.status === "paused"),
    [sortedJobs]
  );
  const jobCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const j of jobs) counts[j.status] = (counts[j.status] ?? 0) + 1;
    return counts;
  }, [jobs]);

  const platform = Capacitor.getPlatform?.() ?? "web";
  const androidVersion = (navigator.userAgent || "").match(/Android ([0-9.]+)/)?.[1] || "n/a";
  const notifSummary = notificationStatus
    ? `${notificationStatus.granted ? "granted" : "denied"} · enabled:${notificationStatus.enabled ? "yes" : "no"}${notificationStatus.supported ? "" : " · unsupported"}`
    : "unknown";
  const nativeJobsAvailable = jobRunnerAvailable;
  const diag = diagnosticsReport;
  const workDiag: Record<string, unknown> = (diag?.workManager as Record<string, unknown>) ?? {};
  const tableLine = diag
    ? Object.entries(diag.tables)
        .map(([k, v]) => `${k}:${v ? "yes" : "no"}`)
        .join("  ")
    : "";
  const countLine = diag
    ? Object.entries(diag.counts)
        .map(([k, v]) => `${k}:${v ?? "n/a"}`)
        .join("  ")
    : "";

  return (
    <div className="space-y-6">
      <div className={`p-6 sm:p-8 rounded-[2rem] border shadow-sm ${cardBg}`}>
        <div className="flex items-center justify-between">
          <label className={labelClass(isDark)}>
            <List className="w-3.5 h-3.5 inline mr-2" /> Jobs
          </label>
          <button
            onClick={onRefreshJobs}
            className="text-[10px] font-black uppercase tracking-widest text-indigo-500"
          >
            Refresh
          </button>
        </div>

        <div className="flex flex-wrap gap-2">
          <div
            className={`px-3 py-1 rounded-full text-[9px] font-black uppercase tracking-widest ${isDark ? "bg-white/5" : "bg-black/5"}`}
          >
            Active: {activeJobs.length}
          </div>
          <div
            className={`px-3 py-1 rounded-full text-[9px] font-black uppercase tracking-widest ${isDark ? "bg-white/5" : "bg-black/5"}`}
          >
            Queued: {queuedJobs.length}
          </div>
        </div>
        <p className="text-[10px] opacity-50 mt-3">
          Background jobs are paused right now; use Remove or Clear Finished to clean old entries.
        </p>

        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div
            className={`p-3 rounded-xl border ${isDark ? "border-slate-800 bg-slate-950/40" : "border-black/5 bg-white"}`}
          >
            <div className="text-[10px] font-black uppercase tracking-widest opacity-60 mb-2">
              Job Controls
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                disabled={jobBusy || !onRefreshJobs}
                onClick={onRefreshJobs}
                className="px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest bg-white text-indigo-600 border border-indigo-600/20"
              >
                Refresh Jobs
              </button>
              <button
                disabled={jobBusy || !onClearJobs}
                onClick={async () => {
                  if (!onClearJobs) return;
                  setJobBusy(true);
                  await onClearJobs(["canceled", "failed", "completed"]);
                  setJobBusy(false);
                  onRefreshJobs?.();
                }}
                className={`px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest ${isDark ? "bg-white/10 text-slate-100" : "bg-black/5 text-black"}`}
              >
                Clear Finished
              </button>
              <label className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest">
                <input
                  type="checkbox"
                  checked={!!logJobs}
                  onChange={(e) => onToggleLogJobs?.(e.target.checked)}
                />
                Log Jobs
              </label>
            </div>
          </div>
        </div>

        <div className="mt-6 space-y-3">
          <div
            className={`p-3 rounded-xl border ${isDark ? "border-slate-800 bg-slate-950/40" : "border-black/5 bg-white"}`}
          >
            <button
              onClick={() => setIsJobsDiagnosticsOpen((v) => !v)}
              className="w-full flex items-center justify-between text-left"
              title={
                isJobsDiagnosticsOpen ? "Collapse Jobs Diagnostics" : "Expand Jobs Diagnostics"
              }
            >
              <div className="text-xs font-black">Jobs Diagnostics</div>
              {isJobsDiagnosticsOpen ? (
                <ChevronUp className="w-4 h-4 opacity-70" />
              ) : (
                <ChevronDown className="w-4 h-4 opacity-70" />
              )}
            </button>
            {isJobsDiagnosticsOpen && (
              <>
                <div className="text-[10px] font-mono space-y-1">
                  <div>InterfaceMode: {settings.uiMode}</div>
                  <div>Platform: {platform}</div>
                  <div>Android Build: {androidVersion}</div>
                  <div>Notifications: {notifSummary}</div>
                  <div>
                    Counts:{" "}
                    {Object.entries(jobCounts)
                      .map(([k, v]) => `${k}:${v}`)
                      .join("  ") || "none"}
                  </div>
                </div>
                <div className="mt-2 text-[10px] font-mono space-y-1 max-h-48 overflow-auto pr-1 break-all">
                  {sortedJobs.map((job) => {
                    const progress =
                      ((job as Record<string, unknown>).progressJson as Record<string, unknown>) ||
                      {};
                    const total = Number(progress.total ?? 0);
                    const completed = Number(progress.completed ?? 0);
                    const currentChapterId = (progress.currentChapterId as string) ?? "";
                    const correlationId =
                      (progress.correlationId as string) ??
                      ((job.payloadJson as Record<string, unknown>)?.correlationId as string) ??
                      "";
                    const updatedAt = job.updatedAt
                      ? new Date(job.updatedAt).toLocaleTimeString()
                      : "";
                    const diagParts = [
                      job.type,
                      job.status,
                      `${completed}/${total}`,
                      currentChapterId || "none",
                      updatedAt,
                    ];
                    if (correlationId) diagParts.push(`corr:${correlationId}`);
                    const diagLine = diagParts.join(" · ");
                    return (
                      <div key={`diag-${job.jobId}`} className="border-t border-white/10 pt-1">
                        <div>{job.jobId}</div>
                        <div>{diagLine}</div>
                      </div>
                    );
                  })}
                  {sortedJobs.length === 0 && <div>No jobs</div>}
                </div>
              </>
            )}
          </div>

          <div
            className={`p-3 rounded-xl border ${isDark ? "border-slate-800 bg-slate-950/40" : "border-black/5 bg-white"}`}
          >
            <button
              onClick={() => setIsSystemDiagnosticsOpen((v) => !v)}
              className="w-full flex items-center justify-between text-left"
              title={
                isSystemDiagnosticsOpen
                  ? "Collapse System Diagnostics"
                  : "Expand System Diagnostics"
              }
            >
              <div className="text-xs font-black">System Diagnostics</div>
              {isSystemDiagnosticsOpen ? (
                <ChevronUp className="w-4 h-4 opacity-70" />
              ) : (
                <ChevronDown className="w-4 h-4 opacity-70" />
              )}
            </button>
            {isSystemDiagnosticsOpen && (
              <>
                {diag ? (
                  <div className="text-[10px] font-mono space-y-1 break-all">
                    <div>
                      SQLite: cached={String(diag.sqlite.cached)} open={String(diag.sqlite.isOpen)}{" "}
                      pending=
                      {String(diag.sqlite.pending)} hasConn={String(diag.sqlite.hasConnection)}
                    </div>
                    {diag.sqlite.error && <div>SQLite error: {diag.sqlite.error}</div>}
                    <div>Tables: {tableLine || "n/a"}</div>
                    <div>Counts: {countLine || "n/a"}</div>
                    <div>
                      Text files: {diag.fileCache.textFiles} · missing refs:{" "}
                      {diag.fileCache.missingTextFiles.length}
                    </div>
                    <div>
                      Audio files: {diag.fileCache.audioFiles} · missing refs:{" "}
                      {diag.fileCache.missingAudioFiles.length}
                    </div>
                    <div>
                      WorkMgr: perm={String(workDiag.permission ?? "n/a")} · channel=
                      {workDiag.channelExists ? "yes" : "no"} · fgRecent=
                      {String(workDiag.foregroundRecent ?? "n/a")}
                    </div>
                    {workDiag.dbFileExists !== undefined && (
                      <div>
                        Native DB: file={workDiag.dbFileExists ? "yes" : "no"}
                        {workDiag.dbPath ? ` · ${workDiag.dbPath}` : ""}
                      </div>
                    )}
                    {diag.fileCache.missingTextFiles.length > 0 && (
                      <div>
                        Missing text sample:{" "}
                        {diag.fileCache.missingTextFiles.slice(0, 5).join(", ")}
                      </div>
                    )}
                    {diag.fileCache.missingAudioFiles.length > 0 && (
                      <div>
                        Missing audio sample:{" "}
                        {diag.fileCache.missingAudioFiles.slice(0, 5).join(", ")}
                      </div>
                    )}
                    {diag.config && (
                      <div className="pt-2">
                        <div className="text-[10px] font-black uppercase tracking-widest opacity-70">
                          Config
                        </div>
                        <pre className="text-[9px] font-mono opacity-70 whitespace-pre-wrap">
                          {JSON.stringify(diag.config, null, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-[10px] font-mono opacity-60">No diagnostics yet.</div>
                )}
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    disabled={!onRefreshDiagnostics}
                    onClick={() => onRefreshDiagnostics?.()}
                    className="px-3 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest bg-indigo-600/10 text-indigo-600 hover:bg-indigo-600/20"
                  >
                    Refresh Diagnostics
                  </button>
                  <button
                    onClick={onCopyDiagnostics}
                    className="px-3 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest bg-indigo-600/10 text-indigo-600 hover:bg-indigo-600/20"
                  >
                    Copy Diagnostics
                  </button>
                  {onSaveDiagnostics && (
                    <button
                      onClick={onSaveDiagnostics}
                      className={`px-3 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest ${isDark ? "bg-white/10 text-slate-100" : "bg-black/5 text-black"}`}
                    >
                      Save Diagnostics
                    </button>
                  )}
                </div>
              </>
            )}
          </div>

          {sortedJobs.length === 0 && (
            <div className="text-xs font-bold opacity-50">No jobs yet.</div>
          )}

          {sortedJobs.map((job) => {
            const progress =
              ((job as Record<string, unknown>).progressJson as Record<string, unknown>) || {};
            const total = Number(progress.total ?? 0);
            const completed = Number(progress.completed ?? 0);
            const currentChapterProgress = Number(progress.currentChapterProgress ?? 0);
            const clampedChapterProgress = Math.max(0, Math.min(1, currentChapterProgress));
            const effectiveCompleted =
              total > 0 ? Math.min(total, completed + clampedChapterProgress) : completed;
            const currentChapterId = (progress.currentChapterId as string) ?? "";
            const workRequestId = (progress.workRequestId as string) ?? "";
            const correlationId =
              (progress.correlationId as string) ??
              ((job.payloadJson as Record<string, unknown>)?.correlationId as string) ??
              "";
            const percent = total > 0 ? Math.min(100, (effectiveCompleted / total) * 100) : 0;
            const percentText = total > 0 ? percent.toFixed(1) : "0.0";
            const completedText = total > 0 ? effectiveCompleted.toFixed(1) : String(completed);
            const jobLabel =
              job.type === "fixIntegrity"
                ? "Fix Integrity"
                : job.type === "drive_upload_queue" || job.type === "uploadQueue"
                  ? "Upload Audio"
                  : "Generate Audio";
            const errorMessage = typeof job.error === "string" ? job.error : "";
            const pausedAuthOrOutage =
              job.status === "paused_auth_expired" || job.status === "paused_service_outage";
            const showError =
              !!errorMessage &&
              (job.status === "failed" ||
                job.status === "canceled" ||
                pausedAuthOrOutage);
            const showInfo = !!errorMessage && !showError && errorMessage !== "Uploads complete";
            const detailError = showError || showInfo ? errorMessage : "";
            const canCancel =
              job.status === "queued" || job.status === "running" || job.status === "paused";
            const canRetry =
              job.status === "failed" ||
              job.status === "canceled" ||
              pausedAuthOrOutage;
            const canRemove = job.status !== "running" && job.status !== "paused";

            return (
              <div
                key={job.jobId}
                className={`p-3 rounded-xl border ${isDark ? "border-slate-800 bg-slate-950/40" : "border-black/5 bg-white"}`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs font-black">{jobLabel}</div>
                    <div className="text-[10px] font-black uppercase tracking-widest opacity-60">
                      Status: {job.status}
                    </div>
                  </div>
                  <div className="flex gap-2 flex-shrink-0">
                    {canCancel && onCancelJob && (
                      <button
                        onClick={() => onCancelJob(job.jobId)}
                        className="px-2 py-1 rounded-lg bg-red-500/10 text-red-600 text-[9px] font-black uppercase"
                      >
                        Cancel
                      </button>
                    )}
                    {canRetry && onRetryJob && (
                      <button
                        onClick={() => onRetryJob(job.jobId)}
                        className="px-2 py-1 rounded-lg bg-indigo-500/10 text-indigo-600 text-[9px] font-black uppercase"
                      >
                        Retry
                      </button>
                    )}
                    {canRemove && onDeleteJob && (
                      <button
                        onClick={() => onDeleteJob(job.jobId)}
                        className={`px-2 py-1 rounded-lg text-[9px] font-black uppercase ${isDark ? "bg-white/10 text-slate-100" : "bg-black/10 text-black"}`}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>
                <div className="mt-2">
                  <div
                    className={`h-2 rounded-full overflow-hidden ${isDark ? "bg-slate-800" : "bg-black/5"}`}
                  >
                    <div className="h-full bg-indigo-600" style={{ width: `${percent}%` }} />
                  </div>
                  <div className="mt-1 text-[10px] font-black opacity-60">
                    {completedText}/{total} ({percentText}%)
                  </div>
                  <div className="mt-1 text-[10px] font-mono opacity-50">
                    updated: {job.updatedAt ? new Date(job.updatedAt).toLocaleTimeString() : "n/a"}{" "}
                    · work: {workRequestId || "none"} · chapter: {currentChapterId || "n/a"}
                    {correlationId ? ` · corr:${correlationId}` : ""}
                    {detailError ? ` · err:${detailError}` : ""}
                  </div>
                </div>
                {showError && (
                  <div className="mt-2 text-[10px] font-bold text-red-500 truncate">
                    Error: {errorMessage}
                  </div>
                )}
                {showInfo && (
                  <div className="mt-2 text-[10px] font-bold text-amber-400 truncate">
                    {errorMessage}
                  </div>
                )}
                <div className="mt-2 flex flex-wrap gap-2 text-[10px] font-black uppercase tracking-widest">
                  {onRefreshJob && (
                    <button
                      onClick={() => onRefreshJob(job.jobId)}
                      className={`px-2 py-1 rounded-lg ${isDark ? "bg-white/10 text-slate-100" : "bg-black/10 text-black"}`}
                    >
                      Refresh
                    </button>
                  )}
                  {onForceStartJob && (
                    <button
                      disabled={!nativeJobsAvailable}
                      onClick={() => nativeJobsAvailable && onForceStartJob(job.jobId)}
                      className="px-2 py-1 rounded-lg bg-amber-500/20 text-amber-600 disabled:opacity-50"
                    >
                      Force Start
                    </button>
                  )}
                  {canCancel && onCancelJob && (
                    <button
                      onClick={() => onCancelJob(job.jobId)}
                      className="px-2 py-1 rounded-lg bg-red-500/10 text-red-600"
                    >
                      Cancel
                    </button>
                  )}
                  {canRetry && onRetryJob && (
                    <button
                      onClick={() => onRetryJob(job.jobId)}
                      className="px-2 py-1 rounded-lg bg-indigo-500/10 text-indigo-600"
                    >
                      Retry
                    </button>
                  )}
                  {onShowWorkInfo && (
                    <button
                      disabled={!nativeJobsAvailable}
                      onClick={() => nativeJobsAvailable && onShowWorkInfo(job.jobId)}
                      className="px-2 py-1 rounded-lg bg-slate-700/20 text-slate-200 disabled:opacity-50"
                    >
                      Show work info
                    </button>
                  )}
                  {canRemove && onDeleteJob && (
                    <button
                      onClick={() => onDeleteJob(job.jobId)}
                      className={`px-2 py-1 rounded-lg ${isDark ? "bg-white/10 text-slate-100" : "bg-black/10 text-black"}`}
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default JobListPanel;
