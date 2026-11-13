import test from 'node:test';
import assert from 'node:assert/strict';
import {useBrowserBookmarks} from '../src/composables/useBrowserBookmarks';

function installMockLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
  };
  return store;
}

test('useBrowserBookmarks 支持收藏、取消、持久化重载与移除', () => {
  const store = installMockLocalStorage();
  const api = useBrowserBookmarks();
  api.reloadBookmarks();
  assert.deepEqual(api.bookmarks.value, []);

  // 1. 添加收藏
  const added = api.toggleBookmark({ url: 'https://www.google.com/', title: 'Google' });
  assert.equal(added, true);
  assert.equal(api.isBookmarked('https://www.google.com/'), true);
  assert.equal(api.bookmarks.value.length, 1);

  // 2. 持久化到 localStorage 并重载恢复
  const raw = store.get('lingxi-browser-bookmarks');
  assert.ok(raw && raw.includes('https://www.google.com/'));
  api.bookmarks.value = [];
  api.reloadBookmarks();
  assert.equal(api.bookmarks.value.length, 1);
  assert.equal(api.bookmarks.value[0]?.title, 'Google');

  // 3. 再次 toggle 取消收藏
  const removed = api.toggleBookmark({ url: 'https://www.google.com/' });
  assert.equal(removed, false);
  assert.equal(api.isBookmarked('https://www.google.com/'), false);
  assert.equal(api.bookmarks.value.length, 0);

  // 4. 空标题回退 host + removeBookmark
  api.toggleBookmark({ url: 'http://localhost:5173/app' });
  assert.equal(api.bookmarks.value[0]?.title, 'localhost:5173');
  api.removeBookmark('http://localhost:5173/app');
  assert.equal(api.bookmarks.value.length, 0);
});
