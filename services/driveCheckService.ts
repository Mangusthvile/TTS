
import { Chapter, ScanResult, StrayFile, AudioStatus } from '../types';
import { listFilesInFolder, buildMp3Name, buildTextName, inferChapterIndex, isPlausibleChapterFile, ensureRootStructure, runLibraryMigration } from './driveService';
import { getValidDriveToken, isTokenValid } from './driveAuth';

export interface DriveCheckReport {
  success: boolean;
  message: string;
  scan?: ScanResult;
  migratedCount?: number;
}

export async function ensureDriveAuthOrThrow() {
  if (!isTokenValid()) {
    throw { code: "AUTH_REQUIRED", message: "Google Drive sign-in required" };
  }
  try {
    await getValidDriveToken({ interactive: false });
  } catch (e) {
    throw { code: "AUTH_REQUIRED", message: "Session expired. Please sign in again." };
  }
}

export async function runBookDriveCheck(
  bookFolderId: string,
  chapters: Chapter[]
): Promise<DriveCheckReport> {
  await ensureDriveAuthOrThrow();

  const driveFiles = await listFilesInFolder(bookFolderId);
  const matchedFileIds = new Set<string>();
  const updatedChapters: Chapter[] = [];
  
  const scan: ScanResult = { 
    missingTextIds: [], 
    missingAudioIds: [], 
    strayFiles: [], 
    duplicates: [], 
    totalChecked: chapters.length,
    updatedChapters: []
  };

  const getFileById = (id?: string) => id ? driveFiles.find(f => f.id === id) : undefined;
  const getFileByName = (name?: string) => name ? driveFiles.find(f => f.name === name) : undefined;

  // Heuristic matcher
  const findHeuristicMatch = (index: number, exts: string[]) => {
     return driveFiles.find(f => {
        if (matchedFileIds.has(f.id)) return false;
        const fExt = f.name.split('.').pop()?.toLowerCase();
        if (!exts.includes(fExt || '')) return false;
        const inferred = inferChapterIndex(f.name);
        return inferred === index;
     });
  };

  for (const chapter of chapters) {
    let textFile = undefined;
    let audioFile = undefined;
    let needsUpdate = false;
    let updatedChapter = { ...chapter };

    // --- TEXT MATCHING STRATEGY ---
    // 1. By ID
    if (chapter.cloudTextFileId) {
      textFile = getFileById(chapter.cloudTextFileId);
    }
    // 2. By Name (Stored or Constructed)
    if (!textFile) {
      const targetName = chapter.textFileName || buildTextName(chapter.index, chapter.title);
      textFile = getFileByName(targetName);
    }
    // 3. By Heuristic
    if (!textFile) {
      textFile = findHeuristicMatch(chapter.index, ['txt', 'md']);
    }

    if (textFile) {
      matchedFileIds.add(textFile.id);
      if (updatedChapter.cloudTextFileId !== textFile.id || updatedChapter.textFileName !== textFile.name || !updatedChapter.hasTextOnDrive) {
         updatedChapter.cloudTextFileId = textFile.id;
         updatedChapter.textFileName = textFile.name;
         updatedChapter.hasTextOnDrive = true;
         needsUpdate = true;
      }
    } else {
      scan.missingTextIds.push(chapter.id);
      if (updatedChapter.hasTextOnDrive) {
         updatedChapter.hasTextOnDrive = false;
         needsUpdate = true;
      }
    }

    // --- AUDIO MATCHING STRATEGY ---
    // 1. By ID
    if (chapter.cloudAudioFileId) {
      audioFile = getFileById(chapter.cloudAudioFileId);
    }
    // 2. By Name
    if (!audioFile) {
      const targetName = chapter.audioFileName || buildMp3Name(chapter.index, chapter.title);
      audioFile = getFileByName(targetName);
    }
    // 3. By Heuristic
    if (!audioFile) {
      audioFile = findHeuristicMatch(chapter.index, ['mp3', 'wav', 'm4a']);
    }

    if (audioFile) {
      matchedFileIds.add(audioFile.id);
      if (updatedChapter.cloudAudioFileId !== audioFile.id || updatedChapter.audioFileName !== audioFile.name || updatedChapter.audioStatus !== AudioStatus.READY) {
         updatedChapter.cloudAudioFileId = audioFile.id;
         updatedChapter.audioFileName = audioFile.name;
         updatedChapter.audioStatus = AudioStatus.READY;
         needsUpdate = true;
      }
    } else {
      scan.missingAudioIds.push(chapter.id);
      // Don't reset audioStatus to pending if it was generating, but if it claimed READY and is missing, strictly it's gone.
      // However, to avoid UI flicker during transient checks, we only update if we found something positive or explicitly missing text.
    }

    if (needsUpdate) updatedChapters.push(updatedChapter);
  }

  // Identify Strays
  for (const f of driveFiles) {
    if (matchedFileIds.has(f.id) || f.mimeType === 'application/vnd.google-apps.folder') continue;
    
    const lower = f.name.toLowerCase();
    if (lower.includes('cover') || lower.includes('manifest') || lower.endsWith('.json') || lower.endsWith('.jpg') || lower.endsWith('.png')) continue;

    // IMPORTANT: If it looks like a chapter file but wasn't matched (e.g. extra chapter not in index),
    // we still list it as stray but UI might want to warn differently. For now, standard stray.
    
    scan.strayFiles.push(f as StrayFile);
  }

  scan.updatedChapters = updatedChapters;

  return {
    success: true,
    message: `Scan complete. Found ${scan.strayFiles.length} strays, ${scan.missingAudioIds.length} missing audio.`,
    scan
  };
}

export async function runFullDriveCheck(rootId: string): Promise<DriveCheckReport> {
    await ensureDriveAuthOrThrow();
    await ensureRootStructure(rootId);
    const migrationResult = await runLibraryMigration(rootId);
    return {
        success: true,
        message: migrationResult.message,
        migratedCount: migrationResult.movedCount
    };
}
