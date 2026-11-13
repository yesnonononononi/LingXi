import {ref} from 'vue';

export interface BrowserBookmark {
  url: string;
  title: string;
  favicon?: string;
  createdAt: number;
}

const STORAGE_KEY = 'lingxi-browser-bookmarks';

function readBookmarks(): BrowserBookmark[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is BrowserBookmark =>
        Boolean(item) && typeof item.url === 'string' && item.url.trim().length > 0
    );
  } catch {
    return [];
  }
}

function writeBookmarks(list: BrowserBookmark[]): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // 忽略存储配额或隐私模式异常
  }
}

function resolveDisplayTitle(url: string, title?: string): string {
  const trimmed = title?.trim();
  if (trimmed) return trimmed;
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

const bookmarks = ref<BrowserBookmark[]>(readBookmarks());

export function useBrowserBookmarks() {
  const isBookmarked = (url: string): boolean => {
    const normalized = url.trim();
    if (!normalized) return false;
    return bookmarks.value.some(item => item.url === normalized);
  };

  const toggleBookmark = (entry: { url: string; title?: string; favicon?: string }): boolean => {
    const url = entry.url.trim();
    if (!url) return false;
    const index = bookmarks.value.findIndex(item => item.url === url);
    if (index >= 0) {
      bookmarks.value = bookmarks.value.filter(item => item.url !== url);
      writeBookmarks(bookmarks.value);
      return false;
    }
    const next: BrowserBookmark = {
      url,
      title: resolveDisplayTitle(url, entry.title),
      favicon: entry.favicon,
      createdAt: Date.now(),
    };
    bookmarks.value = [next, ...bookmarks.value];
    writeBookmarks(bookmarks.value);
    return true;
  };

  const removeBookmark = (url: string): void => {
    bookmarks.value = bookmarks.value.filter(item => item.url !== url);
    writeBookmarks(bookmarks.value);
  };

  const reloadBookmarks = (): void => {
    bookmarks.value = readBookmarks();
  };

  return {
    bookmarks,
    isBookmarked,
    toggleBookmark,
    removeBookmark,
    reloadBookmarks,
  };
}
