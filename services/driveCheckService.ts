
import { Chapter, ScanResult, StrayFile } from '../types';
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
  // Try to get token (interactive: false to just check validity/refresh)
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
  
  const scan: ScanResult = { 
    missingTextIds: [], 
    missingAudioIds: [], 
    strayFiles: [], 
    duplicates: [], 
    totalChecked: chapters.length 
  };

  const findFileForChapter = (index: number, type: 'text' | 'audio') => {
     const exts = type === 'text' ? ['txt', 'md'] : ['mp3', 'wav', 'm4a'];
     return driveFiles.find(f => {
        if (matchedFileIds.has(f.id)) return false;
        const fExt = f.name.split('.').pop()?.toLowerCase();
        if (!exts.includes(fExt || '')) return false;
        const inferred = inferChapterIndex(f.name);
        return inferred === index;
     });
  };

  for (const chapter of chapters) {
    const expectedTextName = buildTextName(chapter.index, chapter.title);
    const expectedAudioName = buildMp3Name(chapter.index, chapter.title);
    
    let textFile = driveFiles.find(f => f.name === expectedTextName);
    let audioFile = driveFiles.find(f => f.name === expectedAudioName);

    if (!textFile) textFile = findFileForChapter(chapter.index, 'text');
    if (!audioFile) audioFile = findFileForChapter(chapter.index, 'audio');

    if (textFile) matchedFileIds.add(textFile.id);
    if (audioFile) matchedFileIds.add(audioFile.id);

    if (!textFile) scan.missingTextIds.push(chapter.id);
    if (!audioFile) scan.missingAudioIds.push(chapter.id);
  }

  for (const f of driveFiles) {
    if (matchedFileIds.has(f.id) || f.mimeType === 'application/vnd.google-apps.folder') continue;
    
    const lower = f.name.toLowerCase();
    if (lower.includes('cover') || lower.includes('manifest') || lower.endsWith('.json') || lower.endsWith('.jpg') || lower.endsWith('.png')) continue;

    if (isPlausibleChapterFile(f.name)) {
        continue;
    }

    scan.strayFiles.push(f as StrayFile);
  }

  return {
    success: true,
    message: `Scan complete. Found ${scan.strayFiles.length} strays, ${scan.missingAudioIds.length} missing audio.`,
    scan
  };
}

export async function runFullDriveCheck(rootId: string): Promise<DriveCheckReport> {
    await ensureDriveAuthOrThrow();
    
    // 1. Ensure Structure
    await ensureRootStructure(rootId);

    // 2. Run Migration Logic
    const migrationResult = await runLibraryMigration(rootId);

    return {
        success: true,
        message: migrationResult.message,
        migratedCount: migrationResult.movedCount
    };
}
