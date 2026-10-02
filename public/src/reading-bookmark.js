const key = (slug, version) => `gimbol-reading:${slug}:${version}`;

function valid(bookmark) {
  return bookmark && typeof bookmark.sceneId === 'string' && bookmark.sceneId.length > 0 &&
    Number.isInteger(bookmark.sceneIndexGlobal) && Number.isInteger(bookmark.totalScenes) &&
    bookmark.totalScenes > 0 && bookmark.sceneIndexGlobal >= 0 && bookmark.sceneIndexGlobal < bookmark.totalScenes &&
    typeof bookmark.completed === 'boolean' && typeof bookmark.updatedAt === 'string' &&
    Number.isFinite(Date.parse(bookmark.updatedAt));
}

export function readBookmark(slug, version, storage) {
  try {
    const bookmark = JSON.parse((storage ?? localStorage).getItem(key(slug, version)));
    return valid(bookmark) ? bookmark : null;
  } catch { return null; }
}

export function writeBookmark(slug, version, bookmark, storage) {
  if (!valid(bookmark)) return false;
  try {
    const previous = readBookmark(slug, version, storage);
    if (previous?.sceneId === bookmark.sceneId && previous.sceneIndexGlobal === bookmark.sceneIndexGlobal &&
        previous.totalScenes === bookmark.totalScenes && previous.completed === bookmark.completed) return true;
    (storage ?? localStorage).setItem(key(slug, version), JSON.stringify(bookmark));
    return true;
  } catch { return false; }
}

export function removeBookmark(slug, version, storage) {
  try { (storage ?? localStorage).removeItem(key(slug, version)); } catch { /* Retomada opcional. */ }
}

export function bookmarkPercent(bookmark) {
  return valid(bookmark) ? Math.round(100 * (bookmark.sceneIndexGlobal + 1) / bookmark.totalScenes) : 0;
}

export function resumeIndex(bookmark, scenes) {
  if (!valid(bookmark) || bookmark.completed || bookmark.totalScenes !== scenes.length) return 0;
  return scenes[bookmark.sceneIndexGlobal]?.id === bookmark.sceneId ? bookmark.sceneIndexGlobal : 0;
}
