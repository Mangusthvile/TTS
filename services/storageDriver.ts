// services/storageDriver.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

import { Capacitor } from "@capacitor/core";
import { SqliteStorageDriver } from "./sqliteStorageDriver";
import type { JobRecord, JobType } from "../types";

/**
 * Phase 2.2/2.3 — StorageDriver
 *
 * Single storage API for the app.
 * - On native (Capacitor Android): use SQLite (durable).
 * - On web: fall back to safe localStorage (size-capped) or memory.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [k: string]: JsonValue }
  | JsonValue[];

export type AppState = Record<string, any>;
export type SettingsState = Record<string, any>;
export type RulesState = Record<string, any>;
export type AuthSession = {
  accessToken: string | null;
  expiresAt: number;
  userEmail?: string;
  status?: string;
};

export type ChapterProgress = {
  chapterId: string;
  timeSec: number;
  durationSec?: number;
  percent?: number;
  isComplete?: boolean;
  updatedAt: number;
};

export type StorageInitResult = {
  driverName: string;
  mode: "memory" | "localStorage" | "sqlite" | "unknown";
};

export type SaveResult = {
  ok: boolean;
  where: "memory" | "localStorage" | "sqlite" | "unknown";
  error?: string;
};

export type LoadResult<T> = {
  ok: boolean;
  value?: T;
  where: "memory" | "localStorage" | "sqlite" | "unknown";
  error?: string;
};

export type StorageDriver = {
  name: string;
  init(): Promise<StorageInitResult>;
  close(): Promise<void>;

  loadAppState(): Promise<LoadResult<AppState>>;
  saveAppState(state: AppState): Promise<SaveResult>;

  loadSettings(): Promise<LoadResult<SettingsState>>;
  saveSettings(settings: SettingsState): Promise<SaveResult>;

  loadRules(): Promise<LoadResult<RulesState>>;
  saveRules(rules: RulesState): Promise<SaveResult>;

  loadAuthSession(): Promise<LoadResult<AuthSession | null>>;
  saveAuthSession(session: AuthSession): Promise<SaveResult>;
  clearAuthSession(): Promise<SaveResult>;

  loadChapterProgress(chapterId: string): Promise<LoadResult<ChapterProgress | null>>;
  saveChapterProgress(progress: ChapterProgress): Promise<SaveResult>;

  saveSmallBackupSnapshot(snapshot: Record<string, any>): Promise<SaveResult>;
  loadSmallBackupSnapshot(): Promise<LoadResult<Record<string, any> | null>>;

  createJob(job: JobRecord): Promise<SaveResult>;
  updateJob(jobId: string, patch: Partial<Omit<JobRecord, "jobId" | "createdAt">>): Promise<SaveResult>;
  getJob(jobId: string): Promise<LoadResult<JobRecord | null>>;
  listJobs(type?: JobType): Promise<LoadResult<JobRecord[]>>;
  deleteJob(jobId: string): Promise<SaveResult>;
  clearJobs(statuses: string[]): Promise<SaveResult>;
  setChapterAudioPath(chapterId: string, localPath: string, sizeBytes: number): Promise<SaveResult>;
  getChapterAudioPath(chapterId: string): Promise<LoadResult<{ localPath: string; sizeBytes: number; updatedAt: number } | null>>;
  deleteChapterAudioPath(chapterId: string): Promise<SaveResult>;
  enqueueUpload(item: DriveUploadQueuedItem): Promise<SaveResult>;
  getNextReadyUpload(now: number): Promise<LoadResult<DriveUploadQueuedItem | null>>;
  markUploadUploading(id: string, nextAttemptAt: number): Promise<SaveResult>;
  markUploadDone(id: string): Promise<SaveResult>;
  markUploadFailed(id: string, error: string, nextAttemptAt: number): Promise<SaveResult>;
  countQueuedUploads(): Promise<LoadResult<number>>;
  listQueuedUploads(limit?: number): Promise<LoadResult<DriveUploadQueuedItem[]>>;
};

export type DriveUploadQueuedItem = {
  id: string;
  chapterId: string;
  bookId: string;
  localPath: string;
  status: 'queued' | 'uploading' | 'failed' | 'done';
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
};

function isNativeCapacitor(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      !!(window as any).Capacitor &&
      Capacitor.isNativePlatform()
    );
  } catch {
    return false;
  }
}

/**
 * Phase 2.3 selection:
 * - Native Android (Capacitor): SQLite
 * - Web: safe localStorage if available, else memory
 */
