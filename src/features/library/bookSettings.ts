import { BookSettings, HighlightMode } from '../../../types';

export const DEFAULT_BOOK_SETTINGS: BookSettings = {
  useBookSettings: false,
  highlightMode: HighlightMode.SENTENCE,
  chapterLayout: 'sections',
  enableSelectionMode: true,
  enableOrganizeMode: true,
  allowDragReorderChapters: true,
  allowDragMoveToVolume: true,
  allowDragReorderVolumes: true,
  volumeOrder: [],
  collapsedVolumes: {},
  autoGenerateAudioOnAdd: true,
  autoUploadOnAdd: false,
  confirmBulkDelete: true,
};

export function normalizeBookSettings(settings?: BookSettings): BookSettings {
  const raw: Partial<BookSettings> = settings ?? {};
  const volumeOrder = Array.isArray(raw.volumeOrder)
    ? raw.volumeOrder
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map((name) => name.trim())
    : [];
  const collapsedVolumes: Record<string, boolean> = {};
  if (raw.collapsedVolumes && typeof raw.collapsedVolumes === 'object') {
    for (const [name, value] of Object.entries(raw.collapsedVolumes)) {
      const trimmed = name.trim();
      if (trimmed && value === true) collapsedVolumes[trimmed] = true;
    }
  }
  return {
    ...DEFAULT_BOOK_SETTINGS,
    ...raw,
    chapterLayout: raw.chapterLayout === 'grid' ? 'grid' : 'sections',
    enableSelectionMode: typeof raw.enableSelectionMode === 'boolean' ? raw.enableSelectionMode : true,
    enableOrganizeMode: typeof raw.enableOrganizeMode === 'boolean' ? raw.enableOrganizeMode : true,
    allowDragReorderChapters:
      typeof raw.allowDragReorderChapters === 'boolean' ? raw.allowDragReorderChapters : true,
    allowDragMoveToVolume:
      typeof raw.allowDragMoveToVolume === 'boolean' ? raw.allowDragMoveToVolume : true,
    allowDragReorderVolumes:
      typeof raw.allowDragReorderVolumes === 'boolean' ? raw.allowDragReorderVolumes : true,
    volumeOrder,
    collapsedVolumes,
    autoGenerateAudioOnAdd:
      typeof raw.autoGenerateAudioOnAdd === 'boolean' ? raw.autoGenerateAudioOnAdd : true,
    autoUploadOnAdd: typeof raw.autoUploadOnAdd === 'boolean' ? raw.autoUploadOnAdd : false,
    confirmBulkDelete: typeof raw.confirmBulkDelete === 'boolean' ? raw.confirmBulkDelete : true,
  };
}
