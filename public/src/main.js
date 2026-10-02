const STANDALONE_BUNDLE = "./library/o-lugar-onde-a-historia-continua/sha256-0a05a7354221bbab25bad9ef506171296f01147d97b527b5434515ddd18e83a3/bundle.json";
const STANDALONE_SLUG = "o-lugar-onde-a-historia-continua";
import { setSharedImage, decodeSharedImage, observeSharedImages } from './shared-images.js';
import { scenePresentation } from './bundle-contract.js';
import { ReaderController } from './reader.js';
import { PageTurn } from './page-turn.js';
import { DragTurn } from './drag-turn.js';
import { FullscreenPresentation } from './fullscreen.js';
import { validateCatalog, openLibraryDb, listSaved, saveCatalog, getCatalog, removeStory,
  isComplete, readSavedBundle, downloadStory, libraryCoverUrl } from './offline-library.js';
import { readBookmark, writeBookmark, removeBookmark, bookmarkPercent, resumeIndex } from './reading-bookmark.js';

observeSharedImages(document.documentElement);

function artwork(image, path, bundle) {
  const url = new URL(path, bundle.assetBase).href;
  if (['3.0', '4.0'].includes(bundle.schemaVersion)) setSharedImage(image, url);
  else image.src = url;
}

const catalogUrl = new URL('./library/catalog.json', document.baseURI);
const $ = selector => document.querySelector(selector);
const el = {
  enterFullscreen: $('#enter-fullscreen'), exitFullscreen: $('#exit-fullscreen'), stage: $('.reader-stage'), dock: $('.reader-dock'),
  library: $('#library-view'), reader: $('#reader-view'), libraryButton: $('#library-button'),
  list: $('#story-list'), libraryStatus: $('#library-status'), retryLibrary: $('#retry-library'),
  continueList: $('#continue-list'), continueSection: $('#continue-section'), allSection: $('#all-stories-section'),
  allTitle: $('#all-stories-title'), offlineFilter: $('#offline-library'), filterHint: $('#offline-filter-hint'),
  title: $('#story-title'), position: $('#position'), pageCounter: $('#page-counter'), sceneCounter: $('#scene-counter'), announcement: $('#announcement'),
  error: $('#reader-error'), downloadStatus: $('#download-status'), retryStory: $('#retry-story'), openSaved: $('#open-saved'),
  downloadLabel: $('#download-label'), downloadProgress: $('#download-progress'), downloadPercent: $('#download-percent'),
  downloadAnnouncement: $('#download-announcement'),
  content: $('#reading-content'), focused: $('#focused-view'),
  panel: $('#panel'), layer: $('#highlight-layer'), pageView: $('#page-view'), artViewport: $('#art-viewport'),
  transcript: $('#transcript'), audioStatus: $('#audio-status'), retryAudio: $('#retry-audio'),
  previous: $('#previous'), next: $('#next'), previousPage: $('#previous-page'), nextPage: $('#next-page'),
  voices: $('#voices'), music: $('#music'), volume: $('#music-volume'), volumeValue: $('#music-volume-value'), auto: $('#auto'), viewMode: $('#view-mode'),
  endCard: $('#end-card'), replay: $('#replay'), endLibrary: $('#end-library')
};

let catalog = null;
let catalogOffline = false;
let db = null;
let savedStories = [];
let savedIntegrity = new Map();
const savedAudits = new Map();
let downloadController = null;
let reader = null;
let requestGeneration = 0;
let renderedPage = null;
let lastAnnouncement = null;
let lastAnnouncedPosition = null;
let onlyDownloaded = false;
let currentDownload = null;

function showDownload(progress) {
  currentDownload = progress;
  el.downloadStatus.hidden = false;
  const waiting = reader?.state.downloadWaiting;
  const label = progress.phase === 'ready' ? 'Disponível offline' : progress.phase === 'verifying' ? 'Conferindo…' :
    progress.phase === 'error' ? (progress.errorCode === 'QuotaExceededError' ? 'Sem espaço. As páginas já baixadas continuam disponíveis.' : 'Download interrompido. As páginas já baixadas continuam disponíveis.') :
    waiting ? 'Baixando a próxima página…' : progress.phase === 'preparing' ? 'Preparando…' :
    progress.unit === 'resources' ? 'Baixando… (preparação da história)' : 'Baixando…';
  // Announce phases/waiting and each 10% step, not every network chunk.
  const step = progress.percent === null ? '' : Math.floor(progress.percent / 10) * 10;
  const announcement = `${label}${step === '' ? '' : ` ${step}%`}`;
  if (el.downloadLabel.textContent !== label) el.downloadLabel.textContent = label;
  if (el.downloadAnnouncement.textContent !== announcement) el.downloadAnnouncement.textContent = announcement;
  if (progress.percent === null) el.downloadProgress.removeAttribute('value');
  else el.downloadProgress.value = progress.percent;
  el.downloadProgress.setAttribute('aria-label', progress.unit === 'bytes' ? 'Download da história' : 'Preparação da história');
  el.downloadPercent.textContent = progress.percent === null ? '' : `${progress.percent}%`;
}

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const sheet = new PageTurn(el.artViewport, { reduced: () => reducedMotion.matches });
const drag = new DragTurn({ getReader: () => reader, sheet, prepare: prepareDrag,
  canResume: () => !document.hidden,
  capture: id => { try { el.artViewport.setPointerCapture(id); } catch { drag.cancel(); } },
  release: id => { if (el.artViewport.hasPointerCapture(id)) el.artViewport.releasePointerCapture(id); },
  onError: () => showReaderError('Arte indisponível. Confira a conexão e tente novamente.') });
