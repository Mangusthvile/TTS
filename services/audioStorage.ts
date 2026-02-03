import { Capacitor } from "@capacitor/core";
import { UiMode } from "../types";
import { computeMobileMode } from "../utils/platform";
import { Filesystem, Directory } from "@capacitor/filesystem";
import { appConfig } from "../src/config/appConfig";
import {
  setChapterAudioPath,
  getChapterAudioPath,
  deleteChapterAudioPath,
} from "./chapterAudioStore";

export type AudioChunk = Blob | ArrayBuffer | string;

export interface AudioStorage {
  saveAudio(chapterId: string, data: AudioChunk): Promise<string | null>;
  getAudioPath(chapterId: string): Promise<string | null>;
  deleteAudio(chapterId: string): Promise<void>;
}

export class DesktopAudioStorage implements AudioStorage {
  async saveAudio(): Promise<string | null> {
    return null;
  }

  async getAudioPath(): Promise<string | null> {
    return null;
  }

  async deleteAudio(): Promise<void> {
    // no-op
  }
}

export class MobileAudioStorage implements AudioStorage {
  private static STAT_TTL_MS = appConfig.cache.chapterAudioPathTtlMs;
  private static statCache = new Map<string, { ok: boolean; ts: number }>();

  private buildPath(chapterId: string) {
    return `${appConfig.paths.audioDir}/${chapterId}.mp3`;
  }

  private buildLegacyPath(chapterId: string) {
    return `audio/${chapterId}.mp3`;
  }

  private async normalizeChunk(data: AudioChunk): Promise<{ base64: string; sizeBytes: number }> {
    if (typeof data === "string") {
      const cleaned = this.stripDataUrl(data);
      return { base64: cleaned, sizeBytes: this.base64LengthBytes(cleaned) };
    }

    if (data instanceof Blob) {
      const base64 = await this.blobToBase64(data);
      return { base64, sizeBytes: data.size };
    }

    if (data instanceof ArrayBuffer) {
      const view = new Uint8Array(data);
      return { base64: this.uint8ToBase64(view), sizeBytes: view.length };
    }

    if (ArrayBuffer.isView(data)) {
      const viewData = data as ArrayBufferView;
      const view = new Uint8Array(viewData.buffer, viewData.byteOffset, viewData.byteLength);
      return { base64: this.uint8ToBase64(view), sizeBytes: view.length };
    }

    throw new Error("Unsupported audio chunk");
  }

  private stripDataUrl(value: string) {
    return value.replace(/^data:.*;base64,/, "");
  }

  private base64LengthBytes(base64: string): number {
    const padding = (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
    return Math.round((base64.length * 3) / 4) - padding;
  }

  private uint8ToBase64(data: Uint8Array) {
    const chunk = 0x8000;
    let binary = "";
    for (let i = 0; i < data.length; i += chunk) {
      const slice = data.subarray(i, i + chunk);
      binary += String.fromCharCode.apply(null, slice as any);
    }
    return btoa(binary);
  }

  private blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result === "string") {
          resolve(this.stripDataUrl(result));
        } else {
          reject(new Error("Invalid blob read result"));
        }
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  async saveAudio(chapterId: string, data: AudioChunk): Promise<string | null> {
    const { base64, sizeBytes } = await this.normalizeChunk(data);
    const path = this.buildPath(chapterId);
    const res = await Filesystem.writeFile({
      path,
      directory: Directory.Data,
      data: base64,
      recursive: true,
    });
    await setChapterAudioPath(chapterId, res.uri, sizeBytes);
    MobileAudioStorage.statCache.set(chapterId, { ok: true, ts: Date.now() });
    return res.uri;
  }

  async getAudioPath(chapterId: string): Promise<string | null> {
    const record = await getChapterAudioPath(chapterId);
    const cached = MobileAudioStorage.statCache.get(chapterId);
    if (cached && Date.now() - cached.ts < MobileAudioStorage.STAT_TTL_MS) {
      return cached.ok ? record?.localPath ?? null : null;
    }
    try {
      const primaryPath = this.buildPath(chapterId);
      await Filesystem.stat({
        path: primaryPath,
        directory: Directory.Data,
      });
      const uriRes = await Filesystem.getUri({ path: primaryPath, directory: Directory.Data });
      if (uriRes?.uri) {
        if (!record || record.localPath !== uriRes.uri) {
          await setChapterAudioPath(chapterId, uriRes.uri, record?.sizeBytes ?? 0);
        }
        MobileAudioStorage.statCache.set(chapterId, { ok: true, ts: Date.now() });
        return uriRes.uri;
      }
    } catch {
      // continue to legacy fallback
    }

    try {
      const legacyPath = this.buildLegacyPath(chapterId);
      const legacyStat = await Filesystem.stat({
        path: legacyPath,
        directory: Directory.Data,
      });
      const legacyUri = await Filesystem.getUri({ path: legacyPath, directory: Directory.Data });
      if (legacyUri?.uri) {
        await setChapterAudioPath(chapterId, legacyUri.uri, typeof legacyStat?.size === "number" ? legacyStat.size : 0);
        MobileAudioStorage.statCache.set(chapterId, { ok: true, ts: Date.now() });
        return legacyUri.uri;
      }
    } catch {
      // ignore
    }
    MobileAudioStorage.statCache.set(chapterId, { ok: false, ts: Date.now() });
    return null;
  }

  async deleteAudio(chapterId: string): Promise<void> {
    try {
      await Filesystem.deleteFile({
        path: this.buildPath(chapterId),
        directory: Directory.Data,
      });
    } catch {
      // ignore missing file
    }
    await deleteChapterAudioPath(chapterId);
    MobileAudioStorage.statCache.delete(chapterId);
  }
}

const desktopStorage = new DesktopAudioStorage();
const mobileStorage = new MobileAudioStorage();

export function getAudioStorage(uiMode: UiMode): AudioStorage {
  return computeMobileMode(uiMode) ? mobileStorage : desktopStorage;
}

export async function persistChapterAudio(chapterId: string, data: AudioChunk, uiMode: UiMode): Promise<string | null> {
  if (!computeMobileMode(uiMode)) return null;
  const storage = getAudioStorage(uiMode);
  return storage.saveAudio(chapterId, data);
}

export async function resolveChapterAudioUrl(chapterId: string, uiMode: UiMode): Promise<string | null> {
  if (!computeMobileMode(uiMode)) return null;
  const storage = getAudioStorage(uiMode);
  const localPath = await storage.getAudioPath(chapterId);
  if (!localPath) return null;
  return Capacitor.convertFileSrc(localPath);
}

export async function resolveChapterAudioLocalPath(chapterId: string): Promise<string | null> {
  if (!Capacitor.isNativePlatform?.()) return null;
  return mobileStorage.getAudioPath(chapterId);
}