export function createStorageDriver(): StorageDriver {
  if (isNativeCapacitor()) {
    return new SqliteStorageDriver();
  }

  const hasLocalStorage =
    typeof window !== "undefined" &&
    typeof window.localStorage !== "undefined" &&
    window.localStorage != null;

  if (hasLocalStorage) return new SafeLocalStorageDriver();
  return new MemoryStorageDriver();
}

// ---------------------------
// Memory driver
// ---------------------------

class MemoryStorageDriver implements StorageDriver {
  name = "memory";

  private appState: AppState | null = null;
  private settings: SettingsState | null = null;
  private rules: RulesState | null = null;
  private authSession: AuthSession | null = null;
  private progress = new Map<string, ChapterProgress>();
  private smallBackup: Record<string, any> | null = null;
  private jobs = new Map<string, JobRecord>();
  private chapterAudio = new Map<string, { localPath: string; sizeBytes: number; updatedAt: number }>();
  private uploadQueue = new Map<string, DriveUploadQueuedItem>();

  async init(): Promise<StorageInitResult> {
    return { driverName: this.name, mode: "memory" };
  }

  async close(): Promise<void> {}

  async loadAppState(): Promise<LoadResult<AppState>> {
    if (!this.appState) return { ok: false, where: "memory", error: "no_state" };
    return { ok: true, where: "memory", value: this.appState };
  }

  async saveAppState(state: AppState): Promise<SaveResult> {
    this.appState = state;
    return { ok: true, where: "memory" };
  }

  async loadSettings(): Promise<LoadResult<SettingsState>> {
    if (!this.settings) return { ok: false, where: "memory", error: "no_settings" };
    return { ok: true, where: "memory", value: this.settings };
  }

  async saveSettings(settings: SettingsState): Promise<SaveResult> {
    this.settings = settings;
    return { ok: true, where: "memory" };
  }

  async loadRules(): Promise<LoadResult<RulesState>> {
    if (!this.rules) return { ok: false, where: "memory", error: "no_rules" };
    return { ok: true, where: "memory", value: this.rules };
  }

  async saveRules(rules: RulesState): Promise<SaveResult> {
    this.rules = rules;
    return { ok: true, where: "memory" };
  }

  async loadAuthSession(): Promise<LoadResult<AuthSession | null>> {
    return { ok: true, where: "memory", value: this.authSession };
  }

  async saveAuthSession(session: AuthSession): Promise<SaveResult> {
    this.authSession = session;
    return { ok: true, where: "memory" };
  }

  async clearAuthSession(): Promise<SaveResult> {
    this.authSession = null;
    return { ok: true, where: "memory" };
  }

  async loadChapterProgress(chapterId: string): Promise<LoadResult<ChapterProgress | null>> {
    return { ok: true, where: "memory", value: this.progress.get(chapterId) ?? null };
  }

  async saveChapterProgress(progress: ChapterProgress): Promise<SaveResult> {
    this.progress.set(progress.chapterId, progress);
    return { ok: true, where: "memory" };
  }

  async saveSmallBackupSnapshot(snapshot: Record<string, any>): Promise<SaveResult> {
    this.smallBackup = snapshot;
    return { ok: true, where: "memory" };
  }

  async loadSmallBackupSnapshot(): Promise<LoadResult<Record<string, any> | null>> {
    return { ok: true, where: "memory", value: this.smallBackup };
  }

  async createJob(job: JobRecord): Promise<SaveResult> {
    this.jobs.set(job.jobId, job);
    return { ok: true, where: "memory" };
  }

  async updateJob(jobId: string, patch: Partial<Omit<JobRecord, "jobId" | "createdAt">>): Promise<SaveResult> {
    const existing = this.jobs.get(jobId);
    if (!existing) return { ok: false, where: "memory", error: "missing" };
    const next: JobRecord = {
      ...existing,
      ...patch,
      jobId,
      createdAt: existing.createdAt,
      updatedAt: patch.updatedAt ?? Date.now(),
    };
    this.jobs.set(jobId, next);
    return { ok: true, where: "memory" };
  }

  async getJob(jobId: string): Promise<LoadResult<JobRecord | null>> {
    return { ok: true, where: "memory", value: this.jobs.get(jobId) ?? null };
  }