let presentationToken = 0;
let skipTurnToken = null;
const presentation = new FullscreenPresentation({ doc: document, onLayout: settleLayout,
  createSurface: () => {
    const target = document.createElement('div'); target.className = 'fullscreen-surface';
    target.setAttribute('role', 'region'); target.setAttribute('aria-label', reader.bundle.title);
    el.stage.before(target); target.append(el.stage);
    return { target, remove: () => target.replaceWith(el.stage) };
  },
  onChange: (phase, target) => {
    const expanded = phase !== 'normal';
    el.reader.classList.toggle('reading-expanded', expanded);
    target?.classList.add('is-expanded');
    if (target) target.dataset.presentation = phase;
    el.exitFullscreen.hidden = !expanded;
    el.dock.inert = expanded;
    $('.reader-chrome').inert = expanded;
    if (expanded) el.exitFullscreen.focus({ preventScroll: true });
    if (phase === 'exit-error') {
      el.exitFullscreen.title = 'O navegador não conseguiu sair. Use Escape ou a saída do sistema e tente novamente.';
      el.announcement.textContent = el.exitFullscreen.title;
    } else el.exitFullscreen.removeAttribute('title');
    fitPageView(); alignFocusedGlow();
  },
  onRestore: () => {
    const target = !el.library.hidden ? $('#library-title') : !el.error.hidden ? el.retryStory :
      !el.endCard.hidden ? el.replay : !el.enterFullscreen.disabled ? el.enterFullscreen : el.libraryButton;
    if (target.tagName === 'H1') target.tabIndex = -1;
    if (!target.hidden) target.focus({ preventScroll: true });
  }
});

function cancelVisual() { presentationToken += 1; sheet.cancel(); }
function finishVisual() { skipTurnToken = presentationToken; sheet.cancel(); }

function captureArt(state = reader.state) {
  const root = state.pageOverviewEnabled ? el.pageView : el.focused;
  return sheet.snapshot(root, image => {
    const id = image.dataset.balloonId;
    const balloon = reader.bundle.pages.flatMap(page => page.scenes).flatMap(scene => scene.balloons ?? []).find(item => item.id === id);
    return balloon?.visual ? new URL(balloon.visual.normal, reader.bundle.assetBase).href : null;
  });
}

async function decodeArt(root) {
  await Promise.all([...root.querySelectorAll('img')].map(image => decodeSharedImage(image)));
}

function presentArt({ from, to, source, progress, prepared }) {
  const token = ++presentationToken;
  const owner = reader;
  const root = to.pageOverviewEnabled ? el.pageView : el.focused;
  const turn = source && from && (to.pageOverviewEnabled ? from.pageIndex !== to.pageIndex : from.sceneIndexGlobal !== to.sceneIndexGlobal);
  const direction = from && to.sceneIndexGlobal < from.sceneIndexGlobal ? -1 : 1;
  let remaining = null;
  try {
    if (turn && !reducedMotion.matches) {
      sheet.begin(source, prepared?.destination ?? source, direction);
      sheet.update(progress);
      if (prepared) remaining = sheet.animate(1);
    }
  }
  catch { sheet.cancel(); }
  return (async () => {
    try {
      await decodeArt(root);
      if (reader === owner && owner.state.pageOverviewEnabled !== to.pageOverviewEnabled)
        await decodeArt(owner.state.pageOverviewEnabled ? el.pageView : el.focused);
    } catch {
      if (token === presentationToken && reader === owner) showReaderError('Arte indisponível. Confira a conexão e tente novamente.');
      return;
    }
    if (token !== presentationToken || reader !== owner) return;
    alignFocusedGlow();
    if (!turn || token === skipTurnToken || reducedMotion.matches || document.hidden) { sheet.cancel(); return; }
    if (prepared) return await remaining;
    try {
      const destination = captureArt(to);
      sheet.begin(source, destination, direction);
      sheet.update(progress);
      return await sheet.animate(1);
    } catch { sheet.cancel(); }
  })();
}

async function prepareDrag(gesture) {
  const { reader: owner, index, overview } = gesture;
  const source = captureArt(owner.state);
  const scene = scenePresentation(owner.scenes[index], overview);
  const root = overview ? createPageView(owner.bundle.pages[scene.pageIndex], owner.bundle) : document.createElement('div');
  if (!overview) {
    root.className = 'panel-frame';
    const panel = document.createElement('img');
    artwork(panel, scene.panel, owner.bundle); panel.alt = ''; root.append(panel);
    if (['2.0', '3.0', '4.0'].includes(owner.bundle.schemaVersion)) {
      const layer = document.createElement('div'); layer.className = 'highlight-layer';
      for (const balloon of scene.balloons) {
        const image = document.createElement('img'); image.className = 'balloon-asset';
        image.src = new URL(balloon.visual.normal, owner.bundle.assetBase).href; image.alt = ''; layer.append(image);
      }
      root.append(layer);
    }
  }
  root.setAttribute('aria-hidden', 'true'); root.inert = true;
  if (overview) { root.style.width = el.pageView.style.width; root.style.height = el.pageView.style.height; }
  const preparation = document.createElement('div'); preparation.className = 'sheet-preparation';
  preparation.append(root); el.artViewport.append(preparation);
  gesture.cleanup = () => preparation.remove();
  try {
    await decodeArt(root);
    if (!overview && ['2.0', '3.0', '4.0'].includes(owner.bundle.schemaVersion)) {
      const image = root.querySelector('img'); const layer = root.querySelector('.highlight-layer');
      const scale = Math.min(root.clientWidth / image.naturalWidth, root.clientHeight / image.naturalHeight);
      Object.assign(layer.style, { inset: 'auto', width: `${image.naturalWidth * scale}px`, height: `${image.naturalHeight * scale}px`,
        left: `${(root.clientWidth - image.naturalWidth * scale) / 2}px`, top: `${(root.clientHeight - image.naturalHeight * scale) / 2}px` });
    }
    return { source, destination: sheet.snapshot(root) };
  } finally { preparation.remove(); }
}

