import { sharedImageReferences, mediaType } from './bundle-contract.js';

const states = new WeakMap();
const pending = new Map();
const releaseLater = url => {
  if (url?.startsWith('blob:')) setTimeout(() => {
    // A held drag can keep a snapshot alive longer than the animation duration.
    // Its removal is observed too, and schedules the final release of this URL.
    if (![...document.querySelectorAll('img')].some(image => image.src === url)) URL.revokeObjectURL(url);
  }, 2000);
};

export async function hydrateSvg(svg, baseUrl, { fetcher = fetch, images } = {}) {
  const paths = sharedImageReferences(svg, images);
  const values = new Map(await Promise.all(paths.map(async path => {
    const url = new URL(path, baseUrl).href;
    // Coalesce concurrent page/panel loads; retain no raster copies after hydration.
    if (!pending.has(url)) pending.set(url, (async () => {
      const response = await fetcher(url);
      if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== mediaType(path)) throw new Error('Imagem indisponível: ' + path);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
      if (hash !== path.slice(7, 71)) throw new Error('Hash de imagem inválido: ' + path);
      if (path.endsWith('.png') ? ![137,80,78,71,13,10,26,10].every((v,i) => bytes[i] === v) :
        bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) throw new Error('Imagem inválida: ' + path);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
      return 'data:' + mediaType(path) + ';base64,' + btoa(binary);
    })());
    const request = pending.get(url);
    try { return [path, await request]; }
    finally { if (pending.get(url) === request) pending.delete(url); }
  })));
  return svg.replace(/\b(href|xlink:href)(\s*=\s*)(["'])(.*?)\3/g,
    (match, attr, equals, quote, value) => values.has(value) ? attr + equals + quote + values.get(value) + quote : match);
}

async function sourceUrl(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Arte indisponível.');
  const text = await response.text();
  if (!/\b(?:href|xlink:href)\s*=\s*["']images\//.test(text)) return url;
  const target = new URL(url);
  const root = /^(.*\/sha256-[a-f0-9]{64}\/)/.exec(target.pathname);
  if (!root) throw new Error('Arte fora da release.');
  const base = new URL(root[1], target.origin).href;
  const hydrated = await hydrateSvg(text, base);
  return URL.createObjectURL(new Blob([hydrated], { type: 'image/svg+xml' }));
}

export function setSharedImage(image, url) {
  const old = states.get(image);
  if (old?.url === url) return old.ready;
  const state = { url, source: null, ready: null };
  states.set(image, state);
  state.ready = sourceUrl(url).then(source => {
    if (states.get(image) !== state) { releaseLater(source); return; }
    state.source = source;
    image.src = source;
    releaseLater(old?.source);
  });
  // Keep decodeArt rejection observable and show the existing image-error UI.
  state.ready.catch(() => { if (states.get(image) === state) image.dispatchEvent(new Event('error')); });
  return state.ready;
}

export async function decodeSharedImage(image) {
  await states.get(image)?.ready;
  await image.decode();
}

export function releaseSharedImage(image) {
  const state = states.get(image);
  states.delete(image);
  releaseLater(state?.source ?? image.src);
}

// Detached page/gesture/library DOM releases temporary expanded SVGs. A grace
// period covers page-turn snapshots; none of these blobs enter persistent cache.
export function observeSharedImages(root) {
  const observer = new MutationObserver(records => {
    for (const record of records) for (const node of record.removedNodes) {
      if (node.isConnected) continue;
      if (node.tagName === 'IMG') releaseSharedImage(node);
      node.querySelectorAll?.('img').forEach(image => { if (!image.isConnected) releaseSharedImage(image); });
    }
  });
  observer.observe(root, { childList: true, subtree: true });
  return observer;
}