  async listJobs(type?: JobType): Promise<LoadResult<JobRecord[]>> {
    const all = Array.from(this.jobs.values());
    const filtered = type ? all.filter((j) => j.type === type) : all;
    return { ok: true, where: "memory", value: filtered };
  }

  async deleteJob(jobId: string): Promise<SaveResult> {
    this.jobs.delete(jobId);
    return { ok: true, where: "memory" };
  }

  async clearJobs(statuses: string[]): Promise<SaveResult> {
    const set = new Set(statuses);
    for (const [id, job] of this.jobs.entries()) {
      if (set.has(job.status)) this.jobs.delete(id);
    }
    return { ok: true, where: "memory" };
  }

  async setChapterAudioPath(chapterId: string, localPath: string, sizeBytes: number): Promise<SaveResult> {
    this.chapterAudio.set(chapterId, { localPath, sizeBytes, updatedAt: Date.now() });
    return { ok: true, where: "memory" };
  }

  async getChapterAudioPath(chapterId: string): Promise<LoadResult<{ localPath: string; sizeBytes: number; updatedAt: number } | null>> {
    return { ok: true, where: "memory", value: this.chapterAudio.get(chapterId) ?? null };
  }

  async deleteChapterAudioPath(chapterId: string): Promise<SaveResult> {
    this.chapterAudio.delete(chapterId);
    return { ok: true, where: "memory" };
  }

  private nowMs() {
    return Date.now();
  }

  async enqueueUpload(item: DriveUploadQueuedItem): Promise<SaveResult> {
    this.uploadQueue.set(item.id, { ...item });
    return { ok: true, where: "memory" };
  }

  async getNextReadyUpload(now: number): Promise<LoadResult<DriveUploadQueuedItem | null>> {
    let candidate: DriveUploadQueuedItem | null = null;
    for (const item of this.uploadQueue.values()) {
      if ((item.status === "queued" || item.status === "failed") && item.nextAttemptAt <= now) {
        if (!candidate || item.nextAttemptAt < candidate.nextAttemptAt) {
          candidate = item;
        }
      }
    }
    return { ok: true, where: "memory", value: candidate };
  }

  async markUploadUploading(id: string, nextAttemptAt: number): Promise<SaveResult> {
    const item = this.uploadQueue.get(id);
    if (!item) return { ok: false, where: "memory", error: "missing" };
    item.status = "uploading";
    item.attempts += 1;
    item.nextAttemptAt = nextAttemptAt;
    item.updatedAt = this.nowMs();
    this.uploadQueue.set(id, item);
    return { ok: true, where: "memory" };
  }

  async markUploadDone(id: string): Promise<SaveResult> {
    this.uploadQueue.delete(id);
    return { ok: true, where: "memory" };
  }

  async markUploadFailed(id: string, error: string, nextAttemptAt: number): Promise<SaveResult> {
    const item = this.uploadQueue.get(id);
    if (!item) return { ok: false, where: "memory", error: "missing" };
    item.status = "failed";
    item.lastError = error;
    item.nextAttemptAt = nextAttemptAt;
    item.attempts += 1;
    item.updatedAt = this.nowMs();
    this.uploadQueue.set(id, item);
    return { ok: true, where: "memory" };
  }

  async countQueuedUploads(): Promise<LoadResult<number>> {
    let count = 0;
    for (const item of this.uploadQueue.values()) {
      if (item.status === "queued" || item.status === "failed") count++;
    }
    return { ok: true, where: "memory", value: count };
  }

  async listQueuedUploads(limit?: number): Promise<LoadResult<DriveUploadQueuedItem[]>> {
    const list = Array.from(this.uploadQueue.values()).sort((a, b) => b.createdAt - a.createdAt);
    return { ok: true, where: "memory", value: typeof limit === "number" ? list.slice(0, limit) : list };
  }
}

// ----------------------------------------
// Safe localStorage driver (size-capped)
// ----------------------------------------

class SafeLocalStorageDriver implements StorageDriver {
  name = "safe-localStorage";

  private KEY_APP_STATE = "talevox_app_state_small";
  private KEY_SETTINGS = "talevox_settings";
  private KEY_RULES = "talevox_rules";
  private KEY_PROGRESS_PREFIX = "talevox_progress:";
  private KEY_SMALL_BACKUP = "talevox_small_backup";
  private KEY_AUTH_SESSION = "talevox_drive_session_v3";
<<<<<<< ours
  private KEY_JOBS_INDEX = "talevox_jobs_index";
  private KEY_JOB_PREFIX = "talevox_job:";
  private KEY_CHAPTER_AUDIO = "talevox_chapter_audio_map";
  private KEY_UPLOAD_QUEUE = "talevox_drive_upload_queue";
=======
>>>>>>> theirs