const shellReady = Promise.resolve(false);

function savedFor(slug) { return savedStories.filter(item => item.slug === slug).sort((a, b) => b.completedAt.localeCompare(a.completedAt)); }
function availableFor(slug) { return savedFor(slug).find(item => savedIntegrity.get(`${item.slug}/${item.version}`)); }

async function refreshSaved() {
  savedStories = await listSaved(db);
  savedIntegrity = new Map(await Promise.all(savedStories.map(async item => {
    const key = `${item.slug}/${item.version}`;
    const audit = savedAudits.get(key);
    return [key, Boolean(await readSavedBundle(item)) && !(audit?.completedAt === item.completedAt && audit.valid === false)];
  })));
}

function auditSavedStory(record) {
  const key = `${record.slug}/${record.version}`;
  if (savedAudits.get(key)?.completedAt === record.completedAt) return;
  const audit = { completedAt: record.completedAt, valid: null };
  savedAudits.set(key, audit);
  // Let the current artwork paint before a once-per-session, non-blocking audit.
  setTimeout(async () => {
    const valid = await isComplete(record).catch(() => false);
    if (savedAudits.get(key) !== audit || !savedFor(record.slug).some(item => item.version === record.version && item.completedAt === record.completedAt)) return;
    audit.valid = valid;
    if (valid) return;
    savedIntegrity.set(key, false);
    console.warn('[Gimbol] LOCAL_STORY_AUDIT_FAILED', { slug: record.slug, version: record.version });
    if (reader?.bundle.version === record.version && reader.bundle.slug === record.slug) {
      showReaderError('A cópia local da história está incompleta ou inválida. Tente novamente para recuperar os arquivos.');
      el.openSaved.hidden = true;
    }
    if (!el.library.hidden) renderLibrary();
  }, 1500);
}

function preferences() {
  const defaults = { voicesEnabled: true, musicEnabled: false, autoAdvanceEnabled: false,
    pageOverviewEnabled: window.matchMedia('(min-width: 768px)').matches, musicVolumePercent: 25 };
  try {
    const stored = JSON.parse(localStorage.getItem('gimbol-standalone-preferences') ?? '{}');
    for (const key of Object.keys(defaults)) if (key !== 'musicVolumePercent' && typeof stored[key] === 'boolean') defaults[key] = stored[key];
    if (Number.isFinite(stored.musicVolumePercent)) defaults.musicVolumePercent = Math.max(0, Math.min(100, Math.round(stored.musicVolumePercent)));
  } catch { /* Leitura permanece disponível se o storage falhar. */ }
  return defaults;
}

function savePreferences(state) {
  try { localStorage.setItem('gimbol-standalone-preferences', JSON.stringify({
    voicesEnabled: state.voicesEnabled, musicEnabled: state.musicEnabled,
    autoAdvanceEnabled: state.autoAdvanceEnabled, pageOverviewEnabled: state.pageOverviewEnabled,
    musicVolumePercent: state.musicVolumePercent
  })); } catch { /* Preferências são opcionais. */ }
}

function route(slug, version = null) {
  const url = new URL(location.href);
  if (slug) url.searchParams.set('story', slug); else url.searchParams.delete('story');
  if (version) url.searchParams.set('version', version); else url.searchParams.delete('version');
  history.pushState({}, '', url);
}

function displayLibrary() {
  el.enterFullscreen.disabled = true;
  drag.cancel(false, false);
  requestGeneration += 1;
  downloadController?.abort(); downloadController = null;
  reader?.dispose(); reader = null;
  renderedPage = null;
  el.reader.hidden = true;
  el.library.hidden = false;
  el.libraryButton.hidden = true;
  document.body.classList.remove('reading');
  if (catalog) renderLibrary();
  document.title = 'Gimbol · Biblioteca';
  presentation.exit({ dispose: true });
}

function showReaderError(message) {
  el.enterFullscreen.disabled = true;
  drag.cancel(false, false);
  el.error.textContent = message;
  el.error.hidden = false;
  el.retryStory.hidden = false;
  el.content.hidden = true;
  el.endCard.hidden = true;
  reader?.dispose(); reader = null;
  presentation.exit({ dispose: true });
}

