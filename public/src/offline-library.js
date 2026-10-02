import { referencedPaths, validateVisuals, validateImageReferences, sharedImageReferences } from './bundle-contract.js';

import { prepareBundle } from './reader.js';

const DB_NAME = 'gimbol-offline-v1';
const VERSION = /^sha256-[a-f0-9]{64}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function safeRelative(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_./-]+$/.test(value) &&
    !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..');
}

export function validateCatalog(data) {
  if (data?.schemaVersion !== '1.0' || !Array.isArray(data.stories)) throw new Error('Catálogo incompatível.');
  const seen = new Set();
  for (const story of data.stories) {
    if (!SLUG.test(story.slug) || seen.has(story.slug) || !safeRelative(story.bundle) || !safeRelative(story.cover) ||
      typeof story.title !== 'string' || typeof story.ageRange !== 'string' ||
      !new RegExp(`^${story.slug}/sha256-[a-f0-9]{64}/bundle\\.json$`).test(story.bundle) ||
      !story.cover.startsWith(story.bundle.slice(0, -'bundle.json'.length))) throw new Error('Entrada de catálogo inválida.');
    seen.add(story.slug);
  }
  return data;
}

export function storyCacheName(slug, version) {
  if (!SLUG.test(slug) || !VERSION.test(version)) throw new Error('Identidade inválida.');
  return `gimbol-story-${slug}-${version}`;
}

export function assetUrls(bundle, bundleUrl) {
  prepareBundle(bundle);
  const paths = referencedPaths(bundle);
  if (paths.some(path => !safeRelative(path))) throw new Error('Asset inválido.');
  return [...new Set(paths)].map(path => new URL(path, bundleUrl).href);
}