  private MAX_ITEM_BYTES = 180_000; // ~180KB per key

  async init(): Promise<StorageInitResult> {
    return { driverName: this.name, mode: "localStorage" };
  }

  async close(): Promise<void> {}

  async loadAppState(): Promise<LoadResult<AppState>> {
    return this.safeGetJson<AppState>(this.KEY_APP_STATE, "localStorage");
  }

  async saveAppState(state: AppState): Promise<SaveResult> {
    return this.safeSetJson(this.KEY_APP_STATE, state, "localStorage");
  }

  async loadSettings(): Promise<LoadResult<SettingsState>> {
    return this.safeGetJson<SettingsState>(this.KEY_SETTINGS, "localStorage");
  }

  async saveSettings(settings: SettingsState): Promise<SaveResult> {
    return this.safeSetJson(this.KEY_SETTINGS, settings, "localStorage");
  }

  async loadRules(): Promise<LoadResult<RulesState>> {
    return this.safeGetJson<RulesState>(this.KEY_RULES, "localStorage");
  }

  async saveRules(rules: RulesState): Promise<SaveResult> {
    return this.safeSetJson(this.KEY_RULES, rules, "localStorage");
  }

  async loadAuthSession(): Promise<LoadResult<AuthSession | null>> {
    return this.safeGetJson<AuthSession>(this.KEY_AUTH_SESSION, "localStorage");
  }

  async saveAuthSession(session: AuthSession): Promise<SaveResult> {
    return this.safeSetJson(this.KEY_AUTH_SESSION, session, "localStorage");
  }

  async clearAuthSession(): Promise<SaveResult> {
    try {
      localStorage.removeItem(this.KEY_AUTH_SESSION);
      return { ok: true, where: "localStorage" };
    } catch (e: any) {
      return { ok: false, where: "localStorage", error: e?.message ?? String(e) };
    }
  }

  async loadChapterProgress(chapterId: string): Promise<LoadResult<ChapterProgress | null>> {
    const key = this.KEY_PROGRESS_PREFIX + chapterId;
    const res = await this.safeGetJson<ChapterProgress>(key, "localStorage");
    if (!res.ok) return { ok: true, where: "localStorage", value: null };
    return { ok: true, where: "localStorage", value: res.value ?? null };
  }

  async saveChapterProgress(progress: ChapterProgress): Promise<SaveResult> {
    const key = this.KEY_PROGRESS_PREFIX + progress.chapterId;
    return this.safeSetJson(key, progress, "localStorage");
  }

  async saveSmallBackupSnapshot(snapshot: Record<string, any>): Promise<SaveResult> {
    return this.safeSetJson(this.KEY_SMALL_BACKUP, snapshot, "localStorage");
  }

  async loadSmallBackupSnapshot(): Promise<LoadResult<Record<string, any> | null>> {
    const res = await this.safeGetJson<Record<string, any>>(this.KEY_SMALL_BACKUP, "localStorage");
    if (!res.ok) return { ok: true, where: "localStorage", value: null };
    return { ok: true, where: "localStorage", value: res.value ?? null };
  }

  async createJob(job: JobRecord): Promise<SaveResult> {
    const key = this.KEY_JOB_PREFIX + job.jobId;
    const res = await this.safeSetJson(key, job, "localStorage");
    if (!res.ok) return res;
    await this.ensureJobIndex(job.jobId);
    return { ok: true, where: "localStorage" };
  }

  async updateJob(jobId: string, patch: Partial<Omit<JobRecord, "jobId" | "createdAt">>): Promise<SaveResult> {
    const existing = await this.getJob(jobId);
    if (!existing.ok || !existing.value) return { ok: false, where: "localStorage", error: "missing" };
    const next: JobRecord = {
      ...existing.value,
      ...patch,
      jobId,
      createdAt: existing.value.createdAt,
      updatedAt: patch.updatedAt ?? Date.now(),
    };
    const key = this.KEY_JOB_PREFIX + jobId;
    const res = await this.safeSetJson(key, next, "localStorage");
    if (!res.ok) return res;
    await this.ensureJobIndex(jobId);
    return { ok: true, where: "localStorage" };
  }