function libraryIcon(name) {
  const paths = {
    book: '<path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Z"/><path d="M12 5v15"/>',
    check: '<circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><path d="m7 12 3 3 7-7" stroke="white"/>',
    arrow: '<path d="m9 5 7 7-7 7"/>',
    trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
    download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>'
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true'); svg.innerHTML = paths[name];
  return svg;
}

function storyLink(story, version = null) {
  const link = document.createElement('a');
  link.href = `?story=${encodeURIComponent(story.slug)}${version ? `&version=${encodeURIComponent(version)}` : ''}`;
  link.addEventListener('click', event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); route(story.slug, version); openStory(story.slug, version);
  });
  return link;
}

function renderLibrary() {
  el.list.replaceChildren(); el.continueList.replaceChildren();
  const stories = catalog.stories.filter(story => !onlyDownloaded || availableFor(story.slug));
  for (const story of stories) {
    const item = document.createElement('article'); item.className = 'story-item';
    const local = availableFor(story.slug);
    const bookmark = local && readBookmark(story.slug, local.version);
    const currentSaved = local && (local.bundleUrl === new URL(story.bundle, catalogUrl).href || catalogOffline);
    // Continue the confirmed version; a newer catalog release remains a separate action.
    const continueVersion = bookmark && !currentSaved ? local.version : null;
    const card = storyLink(story, continueVersion); card.className = 'story-card';
    card.setAttribute('aria-label', `Abrir ${story.title}`);
    const cover = document.createElement('img');
    setSharedImage(cover, libraryCoverUrl(story, catalogUrl, local, catalogOffline));
    cover.alt = `Capa de ${story.title}`;
    cover.loading = 'lazy';
    cover.onerror = () => { cover.hidden = true; card.classList.add('story-card--no-cover'); };
    card.append(cover);
    const info = document.createElement('div'); info.className = 'story-card-info';
    const title = document.createElement('h3');
    const titleLink = storyLink(story, continueVersion); titleLink.textContent = story.title; title.append(titleLink);
    const metadata = document.createElement('div'); metadata.className = 'story-metadata';
    const age = document.createElement('span'); age.textContent = story.ageRange;
    metadata.append(age);
    if (local) {
      const badge = document.createElement('span'); badge.className = 'story-badge';
      badge.append(libraryIcon('check'), document.createTextNode('Baixada')); metadata.append(badge);
    }
    info.append(title, metadata);
    if (bookmark) {
      const progress = document.createElement('div'); progress.className = 'story-progress';
      const label = document.createElement('div'); label.className = 'story-progress-label';
      const percent = bookmarkPercent(bookmark);
      const value = document.createElement('strong'); value.textContent = `${percent}%`;
      label.append(document.createTextNode('Progresso da leitura'), value);
      const bar = document.createElement('progress'); bar.max = 100; bar.value = percent;
      bar.setAttribute('aria-label', `Posição da leitura de ${story.title}: quadrinho ${bookmark.sceneIndexGlobal + 1} de ${bookmark.totalScenes}`);
      progress.append(label, bar); info.append(progress);
    }
    const state = document.createElement('p'); state.className = 'story-state';
    state.textContent = local ? currentSaved ? '' : 'Há uma nova versão. Seu download anterior continua disponível.' : savedFor(story.slug).length ?
      'Download incompleto. Reconecte-se e tente novamente.' : catalogOffline ? 'Indisponível sem rede' : 'Baixe uma vez e leia também sem internet.';
    if (state.textContent) info.append(state);
    const action = storyLink(story, continueVersion); action.className = 'story-read';
    const actionLabel = bookmark ? bookmark.completed ? 'Reler história' : 'Continuar lendo' : local ? 'Ler história' : 'Baixar e ler';
    action.setAttribute('aria-label', `${actionLabel}: ${story.title}`);
    action.append(libraryIcon(local ? 'book' : 'download'), document.createTextNode(actionLabel), libraryIcon('arrow'));
    info.append(action);
    if (local && !currentSaved && bookmark) {
      const update = storyLink(story); update.className = 'story-remove'; update.textContent = 'Baixar nova versão'; info.append(update);
    }
    for (const saved of savedFor(story.slug)) {
      if (saved !== local && savedIntegrity.get(`${saved.slug}/${saved.version}`)) {
        const older = document.createElement('button'); older.className = 'story-remove'; older.type = 'button';
        older.textContent = `Abrir versão salva ${saved.version.slice(7, 15)}`;
        older.addEventListener('click', () => { route(story.slug, saved.version); openStory(story.slug, saved.version); });
        info.append(older);
      }
      const remove = document.createElement('button'); remove.className = 'story-remove'; remove.type = 'button';
      const removeLabel = savedFor(story.slug).length > 1 ? `Remover versão ${saved.version.slice(7, 15)}` : 'Remover do dispositivo';
      remove.append(libraryIcon('trash'), document.createTextNode(removeLabel));
      remove.setAttribute('aria-label', `${removeLabel}: ${story.title}`);
      remove.addEventListener('click', async () => {
        try {
          await removeStory(db, saved);
          removeBookmark(saved.slug, saved.version);
          await refreshSaved();
          if (catalogOffline) catalog.stories = catalog.stories.filter(item => savedFor(item.slug).length);
          renderLibrary();
        }
        catch (error) { el.libraryStatus.textContent = 'Não foi possível remover o download. Tente novamente.'; console.warn('[Gimbol] REMOVE_FAILED', error); }
      });
      info.append(remove);
    }
    item.append(card, info);
    (bookmark && !bookmark.completed ? el.continueList : el.list).append(item);
  }
  el.continueSection.hidden = !el.continueList.childElementCount;
  el.allSection.hidden = !el.list.childElementCount;
  el.allTitle.firstChild.textContent = onlyDownloaded || catalogOffline ? 'Suas histórias baixadas' : el.continueList.childElementCount ? 'Mais aventuras' : 'Escolha sua próxima história';
  el.offlineFilter.setAttribute('aria-pressed', String(onlyDownloaded));
  el.offlineFilter.setAttribute('aria-label', onlyDownloaded ? 'Mostrar todas as histórias' : 'Mostrar histórias baixadas');
  el.filterHint.textContent = onlyDownloaded ? 'Ver todas as histórias' : 'Ver histórias baixadas';
  el.libraryStatus.textContent = catalogOffline ? 'Sem acesso ao servidor. Histórias salvas continuam disponíveis.' :
    !stories.length ? onlyDownloaded ? 'Você ainda não baixou uma história. Veja todas as histórias para escolher sua aventura.' : 'Ainda não há histórias nesta biblioteca.' : '';
  if (catalogOffline && !stories.length) el.libraryStatus.textContent = 'Não foi possível acessar o computador. Confira o Wi-Fi e tente novamente.';
}