export function libraryCoverUrl(entry, catalogUrl, saved, offline = false) {
  if (offline && saved) return saved.coverUrl ?? saved.assetUrls[0];
  return new URL(entry.cover, catalogUrl).href;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function openLibraryDb() {
  const request = indexedDB.open(DB_NAME, 1);
  request.onupgradeneeded = () => {
    const db = request.result;
    db.createObjectStore('saved', { keyPath: ['slug', 'version'] });
    db.createObjectStore('metadata');
  };
  return requestResult(request);
}

export async function listSaved(db) {
  return requestResult(db.transaction('saved').objectStore('saved').getAll());
}

export async function saveCatalog(db, catalog) {
  const tx = db.transaction('metadata', 'readwrite');
  tx.objectStore('metadata').put({ ...catalog, fetchedAt: new Date().toISOString() }, 'catalog');
  await transactionDone(tx);
}

export async function getCatalog(db) {
  return requestResult(db.transaction('metadata').objectStore('metadata').get('catalog'));
}

export async function saveStory(db, record) {
  const tx = db.transaction('saved', 'readwrite');
  tx.objectStore('saved').put(record);
  await transactionDone(tx);
}

// Partial records never enter the saved/offline library. Only verified pages are exposed.
export async function savePartial(db, record) {
  if (!db) return;
  const tx = db.transaction('metadata', 'readwrite');
  const key = `partial:${record.slug}/${record.version}`;
  if (record.assetUrls.length) tx.objectStore('metadata').put(record, key);
  else tx.objectStore('metadata').delete(key);
  await transactionDone(tx);
}

export function pagePaths(bundle, page) {
  const scenes = prepareBundle(bundle).filter(scene => scene.pageNumber === page.number);
  return [...new Set([page.preview, ...scenes.flatMap(scene => [scene.panel,
    ...scene.balloons.flatMap(balloon => [balloon.audio.path, balloon.visual?.normal, balloon.visual?.glow]),
    ...(scene.focused ? [scene.focused.panel, ...scene.focused.balloons.flatMap(balloon => [balloon.visual.normal, balloon.visual.glow])] : []),
    ...bundle.tracks.filter(track => track.id === scene.trackId).map(track => track.path)])].filter(Boolean))];
}

async function readBody(response, onChunk, limit = Infinity) {
  const chunks = []; let length = 0;
  const reader = response.body?.getReader();
  if (!reader) { const bytes = await response.arrayBuffer(); onChunk(bytes.byteLength); return bytes; }
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error('Recurso excede o tamanho declarado.');
      chunks.push(value); onChunk(value.byteLength);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes.buffer;
}

export async function removeStory(db, record, cacheStorage = caches) {
  const tx = db.transaction('saved', 'readwrite');
  tx.objectStore('saved').delete([record.slug, record.version]);
  await transactionDone(tx);
  await cacheStorage.delete(storyCacheName(record.slug, record.version));
}

const savedManifests = new WeakMap();

// Reopen only a committed release. Check the manifest and cache inventory without
// reading every media body; the full byte audit remains separate from opening.
export async function readSavedBundle(record, cacheStorage = caches) {
  try {
    if (!record || !Array.isArray(record.assetUrls) || !Number.isFinite(Date.parse(record.completedAt))) return null;
    const name = storyCacheName(record.slug, record.version);
    if (!await cacheStorage.has(name)) return null;
    const cache = await cacheStorage.open(name);
    const manifest = await cache.match(record.bundleUrl);
    if (!manifest?.ok || manifest.type === 'opaque') return null;
    const text = await manifest.text();
    let parsed = savedManifests.get(record);
    if (!parsed || parsed.text !== text || parsed.bundleUrl !== record.bundleUrl) {
      const bundle = JSON.parse(text);
      const urls = assetUrls(bundle, record.bundleUrl);
      if (bundle.schemaVersion !== '1.0' && await deliveryVersion(bundle) !== bundle.version) return null;
      parsed = { text, bundle, urls, bundleUrl: record.bundleUrl };
      savedManifests.set(record, parsed);
    }
    const { bundle, urls } = parsed;
    if (bundle.slug !== record.slug || bundle.version !== record.version) return null;
    const declared = new Set(record.assetUrls);
    if (urls.length !== declared.size || urls.length !== record.assetUrls.length || urls.some(url => !declared.has(url))) return null;
    const present = new Set((await cache.keys()).map(request => request.url));
    if (urls.some(url => !present.has(url))) return null;
    return bundle;
  } catch { return null; }
}

export async function isComplete(record, cacheStorage = caches) {
  if (!record || !Array.isArray(record.assetUrls)) return false;
  if (!(await cacheStorage.has(storyCacheName(record.slug, record.version)))) return false;
  const cache = await cacheStorage.open(storyCacheName(record.slug, record.version));
  try {
    const manifest = await cache.match(record.bundleUrl);
    if (!manifest?.ok) return false;
    const bundle = await manifest.json();
    const urls = assetUrls(bundle, record.bundleUrl);
    if (urls.length !== record.assetUrls.length || urls.some(url => !record.assetUrls.includes(url))) return false;
    const visuals = new Map();
    for (const url of urls) {
      const response = await cache.match(url);
      if (!response?.ok) return false;
      if (['2.0', '3.0', '4.0'].includes(bundle.schemaVersion)) {
        const asset = bundle.assets.find(item => new URL(item.path, record.bundleUrl).href === url);
        const bytes = await response.arrayBuffer();
        await verifyAsset(response, url, bytes, asset);
        if (/^(paginas|quadrinhos|baloes)\//.test(asset.path)) visuals.set(asset.path, new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      }
    }
    if (['2.0', '3.0', '4.0'].includes(bundle.schemaVersion)) {
      for (const scene of bundle.pages.flatMap(page => page.scenes)) validateVisuals(scene, name => visuals.get(name));
      validateImageReferences(bundle, name => visuals.get(name));
      if (await deliveryVersion(bundle) !== bundle.version) return false;
    }
  } catch { return false; }
  return true;
}

function expectedType(url) {
  const path = new URL(url).pathname;
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.jpeg')) return 'image/jpeg';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  if (path.endsWith('.wav')) return 'audio/';
  if (path.endsWith('.mp3')) return 'audio/';
  return 'application/json';
}

function checkResponse(response, url) {
  if (!response.ok || response.type === 'opaque') throw new Error(`Recurso indisponível: ${url}`);
  const type = response.headers.get('content-type')?.split(';')[0].trim() ?? '';
  if (!type.startsWith(expectedType(url))) throw new Error(`Tipo de recurso inválido: ${url}`);
}

const downloads = new Map();
export async function downloadStory(options) {
  let lastProgress;
  const tracked = { ...options, onProgress: event => { lastProgress = event; options.onProgress?.(event); } };
  const key = new URL(options.entry.bundle, options.catalogUrl).href;
  const previous = downloads.get(key) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(() => {
    if (options.signal?.aborted) throw options.signal.reason;
    return globalThis.navigator?.locks
      ? navigator.locks.request(`gimbol-download:${key}`, { signal: options.signal }, () => transferStory(tracked))
      : transferStory(tracked);
  });
  downloads.set(key, run);
  try { return await run; }
  catch (error) {
    if (lastProgress && !['error', 'cancelled'].includes(lastProgress.phase)) options.onProgress?.({ ...lastProgress,
      phase: options.signal?.aborted ? 'cancelled' : 'error', errorCode: error.name });
    throw error;
  }
  finally { if (downloads.get(key) === run) downloads.delete(key); }
}

async function transferStory({ entry, catalogUrl, db, fetcher = fetch, cacheStorage = caches,
  onProgress = () => {}, onReadable = null, onPageReady = () => {}, initialPages = 6,
  partialIndex = savePartial, signal, storage = globalThis.navigator?.storage,
  index = { listSaved, saveStory, removeStory } }) {
  const attemptId = crypto.randomUUID();
  let completed = 0, total = null, unit = 'resources';
  let readyPages = 0, published = false, committed = false, version;
  const emit = (phase, errorCode) => onProgress({ attemptId, scope: { kind: 'public' }, slug: entry.slug,
    phase, unit, completed, total, readyPages, errorCode, version,
    percent: phase === 'ready' ? 100 : total ? Math.min(99, Math.floor(completed * 100 / total)) : null });
  emit('preparing');
  const bundleUrl = new URL(entry.bundle, catalogUrl).href;
  const requestedVersion = new URL(bundleUrl).pathname.split('/').at(-2);
  const requestedName = storyCacheName(entry.slug, requestedVersion);
  const cache = await cacheStorage.open(requestedName);
  let response = await cache.match(bundleUrl);
  if (response) {
    try {
      checkResponse(response, bundleUrl);
      const cachedBundle = await response.clone().json();
      prepareBundle(cachedBundle);
      if (cachedBundle.slug !== entry.slug || cachedBundle.version !== requestedVersion ||
          cachedBundle.schemaVersion !== '1.0' && await deliveryVersion(cachedBundle) !== requestedVersion) response = null;
    } catch { response = null; }
  }
  if (!response) response = await fetcher(bundleUrl, { cache: 'no-store', signal });
  checkResponse(response, bundleUrl);
  const manifestBytes = await response.arrayBuffer();
  const bundle = JSON.parse(new TextDecoder().decode(manifestBytes));
  if (!['1.0', '2.0', '3.0', '4.0'].includes(bundle.schemaVersion) || bundle.slug !== entry.slug || !VERSION.test(bundle.version) ||
    !new URL(bundleUrl).pathname.endsWith(`/${entry.slug}/${bundle.version}/bundle.json`)) throw new Error('Bundle incompatível.');
  const urls = assetUrls(bundle, bundleUrl);
  version = bundle.version;
  const record = { slug: bundle.slug, version: bundle.version, bundleUrl,
    coverUrl: new URL(bundle.cover, bundleUrl).href, assetUrls: urls, completedAt: new Date().toISOString() };
  const name = storyCacheName(record.slug, record.version);
  const existing = (await index.listSaved(db)).find(item => item.slug === record.slug && item.version === record.version);
  if (existing && await isComplete(existing, cacheStorage)) { emit('ready'); return { bundle, record: existing }; }
  if (existing) await index.removeStory(db, existing, cacheStorage);
  const declaredSize = manifestBytes.byteLength +
    (['2.0', '3.0', '4.0'].includes(bundle.schemaVersion) ? bundle.assets.reduce((sum, asset) => sum + asset.bytes, 0) : 0);
  // Reopening resumes this immutable release; complete resources survive exit/reload.
  // removeStory may have deleted a broken committed cache, so reopen its handle.
  const targetCache = existing ? await cacheStorage.open(name) : cache;
  const partial = { ...record, assetUrls: [] };
  const modern = bundle.schemaVersion !== '1.0';
  unit = modern ? 'bytes' : 'resources';
  total = modern ? declaredSize : urls.length + 1;
  completed = modern ? manifestBytes.byteLength : 1;
  const assets = new Map((bundle.assets ?? []).map(asset => [asset.path, asset]));
  const downloaded = new Set(); const visuals = new Map();
  const exposed = new Set();
  const abort = () => { if (signal?.aborted) throw signal.reason ?? new DOMException('Cancelado', 'AbortError'); };
  for (const url of urls) {
    abort();
    const cached = await targetCache.match(url);
    if (!cached) continue;
    const path = url.slice(new URL('.', bundleUrl).href.length);
    try {
      checkResponse(cached, url);
      const bytes = await cached.arrayBuffer();
      if (!bytes.byteLength) throw new Error('Recurso vazio.');
      if (modern) await verifyAsset(cached, url, bytes, assets.get(path));
      if (modern && path.endsWith('.svg')) visuals.set(path, new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      downloaded.add(path);
      completed += modern ? bytes.byteLength : 1;
      emit('preparing');
    } catch { /* Missing/corrupt resources are replaced below, never counted as reusable. */ }
  }
  const missingSize = modern ? bundle.assets.filter(asset => !downloaded.has(asset.path)).reduce((sum, asset) => sum + asset.bytes, 0) : manifestBytes.byteLength;
  const estimate = await storage?.estimate?.().catch(() => null);
  if (estimate?.quota && estimate.quota - (estimate.usage ?? 0) < missingSize * 1.05) {
    const error = new Error('Espaço insuficiente.'); error.name = 'QuotaExceededError'; throw error;
  }
  const dependencies = path => modern && path.endsWith('.svg') && ['3.0', '4.0'].includes(bundle.schemaVersion)
    ? sharedImageReferences(visuals.get(path), bundle.images) : [];
  const expose = path => { exposed.add(path); for (const dependency of dependencies(path)) expose(dependency); };
  const completePath = path => downloaded.has(path) && dependencies(path).every(completePath);
  const publishPages = async () => {
    if (!onReadable || !readyPages) return;
    partial.assetUrls = [...exposed].map(path => new URL(path, bundleUrl).href);
    await partialIndex(db, { ...partial, readyPages });
    abort();
    await onPageReady(readyPages);
    if (!published && readyPages >= Math.min(initialPages, bundle.pages.length)) {
      published = true;
      await onReadable({ bundle, record, readyPages });
    }
  };
  const download = async path => {
    abort();
    if (downloaded.has(path)) { for (const dependency of dependencies(path)) await download(dependency); return; }
    const url = new URL(path, bundleUrl).href;
    response = await fetcher(url, { cache: 'no-store', signal });
    checkResponse(response, url);
    const asset = assets.get(path);
    const bytes = await readBody(response, count => { if (modern) { completed += count; emit('downloading'); } }, modern ? asset.bytes : Infinity);
    abort();
    if (modern) await verifyAsset(response, url, bytes, asset);
    if (!bytes.byteLength) throw new Error(`Recurso vazio: ${url}`);
    await targetCache.put(url, new Response(bytes, { headers: response.headers }));
    downloaded.add(path);
    if (!modern) completed++;
    emit('downloading');
    if (path.endsWith('.svg') && modern) {
      const svg = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      visuals.set(path, svg);
      if (['3.0', '4.0'].includes(bundle.schemaVersion)) {
        for (const dependency of sharedImageReferences(svg, bundle.images)) await download(dependency);
      }
    }
  };
  try {
    await targetCache.put(bundleUrl, new Response(manifestBytes, { headers: { 'Content-Type': 'application/json' } }));
    // Restore the whole verified contiguous prefix before requesting anything else.
    for (const page of bundle.pages) {
      const paths = pagePaths(bundle, page);
      if (!paths.every(completePath)) break;
      if (modern) for (const scene of page.scenes) validateVisuals(scene, path => visuals.get(path));
      paths.forEach(expose); readyPages++;
    }
    await publishPages();
    emit('downloading');
    for (const page of bundle.pages.slice(readyPages)) {
      for (const path of pagePaths(bundle, page)) await download(path);
      if (modern) for (const scene of page.scenes) validateVisuals(scene, path => visuals.get(path));
      abort();
      readyPages++;
      pagePaths(bundle, page).forEach(expose);
      await publishPages();
      emit('downloading');
    }
    // Cover and tracks that no page uses are deliberately deferred.
    for (const url of urls) await download(url.slice(new URL('.', bundleUrl).href.length));
    emit('verifying');
    if (!await isComplete(record, cacheStorage)) throw new Error('Download incompleto.');
    abort();
    record.completedAt = new Date().toISOString();
    await index.saveStory(db, record);
    committed = true;
    await partialIndex(db, { ...partial, assetUrls: [] });
    emit('ready');
    return { bundle, record };
  } catch (error) {
    // Pause/failure retains completed resources. Interrupted bodies were never cached.
    emit(signal?.aborted ? 'cancelled' : 'error', error.name);
    throw error;
  }
}

async function digest(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
async function deliveryVersion(bundle) {
  const { version, ...logical } = bundle;
  const hashes = [...bundle.assets].sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return 'sha256-' + await digest(new TextEncoder().encode(canonical(logical) + hashes.map(asset => '\n' + asset.path + '\0' + asset.sha256).join('')));
}
async function verifyAsset(response, url, bytes, asset) {
  const mime = response.headers.get('content-type')?.split(';')[0].trim();
  if (!asset || bytes.byteLength !== asset.bytes || mime !== asset.mime || await digest(bytes) !== asset.sha256) {
    throw new Error('Integridade do asset inválida: ' + url);
  }
}