  async getJob(jobId: string): Promise<LoadResult<JobRecord | null>> {
    const key = this.KEY_JOB_PREFIX + jobId;
    const res = await this.safeGetJson<JobRecord>(key, "localStorage");
    if (!res.ok) return { ok: true, where: "localStorage", value: null };
    return { ok: true, where: "localStorage", value: res.value ?? null };
  }

  async listJobs(type?: JobType): Promise<LoadResult<JobRecord[]>> {
    const idsRes = await this.safeGetJson<string[]>(this.KEY_JOBS_INDEX, "localStorage");
    const ids = idsRes.ok && Array.isArray(idsRes.value) ? idsRes.value : [];
    const jobs: JobRecord[] = [];
    for (const id of ids) {
      const res = await this.getJob(id);
      if (res.ok && res.value) {
        if (!type || res.value.type === type) jobs.push(res.value);
      }
    }
    return { ok: true, where: "localStorage", value: jobs };
  }

  async deleteJob(jobId: string): Promise<SaveResult> {
    try {
      const key = this.KEY_JOB_PREFIX + jobId;
      localStorage.removeItem(key);
      const idsRes = await this.safeGetJson<string[]>(this.KEY_JOBS_INDEX, "localStorage");
      const ids = idsRes.ok && Array.isArray(idsRes.value) ? idsRes.value : [];
      const next = ids.filter((id) => id !== jobId);
      await this.safeSetJson(this.KEY_JOBS_INDEX, next, "localStorage");
      return { ok: true, where: "localStorage" };
    } catch (e: any) {
      return { ok: false, where: "localStorage", error: e?.message ?? String(e) };
    }
  }

  async clearJobs(statuses: string[]): Promise<SaveResult> {
    try {
      const idsRes = await this.safeGetJson<string[]>(this.KEY_JOBS_INDEX, "localStorage");
      const ids = idsRes.ok && Array.isArray(idsRes.value) ? idsRes.value : [];
      const kept: string[] = [];
      for (const id of ids) {
        const res = await this.getJob(id);
        if (!res.ok || !res.value) continue;
        if (statuses.includes(res.value.status)) {
          localStorage.removeItem(this.KEY_JOB_PREFIX + id);
        } else {
          kept.push(id);
        }
      }
      await this.safeSetJson(this.KEY_JOBS_INDEX, kept, "localStorage");
      return { ok: true, where: "localStorage" };
    } catch (e: any) {
      return { ok: false, where: "localStorage", error: e?.message ?? String(e) };
    }
  }