async function loadCatalog() {
  el.libraryStatus.textContent = 'Carregando histórias…';
  el.retryLibrary.hidden = true;
  try {
    const response = await fetch(catalogUrl, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    catalog = validateCatalog(await response.json());
    catalogOffline = false;
  } catch (error) {
    console.warn('[Gimbol] CATALOG_UNAVAILABLE', error);
    try {
      await refreshSaved();
      const snapshot = await getCatalog(db);
      catalog = snapshot ? validateCatalog(snapshot) : { schemaVersion: '1.0', stories: [] };
      catalog.stories = catalog.stories.filter(story => savedFor(story.slug).length);
      catalogOffline = true;
      renderLibrary();
      el.retryLibrary.hidden = false;
      await followRoute();
    } catch (storageError) {
      console.warn('[Gimbol] LOCAL_LIBRARY_UNAVAILABLE', storageError);
      catalog = null; el.list.replaceChildren(); el.continueList.replaceChildren();
      el.continueSection.hidden = true; el.allSection.hidden = true;
      el.libraryStatus.textContent = 'Biblioteca indisponível. Confira a conexão e o armazenamento e tente novamente.';
      el.retryLibrary.hidden = false; displayLibrary();
    }
    return;
  }
  // A reachable catalog stays visible even when browser storage fails.
  let storageWarning = null;
  try { await saveCatalog(db, catalog); }
  catch (error) {
    console.warn('[Gimbol] CATALOG_CACHE_FAILED', error);
    storageWarning = error.name === 'QuotaExceededError'
      ? 'Histórias carregadas. Não há espaço para salvar o catálogo. Libere espaço no dispositivo e tente novamente.'
      : 'Histórias carregadas. Não foi possível salvar o catálogo neste dispositivo. Tente novamente.';
  }
  try { await refreshSaved(); }
  catch (error) {
    console.warn('[Gimbol] LOCAL_LIBRARY_UNAVAILABLE', error);
    savedStories = []; savedIntegrity = new Map();
    storageWarning = 'Histórias carregadas. Não foi possível conferir os downloads deste dispositivo. Tente novamente.';
  }
  renderLibrary();
  await followRoute();
  if (storageWarning) { el.libraryStatus.textContent = storageWarning; el.retryLibrary.hidden = false; }
}

async function openSavedStory(record, generation) {
  const bundle = await readSavedBundle(record);
  if (!bundle) throw new Error('Arquivos locais ausentes.');
  if (generation !== requestGeneration) return;
  await startReader(bundle, record.bundleUrl, generation);
  auditSavedStory(record);
}

async function startReader(bundle, bundleUrl, generation, availablePages = Infinity) {
  if (generation !== requestGeneration) return;
  bundle.assetBase = bundleUrl;
  reader = new ReaderController(bundle, {
    availablePages,
    preferences: preferences(),
    capturePresentation: captureArt, present: presentArt, cancelPresentation: cancelVisual, finishVisual,
    onChange: (state, scene) => render(state, scene),
    onEvent: event => console.info('[Gimbol]', JSON.stringify({ slug: bundle.slug, ...event }))
  });
  el.downloadStatus.hidden = availablePages === Infinity; el.openSaved.hidden = true;
  el.error.hidden = true; el.content.hidden = false; el.position.hidden = false;
  document.title = `${bundle.title} · Gimbol`;
  const resume = resumeIndex(readBookmark(bundle.slug, bundle.version), reader.scenes);
  reader.enter(reader.scenes[resume].pageIndex < availablePages ? resume : 0);
}

async function openStory(slug, requestedVersion = null) {
  const generation = ++requestGeneration;
  await presentation.exit({ dispose: true });
  drag.cancel(false, false);
  reader?.dispose(); reader = null; renderedPage = null;
  el.library.hidden = true; el.reader.hidden = false;
  el.libraryButton.hidden = true; el.endLibrary.hidden = true;
  document.body.classList.add('reading');
  el.content.hidden = true; el.error.hidden = true;
  el.retryStory.hidden = true; el.downloadStatus.hidden = true;
  el.title.textContent = 'Carregando história…';
  try {
    const bundleUrl = new URL(STANDALONE_BUNDLE, document.baseURI).href;
    const response = await fetch(bundleUrl);
    if (!response.ok) throw new Error('Manifesto indisponível.');
    const bundle = await response.json();
    el.title.textContent = bundle.title;
    await startReader(bundle, bundleUrl, generation);
  } catch (error) {
    if (generation !== requestGeneration) return;
    showReaderError('Não foi possível abrir a história. Confira a conexão e tente novamente.');
    el.retryStory.hidden = false;
    console.error('[Gimbol standalone]', error);
  }
}

const failedVariants = new Set();

function balloonAssets(layer, scene, activeId, overview = false) {
  const bundle = reader.bundle;
  const key = bundle.version + '/' + scene.id + '/' + scene.panel;
  if (layer.dataset.visualScene !== key) {
    layer.replaceChildren();
    layer.dataset.visualScene = key;
    for (const balloon of scene.balloons) {
      const image = document.createElement('img');
      image.alt = ''; image.draggable = false;
      image.className = 'balloon-asset';
      image.dataset.balloonId = balloon.id;
      layer.append(image);
    }
  }
  const generation = reader.state.generation;
  const currentReader = reader;
  for (const image of layer.children) {
    const balloon = scene.balloons.find(item => item.id === image.dataset.balloonId);
    const path = balloon.id === activeId && !failedVariants.has(new URL(balloon.visual.glow, bundle.assetBase).href)
      ? balloon.visual.glow : balloon.visual.normal;
    const url = new URL(path, bundle.assetBase).href;
    image.style.objectFit = overview ? 'fill' : 'contain';
    image.onerror = () => {
      if (reader !== currentReader || generation !== reader.state.generation || image.src !== url) return;
      failedVariants.add(url);
      const fallback = new URL(balloon.visual.normal, bundle.assetBase).href;
      if (url !== fallback) image.src = fallback; else image.hidden = true;
      reader.visualError(generation);
    };
    if (image.src !== url) { image.hidden = false; image.src = url; }
  }
}

function glowAt(layer, balloon) {
  delete layer.dataset.visualScene;
  layer.replaceChildren();
  if (!balloon) return;
  const glow = document.createElement('span');
  const shape = balloon.shape === 'arredondado' && balloon.kind === 'fala' ? 'arredondado'
    : balloon.kind === 'narracao' ? 'legenda' : 'oval';
  glow.className = `balloon-glow balloon-glow--${shape}`;
  glow.style.left = `${balloon.box.x * 100}%`;
  glow.style.top = `${balloon.box.y * 100}%`;
  glow.style.width = `${balloon.box.width * 100}%`;
  glow.style.height = `${balloon.box.height * 100}%`;
  layer.append(glow);
}

function alignFocusedGlow() {
  const frameWidth = el.focused.clientWidth;
  const frameHeight = el.focused.clientHeight;
  const imageWidth = el.panel.naturalWidth;
  const imageHeight = el.panel.naturalHeight;
  if (!frameWidth || !frameHeight || !imageWidth || !imageHeight || !el.panel.complete) {
    el.layer.style.visibility = 'hidden';
    return;
  }
  const scale = Math.min(frameWidth / imageWidth, frameHeight / imageHeight);
  const width = imageWidth * scale;
  const height = imageHeight * scale;
  el.layer.style.inset = 'auto';
  el.layer.style.left = `${(frameWidth - width) / 2}px`;
  el.layer.style.top = `${(frameHeight - height) / 2}px`;
  el.layer.style.width = `${width}px`;
  el.layer.style.height = `${height}px`;
  el.layer.style.visibility = 'visible';
}

function fitPageView() {
  const width = el.artViewport.clientWidth;
  const height = el.artViewport.clientHeight;
  if (!width || !height) return;
  const scale = Math.min(width / 720, height / 1050);
  el.pageView.style.width = `${Math.floor(720 * scale)}px`;
  el.pageView.style.height = `${Math.floor(1050 * scale)}px`;
}

function createPageView(page, bundle) {
  const view = document.createElement('div'); view.className = 'page-view';
  view.style.gridTemplateRows = page.rows.map(row => `${row.heightRatio}fr`).join(' ');
  const generation = requestGeneration;
  for (const row of page.rows) {
    const rowElement = document.createElement('div');
    rowElement.className = 'overview-row';
    rowElement.style.gridTemplateColumns = row.columns.map(column => `${column.widthRatio}fr`).join(' ');
    for (const column of row.columns) {
      const scene = page.scenes.find(item => item.id === column.sceneId);
      const cell = document.createElement('div');
      cell.className = 'overview-panel'; cell.dataset.sceneId = scene.id;
      const image = document.createElement('img');
      artwork(image, scene.panel, bundle);
      image.alt = `Quadrinho ${scene.id}`;
      image.onerror = () => { if (generation === requestGeneration && reader?.bundle === bundle) showReaderError(`Arte ${scene.id} indisponível. Volte à biblioteca ou tente novamente.`); };
      const overlay = document.createElement('div'); overlay.className = 'highlight-layer'; overlay.setAttribute('aria-hidden', 'true');
      if (['2.0', '3.0', '4.0'].includes(bundle.schemaVersion)) for (const balloon of scene.balloons) {
        const variant = document.createElement('img'); variant.className = 'balloon-asset';
        variant.dataset.balloonId = balloon.id; variant.alt = ''; variant.draggable = false;
        variant.src = new URL(balloon.visual.normal, bundle.assetBase).href; variant.style.objectFit = 'fill'; overlay.append(variant);
      }
      cell.append(image, overlay); rowElement.append(cell);
    }
    view.append(rowElement);
  }
  return view;
}

function buildPageView(page, bundle) {
  const view = createPageView(page, bundle);
  el.pageView.style.gridTemplateRows = view.style.gridTemplateRows;
  el.pageView.replaceChildren(...view.childNodes);
}

function render(state, scene) {
  if (!reader) return;
  if (currentDownload) showDownload(currentDownload);
  drag.changed();
  el.enterFullscreen.disabled = state.status !== 'ready';
  const bundle = reader.bundle;
  writeBookmark(bundle.slug, bundle.version, { sceneId: scene.id, sceneIndexGlobal: state.sceneIndexGlobal,
    totalScenes: reader.scenes.length, completed: state.status === 'ended', updatedAt: new Date().toISOString() });
  const page = bundle.pages[state.pageIndex];
  el.title.textContent = bundle.title;
  el.pageCounter.textContent = `${scene.pageNumber} / ${bundle.pages.length}`;
  el.sceneCounter.textContent = `${state.sceneIndexGlobal + 1} / ${reader.scenes.length}`;
  el.position.setAttribute('aria-label', state.status === 'ended'
    ? `Fim · página ${scene.pageNumber} de ${bundle.pages.length}`
    : `Página ${scene.pageNumber} de ${bundle.pages.length} · quadrinho ${state.sceneIndexGlobal + 1} de ${reader.scenes.length}`);
  const focusedScene = scenePresentation(scene);
  el.stage.classList.toggle('has-focused-variant', !state.pageOverviewEnabled && Boolean(scene.focused));
  const imageUrl = new URL(focusedScene.panel, bundle.assetBase).href;
  if (['3.0', '4.0'].includes(bundle.schemaVersion)) artwork(el.panel, focusedScene.panel, bundle);
  else if (el.panel.src !== imageUrl) el.panel.src = imageUrl;
  el.panel.alt = `Quadrinho ${state.sceneIndexGlobal + 1}: ${scene.balloons?.length ? 'cena com falas' : 'cena sem falas'}`;
  if (state.pageOverviewEnabled && renderedPage !== state.pageIndex) { buildPageView(page, bundle); renderedPage = state.pageIndex; }
  el.focused.hidden = state.pageOverviewEnabled;
  el.pageView.hidden = !state.pageOverviewEnabled;
  fitPageView();
  const active = scene.balloons?.find(balloon => balloon.id === state.activeBalloonId);
  if (['2.0', '3.0', '4.0'].includes(bundle.schemaVersion)) balloonAssets(el.layer, focusedScene, state.activeBalloonId);
  else glowAt(el.layer, active);
  alignFocusedGlow();
  for (const cell of el.pageView.querySelectorAll('.overview-panel')) {
    cell.classList.toggle('current', cell.dataset.sceneId === scene.id);
    const layer = cell.querySelector('.highlight-layer');
    if (['2.0', '3.0', '4.0'].includes(bundle.schemaVersion)) balloonAssets(layer, page.scenes.find(item => item.id === cell.dataset.sceneId),
      cell.dataset.sceneId === scene.id ? state.activeBalloonId : null, true);
    else glowAt(layer, cell.dataset.sceneId === scene.id ? active : null);
  }
  el.transcript.replaceChildren();
  if (scene.balloons?.length) {
    for (const balloon of scene.balloons) {
      const line = document.createElement('p'); line.className = balloon.id === state.activeBalloonId ? 'speech active' : 'speech';
      const speaker = document.createElement('strong'); speaker.textContent = `${balloon.speaker}: `;
      line.append(speaker, document.createTextNode(balloon.text)); el.transcript.append(line);
    }
  } else {
    const line = document.createElement('p'); line.className = 'silent-caption';
    line.textContent = 'Cena sem falas. Observe o quadrinho e avance quando quiser.'; el.transcript.append(line);
  }
  const positionKey = `${bundle.slug}/${bundle.version}/${scene.id}/${state.status}`;
  const positionChanged = positionKey !== lastAnnouncedPosition;
  const announcement = state.activeBalloonId ? `${active.speaker}: ${active.text}` : state.status === 'ended'
    ? 'Fim da história' : `Quadrinho ${state.sceneIndexGlobal + 1} de ${reader.scenes.length}`;
  if (!reader.suspension && (positionChanged || state.activeBalloonId) && announcement !== lastAnnouncement) {
    el.announcement.textContent = announcement; lastAnnouncement = announcement;
  }
  lastAnnouncedPosition = positionKey;
  const audioBlocked = state.audioNotice?.includes('bloqueou');
  el.audioStatus.textContent = reader.presentationGeneration !== null ? 'Abrindo quadrinho…' : audioBlocked ? 'Áudio pausado pelo navegador.' : [state.audioNotice, state.visualNotice].filter(Boolean).join(' ');
  el.retryAudio.hidden = !audioBlocked;
  el.previous.disabled = state.sceneIndexGlobal === 0 && state.status !== 'ended';
  el.next.disabled = state.status === 'ended';
  el.previousPage.disabled = scene.pageNumber === 1;
  el.nextPage.disabled = scene.pageNumber === bundle.pages.length;
  const labels = [[el.voices, state.voicesEnabled ? 'Narração ligada' : 'Narração desligada'],
    [el.music, state.musicEnabled ? (scene.trackId ? 'Música ligada' : 'Música ligada, sem trilha nesta cena') : 'Música desligada'],
    [el.auto, state.autoAdvanceEnabled ? 'Avanço automático ligado' : 'Avanço automático desligado'],
    [el.viewMode, state.pageOverviewEnabled ? 'Ver um quadrinho' : 'Ver página inteira']];
  for (const [button, label] of labels) { button.setAttribute('aria-label', label); button.title = label; }
  el.volume.value = String(state.musicVolumePercent);
  el.volumeValue.textContent = `${state.musicVolumePercent}%`;
  el.volume.style.setProperty('--volume-level', `${state.musicVolumePercent}%`);
  for (const [button, value] of [[el.voices, state.voicesEnabled], [el.music, state.musicEnabled],
    [el.auto, state.autoAdvanceEnabled], [el.viewMode, state.pageOverviewEnabled]]) button.setAttribute('aria-pressed', String(value));
  el.endCard.hidden = state.status !== 'ended';
  savePreferences(state);
  if (state.status === 'ended' || state.audioNotice?.includes('bloqueou') || state.audioNotice?.includes('Toque em Música')) presentation.exit();
}

async function followRoute() { await openStory(STANDALONE_SLUG); }

el.libraryButton.addEventListener('click', () => { route(null); displayLibrary(); });
el.enterFullscreen.addEventListener('click', () => { if (reader?.state.status === 'ready') presentation.enter(); });
el.exitFullscreen.addEventListener('click', () => presentation.exit());
el.endLibrary.addEventListener('click', () => { route(null); displayLibrary(); });
el.retryLibrary.addEventListener('click', loadCatalog);
el.offlineFilter.addEventListener('click', () => {
  onlyDownloaded = !onlyDownloaded;
  if (catalog) renderLibrary();
});
el.retryStory.addEventListener('click', followRoute);
el.openSaved.addEventListener('click', async () => {
  const slug = new URL(location.href).searchParams.get('story');
  const local = slug && availableFor(slug);
  if (!local) return;
  const generation = ++requestGeneration;
  downloadController?.abort();
  reader?.dispose(); reader = null;
  renderedPage = null; currentDownload = null;
  try { await openSavedStory(local, generation); }
  catch { showReaderError('Arquivos locais ausentes. Reconecte-se para baixar a história novamente.'); el.openSaved.hidden = true; }
});
el.previous.addEventListener('click', () => reader?.previous());
el.next.addEventListener('click', () => reader?.next());
el.previousPage.addEventListener('click', () => reader?.goToPage(reader.scene.pageNumber - 1));
el.nextPage.addEventListener('click', () => reader?.goToPage(reader.scene.pageNumber + 1));
el.voices.addEventListener('click', () => reader?.setVoices(!reader.state.voicesEnabled));
el.music.addEventListener('click', () => reader?.setMusic(!reader.state.musicEnabled));
el.volume.addEventListener('input', () => reader?.setMusicVolume(el.volume.value));
el.auto.addEventListener('click', () => reader?.setAutoAdvance(!reader.state.autoAdvanceEnabled));
el.viewMode.addEventListener('click', () => reader?.setPageOverview(!reader.state.pageOverviewEnabled));
el.retryAudio.addEventListener('click', () => reader?.retryAudio());
el.replay.addEventListener('click', () => reader?.replay());
el.panel.onerror = () => showReaderError('Arte indisponível. Confira a conexão e tente novamente.');
el.panel.onload = alignFocusedGlow;
new ResizeObserver(alignFocusedGlow).observe(el.focused);
new ResizeObserver(fitPageView).observe(el.artViewport);
function settleLayout() { drag.cancel(true, false); reader?.finishPresentation(); }
window.addEventListener('resize', settleLayout);
reducedMotion.addEventListener('change', settleLayout);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { drag.cancel(true, false); reader?.finishPresentation(); }
  else if (reader?.suspension) reader.resumeReading(reader.suspension);
});
el.artViewport.addEventListener('pointerdown', event => {
  if (!reader || event.target.closest('button, input, a')) return;
  drag.down(event, el.artViewport.clientWidth);
});
document.addEventListener('pointerdown', event => {
  if (drag.gesture && drag.gesture.id !== event.pointerId) drag.cancel(true, false);
}, true);
window.addEventListener('pointermove', event => drag.move(event), { passive: false });
window.addEventListener('pointerup', event => drag.up(event));
window.addEventListener('pointercancel', event => { if (event.pointerId === drag.gesture?.id) drag.cancel(); });
el.artViewport.addEventListener('lostpointercapture', event => drag.lostCapture(event));
el.artViewport.addEventListener('dragstart', event => event.preventDefault());
document.addEventListener('click', event => {
  if (event.target.closest('#reader-view button, #reader-view input')) drag.cancel(true, false);
}, true);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && presentation.session) { presentation.exit(); return; }
  if (!reader || el.reader.hidden || event.altKey || event.ctrlKey || event.metaKey ||
      (event.target !== el.exitFullscreen && event.target.closest('button, input, select, textarea, a, [contenteditable="true"]'))) return;
  const actions = { ArrowRight: () => reader.next(), ArrowLeft: () => reader.previous(),
    Home: () => reader.replay(), End: () => reader.enter(reader.scenes.length - 1) };
  if (actions[event.key]) { event.preventDefault(); drag.cancel(false, false); actions[event.key](); }
});
window.addEventListener('popstate', followRoute);
followRoute();
