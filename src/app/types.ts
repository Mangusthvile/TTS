export type RouteContext = {
  bookId?: string;
  chapterId?: string;
  chapterIndex?: number;
  scrollTop?: number;
  collectionScrollTop?: number;
  lastViewType?: 'library' | 'collection' | 'reader' | 'rules' | 'settings';
  lastNonReaderViewType?: 'library' | 'collection' | 'rules' | 'settings';
  updatedAt?: number;
};
