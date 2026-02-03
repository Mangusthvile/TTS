export type SyncPlanInput = {
  chapterIds: string[];
  existingRows: Record<string, boolean>;
  existingFiles: Record<string, boolean>;
};

export type SyncPlan = {
  missingRows: string[];
  missingFiles: string[];
};

export function planNativeTextSync(input: SyncPlanInput): SyncPlan {
  const missingRows: string[] = [];
  const missingFiles: string[] = [];
  for (const chapterId of input.chapterIds) {
    if (!input.existingRows[chapterId]) {
      missingRows.push(chapterId);
      continue;
    }
    if (!input.existingFiles[chapterId]) {
      missingFiles.push(chapterId);
    }
  }
  return { missingRows, missingFiles };
}
