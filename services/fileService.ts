
import { Chapter } from '../types';

export async function saveChapterToFile(bookHandle: FileSystemDirectoryHandle, chapter: Chapter) {
  try {
    const fileHandle = await bookHandle.getFileHandle(chapter.filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(chapter.content);
    await writable.close();
    
    // Update manifest
    await updateManifest(bookHandle, chapter);
  } catch (err) {
    console.error('Failed to save file:', err);
  }
}

async function updateManifest(bookHandle: FileSystemDirectoryHandle, newChapter: Chapter) {
  try {
    let manifest: any = { chapters: [] };
    try {
      const manifestHandle = await bookHandle.getFileHandle('manifest.json', { create: true });
      const file = await manifestHandle.getFile();
      const text = await file.text();
      if (text) manifest = JSON.parse(text);
    } catch (e) {
      // Manifest might not exist yet
    }

    // Replace or add
    const existingIndex = manifest.chapters.findIndex((c: any) => c.filename === newChapter.filename);
    const entry = {
      index: newChapter.index,
      title: newChapter.title,
      source_url: newChapter.sourceUrl,
      filename: newChapter.filename,
      word_count: newChapter.wordCount
    };

    if (existingIndex > -1) {
      manifest.chapters[existingIndex] = entry;
    } else {
      manifest.chapters.push(entry);
    }
    
    // Sort by index to maintain reader order
    manifest.chapters.sort((a: any, b: any) => a.index - b.index);

    const manifestHandle = await bookHandle.getFileHandle('manifest.json', { create: true });
    const writable = await manifestHandle.createWritable();
    await writable.write(JSON.stringify(manifest, null, 2));
    await writable.close();
  } catch (err) {
    console.error('Failed to update manifest:', err);
  }
}