  private async loadChapterAudioMap(): Promise<Record<string, { localPath: string; sizeBytes: number; updatedAt: number }>> {
    try {
      const raw = window.localStorage.getItem(this.KEY_CHAPTER_AUDIO);
      if (!raw) return {};
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  private async saveChapterAudioMap(map: Record<string, { localPath: string; sizeBytes: number; updatedAt: number }>): Promise<SaveResult> {
    return this.safeSetJson(this.KEY_CHAPTER_AUDIO, map, "localStorage");
  }

  async setChapterAudioPath(chapterId: string, localPath: string, sizeBytes: number): Promise<SaveResult> {
    const map = await this.loadChapterAudioMap();
    map[chapterId] = { localPath, sizeBytes, updatedAt: Date.now() };
    return this.saveChapterAudioMap(map);
  }

  async getChapterAudioPath(chapterId: string): Promise<LoadResult<{ localPath: string; sizeBytes: number; updatedAt: number } | null>> {
    const map = await this.loadChapterAudioMap();
    return { ok: true, where: "localStorage", value: map[chapterId] ?? null };
  }

  async deleteChapterAudioPath(chapterId: string): Promise<SaveResult> {
    const map = await this.loadChapterAudioMap();
    if (map[chapterId]) {
      delete map[chapterId];
      return this.saveChapterAudioMap(map);
    }
    return { ok: true, where: "localStorage" };
  }

  private async loadUploadQueue(): Promise<Record<string, DriveUploadQueuedItem>> {
    try {
      const raw = window.localStorage.getItem(this.KEY_UPLOAD_QUEUE);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed;
    } catch {
      return {};
    }
  }

  private async saveUploadQueue(map: Record<string, DriveUploadQueuedItem>): Promise<SaveResult> {
    return this.safeSetJson(this.KEY_UPLOAD_QUEUE, map, "localStorage");
  }

  private nowMs() {
    return Date.now();
  }

  async enqueueUpload(item: DriveUploadQueuedItem): Promise<SaveResult> {
    const queue = await this.loadUploadQueue();
    queue[item.id] = { ...item };
    return this.saveUploadQueue(queue);
  }

  async getNextReadyUpload(now: number): Promise<LoadResult<DriveUploadQueuedItem | null>> {
    const queue = await this.loadUploadQueue();
    let candidate: DriveUploadQueuedItem | null = null;
    for (const item of Object.values(queue)) {
      if ((item.status === "queued" || item.status === "failed") && item.nextAttemptAt <= now) {
        if (!candidate || item.nextAttemptAt < candidate.nextAttemptAt) {
          candidate = item;
        }
      }
    }
    return { ok: true, where: "localStorage", value: candidate };
  }

  async markUploadUploading(id: string, nextAttemptAt: number): Promise<SaveResult> {
    const queue = await this.loadUploadQueue();
    const item = queue[id];
    if (!item) return { ok: false, where: "localStorage", error: "missing" };
    item.status = "uploading";
    item.attempts += 1;
    item.nextAttemptAt = nextAttemptAt;
    item.updatedAt = this.nowMs();
    queue[id] = item;
    return this.saveUploadQueue(queue);
  }

  async markUploadDone(id: string): Promise<SaveResult> {
    const queue = await this.loadUploadQueue();
    if (queue[id]) {
      delete queue[id];
      return this.saveUploadQueue(queue);
    }
    return { ok: true, where: "localStorage" };
  }

  async markUploadFailed(id: string, error: string, nextAttemptAt: number): Promise<SaveResult> {
    const queue = await this.loadUploadQueue();
    const item = queue[id];
    if (!item) return { ok: false, where: "localStorage", error: "missing" };
    item.status = "failed";
    item.lastError = error;
    item.nextAttemptAt = nextAttemptAt;
    item.attempts += 1;
    item.updatedAt = this.nowMs();
    queue[id] = item;
    return this.saveUploadQueue(queue);
  }

  async countQueuedUploads(): Promise<LoadResult<number>> {
    const queue = await this.loadUploadQueue();
    let count = 0;
    for (const item of Object.values(queue)) {
      if (item.status === "queued" || item.status === "failed") count++;
    }
    return { ok: true, where: "localStorage", value: count };
  }

  async listQueuedUploads(limit?: number): Promise<LoadResult<DriveUploadQueuedItem[]>> {
    const queue = await this.loadUploadQueue();
    const list = Object.values(queue).sort((a, b) => b.createdAt - a.createdAt);
    return { ok: true, where: "localStorage", value: typeof limit === "number" ? list.slice(0, limit) : list };
  }

  private async safeGetJson<T>(key: string, where: SaveResult["where"]): Promise<LoadResult<T>> {
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return { ok: false, where, error: "missing" };
      const parsed = JSON.parse(raw) as T;
      return { ok: true, where, value: parsed };
    } catch (e: any) {
      return { ok: false, where, error: e?.message ?? String(e) };
    }
  }

  private async safeSetJson(
    key: string,
    value: any,
    where: SaveResult["where"]
  ): Promise<SaveResult> {
    try {
      const raw = JSON.stringify(value);
      const bytes = this.estimateBytes(raw);

      if (bytes > this.MAX_ITEM_BYTES) {
        return {
          ok: false,
          where,
          error: `refused_write_too_large:${bytes}B>${this.MAX_ITEM_BYTES}B`,
        };
      }

      window.localStorage.setItem(key, raw);
      return { ok: true, where };
    } catch (e: any) {
      return { ok: false, where, error: e?.message ?? String(e) };
    }
  }

  private estimateBytes(s: string): number {
    return s.length * 2;
  }

  private async ensureJobIndex(jobId: string): Promise<void> {
    try {
      const res = await this.safeGetJson<string[]>(this.KEY_JOBS_INDEX, "localStorage");
      const list = res.ok && Array.isArray(res.value) ? res.value : [];
      if (!list.includes(jobId)) {
        list.push(jobId);
        await this.safeSetJson(this.KEY_JOBS_INDEX, list, "localStorage");
      }
    } catch {
      // Best-effort only
    }
  }
}
