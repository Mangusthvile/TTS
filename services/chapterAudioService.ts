import { AudioStatus, Book, Chapter, Rule, StorageBackend, UiMode } from "../types";
import { applyRules } from "./speechService";
import { reflowLineBreaks } from "./textFormat";
import { markdownToPlainText } from "../utils/markdownToText";
import { stripChapterTemplateHeader } from "../utils/stripChapterTemplateHeader";
import { synthesizeChunk } from "./cloudTtsService";
import { generateAudioKey, saveAudioToCache } from "./audioCache";
import { persistChapterAudio } from "./audioStorage";
import { buildMp3Name, uploadToDrive } from "./driveService";
import { upsertChapterMeta as libraryUpsertChapterMeta, loadChapterText as libraryLoadChapterText } from "./libraryStore";

type GenerateAndPersistChapterAudioArgs = {
  book: Book;
  chapter: Chapter;
  voiceId: string;
  playbackSpeed: number;
  rules: Rule[];
  reflowLineBreaksEnabled: boolean;
  uiMode: UiMode;
  isAuthorized: boolean;
  uploadToCloud?: boolean;
  loadChapterText?: (bookId: string, chapterId: string) => Promise<string | null>;
  onChapterUpdated?: (chapter: Chapter) => void | Promise<void>;
};

function sanitizeSpeechSource(chapter: Chapter, rawText: string): string {
  const stripped = stripChapterTemplateHeader(rawText || "");
  const isMarkdown =
    chapter.contentFormat === "markdown" || (chapter.filename || "").toLowerCase().endsWith(".md");
  return isMarkdown ? markdownToPlainText(stripped) : stripped;
}

async function publishChapterUpdate(
  bookId: string,
  chapter: Chapter,
  onChapterUpdated?: (chapter: Chapter) => void | Promise<void>
): Promise<void> {
  if (onChapterUpdated) await onChapterUpdated(chapter);
  await libraryUpsertChapterMeta(bookId, { ...chapter, content: undefined });
}

export async function generateAndPersistChapterAudio(
  args: GenerateAndPersistChapterAudioArgs
): Promise<Chapter> {
  const {
    book,
    chapter,
    voiceId,
    playbackSpeed,
    rules,
    reflowLineBreaksEnabled,
    uiMode,
    isAuthorized,
    uploadToCloud = true,
  } = args;

  const loadText =
    args.loadChapterText ??
    (async (bookId: string, chapterId: string) => {
      return libraryLoadChapterText(bookId, chapterId);
    });

  const sourceText =
    (typeof chapter.content === "string" && chapter.content.length > 0 ? chapter.content : null) ??
    (await loadText(book.id, chapter.id)) ??
    "";
  if (!sourceText.trim()) {
    const failedChapter: Chapter = {
      ...chapter,
      audioStatus: AudioStatus.FAILED,
      updatedAt: Date.now(),
    };
    await publishChapterUpdate(book.id, failedChapter, args.onChapterUpdated);
    throw new Error("No chapter text found.");
  }

  const speechInput = sanitizeSpeechSource(chapter, sourceText);
  let textToSpeak = applyRules(speechInput, rules);
  if (reflowLineBreaksEnabled) textToSpeak = reflowLineBreaks(textToSpeak);

  const displayTitle = (chapter.title || "").trim() || `Chapter ${chapter.index}`;
  const introText = applyRules(`Chapter ${chapter.index}. ${displayTitle}. `, rules);
  const fullText = introText + textToSpeak;

  const cloudRes = await synthesizeChunk(fullText, voiceId, playbackSpeed);
  const mp3Bytes = cloudRes.mp3Bytes instanceof Uint8Array
    ? cloudRes.mp3Bytes
    : new Uint8Array(cloudRes.mp3Bytes as any);
  const mp3Copy = new Uint8Array(mp3Bytes);
  const audioBlob = new Blob([mp3Copy], { type: "audio/mpeg" });
  const audioSignature = generateAudioKey(fullText, voiceId, playbackSpeed);
  await saveAudioToCache(audioSignature, audioBlob);

  await persistChapterAudio(chapter.id, audioBlob, uiMode);

  let cloudAudioFileId = chapter.cloudAudioFileId;
  if (
    uploadToCloud &&
    book.backend === StorageBackend.DRIVE &&
    !!book.driveFolderId &&
    isAuthorized
  ) {
    cloudAudioFileId = await uploadToDrive(
      book.driveFolderId,
      buildMp3Name(book.id, chapter.id),
      audioBlob,
      chapter.cloudAudioFileId,
      "audio/mpeg"
    );
  }

  const updatedChapter: Chapter = {
    ...chapter,
    audioStatus: AudioStatus.READY,
    audioSignature,
    audioPrefixLen: introText.length,
    hasCachedAudio: true,
    cloudAudioFileId: cloudAudioFileId || chapter.cloudAudioFileId,
    updatedAt: Date.now(),
  };
  await publishChapterUpdate(book.id, updatedChapter, args.onChapterUpdated);
  return updatedChapter;
}
