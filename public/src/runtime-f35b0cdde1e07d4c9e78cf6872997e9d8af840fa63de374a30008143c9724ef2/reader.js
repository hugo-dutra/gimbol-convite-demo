import { validateDelivery, pagesForNarrative, narrativeModes } from './bundle-contract.js';

export function prepareBundle(bundle, narrative = 'gibi') {
  if (!['1.0', '2.0', '3.0', '4.0', '5.0'].includes(bundle?.schemaVersion) || !Array.isArray(bundle.pages)) {
    throw new Error('Bundle indisponível.');
  }

  const localAsset = value => typeof value === 'string' && /^[A-Za-z0-9_./-]+$/.test(value) &&
    !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..');
  if (!localAsset(bundle.cover) || !Array.isArray(bundle.tracks) || bundle.tracks.some(track => !localAsset(track.path))) {
    throw new Error('Bundle contém asset inválido.');
  }

  validateDelivery(bundle);
  const scenes = [];
  pagesForNarrative(bundle, narrative).forEach((page, pageIndex) => {
    if (!localAsset(page.preview) || page.scenes.some(scene => !localAsset(scene.panel) ||
      scene.balloons?.some(balloon => !localAsset(balloon.audio?.path)))) throw new Error(`Asset inválido na página ${page.number}.`);
    const byId = new Map(page.scenes.map(scene => [scene.id, scene]));
    page.rows.forEach(row => row.columns.forEach(column => {
      const scene = byId.get(column.sceneId);
      if (!scene) throw new Error(`Quadrinho ${column.sceneId} ausente.`);
      scenes.push({ ...scene, pageIndex, pageNumber: page.number });
    }));
  });
  if (!scenes.length) throw new Error('A história está vazia.');
  return scenes;
}

const MAX_MUSIC_VOLUME = 0.35;
const DEFAULT_MUSIC_LEVEL = 25;
const MUSIC_FADE_MS = 1500;
const MUSIC_FADE_STEP_MS = 50;

function musicLevel(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : DEFAULT_MUSIC_LEVEL;
}

export class ReaderController {
  constructor(bundle, { createAudio = path => new Audio(path), onChange = () => {}, onEvent = () => {},
    preferences = {}, setTimer = (callback, delay) => setTimeout(callback, delay), clearTimer = timer => clearTimeout(timer),
    now = () => performance.now(), capturePresentation = () => null, present = () => null,
    cancelPresentation = () => {}, finishVisual = cancelPresentation, availablePages = Infinity } = {}) {
    this.availablePages = availablePages;
    this.waitingIndex = null;
    this.capturePresentation = capturePresentation;
    this.present = present;
    this.cancelPresentation = cancelPresentation;
    this.finishVisual = finishVisual;
    this.presentationGeneration = null;
    this.presentationTicket = null;
    this.hasEntered = false;
    this.suspension = null;
    this.autoDue = null;
    this.resumeSpeech = null;
    this.bundle = bundle;
    this.narrative = narrativeModes(bundle).includes(preferences.narrative) ? preferences.narrative : 'gibi';
    this.scenes = prepareBundle(bundle, this.narrative);
    this.createAudio = createAudio;
    this.onChange = onChange;
    this.onEvent = onEvent;
    this.audio = null;
    this.musicAudio = null;
    this.musicTrackId = null;
    this.musicFades = [];
    this.musicFadeTimer = null;
    this.autoTimer = null;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.now = now;
    this.state = {
      status: 'ready',
      narrative: this.narrative,
      sceneIndexGlobal: 0,
      pageIndex: this.scenes[0].pageIndex,
      generation: 0,
      playback: 'idle',
      activeBalloonId: null,
      voicesEnabled: preferences.voicesEnabled ?? true,
      musicEnabled: preferences.musicEnabled ?? false,
      musicVolumePercent: musicLevel(preferences.musicVolumePercent ?? DEFAULT_MUSIC_LEVEL),
      autoAdvanceEnabled: preferences.autoAdvanceEnabled ?? false,
      pageOverviewEnabled: preferences.pageOverviewEnabled ?? false,
      audioNotice: null,
      visualNotice: null
    };
  }

  get pages() { return pagesForNarrative(this.bundle, this.state.narrative); }

  setNarrative(mode) {
    if (mode === this.state.narrative) return false;
    if (!narrativeModes(this.bundle).includes(mode)) throw new Error('Versão narrativa indisponível.');
    const sceneId = this.scene.id;
    const scenes = prepareBundle(this.bundle, mode);
    const index = scenes.findIndex(scene => scene.id === sceneId);
    this.cancelPresentation();
    this.presentationGeneration = null;
    this.state.generation += 1;
    this.cancelPlayback();
    this.scenes = scenes;
    this.state.narrative = mode;
    this.hasEntered = false;
    return this.enter(index < 0 ? 0 : index);
  }

  get scene() { return this.scenes[this.state.sceneIndexGlobal]; }

  emit() { this.onChange({ ...this.state }, this.scene); }

  event(type, falaId = null) {
    this.onEvent({ type, falaId, sceneId: this.scene.id, generation: this.state.generation });
  }

  cancelPlayback() {
    this.suspension = null;
    this.resumeSpeech = null;
    this.autoDue = null;
    if (this.autoTimer !== null) { this.clearTimer(this.autoTimer); this.autoTimer = null; }
    const audio = this.audio;
    this.audio = null;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      try { audio.currentTime = 0; } catch { /* Um stream ainda não carregou. */ }
    }
    this.state.activeBalloonId = null;
    this.state.playback = audio ? 'cancelled' : 'idle';
  }

  enter(index, { progress = 0, prepared = null } = {}) {
    if (index < 0 || index >= this.scenes.length ||
        (this.hasEntered && this.state.status === 'ready' && index === this.state.sceneIndexGlobal)) return false;
    if (this.scenes[index].pageIndex >= this.availablePages) {
      this.waitingIndex = index;
      this.state.downloadWaiting = true;
      this.emit();
      return false;
    }
    this.waitingIndex = null;
    this.state.downloadWaiting = false;
    const from = this.hasEntered && this.state.status === 'ready' ? { ...this.state } : null;
    this.cancelPresentation();
    this.presentationGeneration = null;
    this.state.generation += 1;
    this.cancelPlayback();
    let source = null;
    try { source = prepared?.source ?? (from ? this.capturePresentation(from) : null); } catch { /* Exibição direta sem snapshot. */ }
    this.state.sceneIndexGlobal = index;
    this.state.pageIndex = this.scenes[index].pageIndex;
    this.state.status = 'ready';
    this.state.audioNotice = null;
    this.hasEntered = true;
    const generation = this.state.generation;
    this.presentationGeneration = generation;
    const ticket = { generation };
    this.presentationTicket = ticket;
    this.event('ENTER_SCENE');
    this.syncMusic();
    this.emit();
    let pending;
    try { pending = this.present({ from, to: { ...this.state }, source, progress, prepared }); }
    catch { /* Uma falha somente do efeito permite apresentação direta. */ }
    const complete = () => { if (this.presentationTicket === ticket) this.completePresentation(ticket.generation); };
    if (pending?.then) Promise.resolve(pending).then(complete, complete);
    else this.completePresentation(generation);
    return true;
  }

  completePresentation(generation) {
    if (this.presentationGeneration !== generation || generation !== this.state.generation) return;
    this.presentationGeneration = null;
    if (this.state.voicesEnabled) this.playNext(0, generation);
    else this.finishScene(generation);
  }

  setAvailablePages(count) {
    this.availablePages = count;
    if (this.waitingIndex !== null && this.scenes[this.waitingIndex].pageIndex < count) this.enter(this.waitingIndex);
  }

  finishPresentation() {
    this.finishVisual();
  }

  next() {
    this.event('NEXT_SCENE');
    if (this.state.status === 'ended') return false;
    if (this.state.sceneIndexGlobal < this.scenes.length - 1) {
      return this.enter(this.state.sceneIndexGlobal + 1);
    }
    this.cancelPresentation();
    this.presentationGeneration = null;
    this.state.generation += 1;
    this.cancelPlayback();
    this.state.status = 'ended';
    this.state.audioNotice = null;
    this.syncMusic();
    this.emit();
    return true;
  }

  previous() {
    this.event('PREVIOUS_SCENE');
    if (this.state.status === 'ended') return this.enter(this.scenes.length - 1);
    return this.enter(this.state.sceneIndexGlobal - 1);
  }

  goToPage(number) {
    const index = this.scenes.findIndex(scene => scene.pageNumber === number);
    return this.enter(index);
  }

  replay() { return this.enter(0); }

  stopMusic() {
    if (this.musicFadeTimer !== null) this.clearTimer(this.musicFadeTimer);
    this.musicFadeTimer = null;
    for (const audio of new Set([this.musicAudio, ...this.musicFades.map(fade => fade.audio)])) {
      if (!audio) continue;
      audio.onerror = null;
      audio.pause();
    }
    this.musicFades = [];
    this.musicAudio = null;
    this.musicTrackId = null;
  }

  get musicVolume() { return MAX_MUSIC_VOLUME * this.state.musicVolumePercent / 100; }

  updateMusicFades() {
    const time = this.now();
    this.musicFades = this.musicFades.filter(fade => {
      const progress = Math.min(1, Math.max(0, (time - fade.start) / MUSIC_FADE_MS));
      fade.gain = fade.from + (fade.to - fade.from) * progress;
      fade.audio.volume = this.musicVolume * fade.gain;
      if (progress < 1) return true;
      if (fade.to === 0) { fade.audio.onerror = null; fade.audio.pause(); }
      return false;
    });
  }

  scheduleMusicFade() {
    if (!this.musicFades.length || this.musicFadeTimer !== null) return;
    this.musicFadeTimer = this.setTimer(() => {
      this.musicFadeTimer = null;
      this.updateMusicFades();
      this.scheduleMusicFade();
    }, MUSIC_FADE_STEP_MS);
  }

  syncMusic() {
    const trackId = this.state.musicEnabled && this.state.status === 'ready' ? this.scene.trackId : null;
    if (trackId === this.musicTrackId && this.musicAudio) return;
    if (this.musicFadeTimer !== null) this.clearTimer(this.musicFadeTimer);
    this.musicFadeTimer = null;
    this.updateMusicFades();
    const previous = this.musicAudio;
    const previousGain = this.musicFades.find(fade => fade.audio === previous)?.gain ?? 1;
    for (const fade of this.musicFades) {
      if (fade.audio !== previous) { fade.audio.onerror = null; fade.audio.pause(); }
    }
    this.musicFades = [];
    this.musicAudio = null;
    this.musicTrackId = null;
    if (previous) {
      previous.onerror = null;
      if (previousGain > 0) this.musicFades.push({ audio: previous, from: previousGain, to: 0, gain: previousGain, start: this.now() });
      else previous.pause();
    }
    this.scheduleMusicFade();
    if (!trackId) return;
    const track = this.bundle.tracks?.find(item => item.id === trackId);
    if (!track) return;
    const audio = this.createAudio(new URL(track.path, this.bundle.assetBase).href);
    audio.loop = true;
    audio.volume = 0;
    this.musicAudio = audio;
    this.musicTrackId = trackId;
    this.musicFades.push({ audio, from: 0, to: 1, gain: 0, start: this.now() });
    this.scheduleMusicFade();
    audio.onerror = () => {
      if (this.musicAudio !== audio) return;
      this.stopMusic();
      this.state.audioNotice = 'A música não pôde ser reproduzida. A leitura continua.';
      this.emit();
    };
    try { Promise.resolve(audio.play()).catch(() => {
      if (this.musicAudio !== audio) return;
      this.stopMusic();
      this.state.audioNotice = 'Toque em Música para iniciar a trilha.';
      this.emit();
    }); }
    catch { this.stopMusic(); }
  }

  setMusic(enabled) {
    if (this.state.musicEnabled === enabled) return;
    this.state.musicEnabled = enabled;
    this.event('SET_MUSIC');
    this.syncMusic();
    this.emit();
  }

  setMusicVolume(percent) {
    const volume = musicLevel(percent);
    if (this.state.musicVolumePercent === volume) return;
    this.state.musicVolumePercent = volume;
    this.updateMusicFades();
    if (this.musicAudio && !this.musicFades.some(fade => fade.audio === this.musicAudio)) this.musicAudio.volume = this.musicVolume;
    this.event('SET_MUSIC_VOLUME');
    this.emit();
  }

  setAutoAdvance(enabled) {
    if (this.state.autoAdvanceEnabled === enabled) return;
    this.state.autoAdvanceEnabled = enabled;
    if (this.autoTimer !== null) { this.clearTimer(this.autoTimer); this.autoTimer = null; }
    this.event('SET_AUTO_ADVANCE');
    this.emit();
    if (enabled && !this.suspension && this.presentationGeneration === null && this.state.status === 'ready' && (this.state.playback === 'ended' || !this.state.voicesEnabled)) this.scheduleAdvance(this.state.generation);
  }

  setPageOverview(enabled) {
    if (this.state.pageOverviewEnabled === enabled) return;
    this.state.pageOverviewEnabled = enabled;
    this.emit();
    this.finishPresentation();
  }

  scheduleAdvance(generation, remaining = null) {
    if (!this.state.autoAdvanceEnabled || this.state.status !== 'ready' || this.suspension || this.presentationGeneration !== null) return;
    if (this.autoTimer !== null) this.clearTimer(this.autoTimer);
    const delay = remaining ?? Math.max((this.scene.holdAfterSeconds ?? 0) * 1000, this.scene.balloons?.length && this.state.voicesEnabled ? 900 : 1800);
    this.autoDue = this.now() + delay;
    this.autoTimer = this.setTimer(() => {
      this.autoTimer = null;
      if (generation === this.state.generation && this.state.autoAdvanceEnabled) this.next();
    }, delay);
  }

  finishScene(generation) {
    if (generation !== this.state.generation) return;
    this.state.playback = 'ended';
    this.state.activeBalloonId = null;
    this.emit();
    this.scheduleAdvance(generation);
  }

  dispose() {
    this.cancelPresentation();
    this.presentationGeneration = null;
    this.state.generation += 1;
    this.cancelPlayback();
    this.stopMusic();
  }

  setVoices(enabled) {
    if (this.state.voicesEnabled === enabled) return;
    const pending = this.presentationGeneration !== null;
    this.state.generation += 1;
    this.cancelPlayback();
    if (pending) {
      this.presentationGeneration = this.state.generation;
      this.presentationTicket.generation = this.state.generation;
    }
    this.state.voicesEnabled = enabled;
    this.state.audioNotice = null;
    this.event('SET_VOICES');
    this.emit();
    if (pending) return;
    if (enabled && this.state.status === 'ready') this.playNext(0, this.state.generation);
    else if (this.state.status === 'ready') this.finishScene(this.state.generation);
  }

  suspendReading() {
    if (this.suspension || this.presentationGeneration !== null || this.state.status !== 'ready') return null;
    const suspension = { generation: this.state.generation, audio: this.audio,
      remaining: this.autoTimer !== null ? Math.max(0, this.autoDue - this.now()) : null };
    this.suspension = suspension;
    if (this.autoTimer !== null) this.clearTimer(this.autoTimer);
    this.autoTimer = null;
    this.audio?.pause();
    this.state.activeBalloonId = null;
    this.emit();
    return suspension;
  }

  resumeReading(suspension) {
    if (!suspension || this.suspension !== suspension || suspension.generation !== this.state.generation) return;
    this.suspension = null;
    if (suspension.finish) suspension.finish();
    else if (suspension.audio && this.audio === suspension.audio && this.state.voicesEnabled) this.resumeSpeech?.();
    else if (this.state.autoAdvanceEnabled && this.state.playback === 'ended')
      this.scheduleAdvance(this.state.generation, suspension.remaining);
  }

  visualError(generation) {
    if (generation !== this.state.generation) return;
    this.state.activeBalloonId = null;
    this.state.visualNotice = 'Um balão não pôde ser destacado. A leitura continua.';
    this.emit();
  }

  retryAudio() {
    if (this.state.status !== 'ready' || !this.state.voicesEnabled) return;
    this.state.generation += 1;
    this.cancelPlayback();
    this.state.audioNotice = null;
    this.emit();
    this.playNext(0, this.state.generation);
  }

  playNext(position, generation) {
    if (generation !== this.state.generation || !this.state.voicesEnabled || this.state.status !== 'ready') return;
    const balloons = this.scene.balloons ?? [];
    if (position >= balloons.length) {
      this.finishScene(generation);
      return;
    }

    const balloon = balloons[position];
    const path = new URL(balloon.audio.path, this.bundle.assetBase).href;
    const audio = this.createAudio(path);
    let finished = false;
    this.audio = audio;
    this.state.playback = 'loading';
    this.emit();

    const isCurrent = () => generation === this.state.generation && this.audio === audio && !finished;
    const finish = failed => {
      if (!isCurrent()) return;
      if (this.suspension) { this.suspension.finish = () => finish(failed); return; }
      finished = true;
      audio.onended = null;
      audio.onerror = null;
      this.audio = null;
      this.state.activeBalloonId = null;
      this.state.playback = failed ? 'error' : 'ended';
      if (failed) this.state.audioNotice = 'Uma fala não pôde ser reproduzida. Continue lendo.';
      this.event(failed ? 'SPEECH_ERROR' : 'SPEECH_END', balloon.id);
      this.emit();
      this.playNext(position + 1, generation);
    };
    audio.onended = () => finish(false);
    audio.onerror = () => finish(true);

    this.resumeSpeech = () => {
      if (!isCurrent() || this.suspension) return;
      let resumed;
      try { resumed = audio.play(); }
      catch (error) { this.handlePlayError(error, audio, balloon, generation, finish, isCurrent); return; }
      Promise.resolve(resumed).then(() => {
        if (!isCurrent()) return;
        if (this.suspension) { audio.pause(); return; }
        this.state.playback = 'playing';
        this.state.activeBalloonId = balloon.id;
        this.emit();
      }).catch(error => this.handlePlayError(error, audio, balloon, generation, finish, isCurrent));
    };
    let start;
    try { start = audio.play(); }
    catch (error) { this.handlePlayError(error, audio, balloon, generation, finish, isCurrent); return; }
    Promise.resolve(start).then(() => {
      if (!isCurrent()) return;
      if (this.suspension) { audio.pause(); return; }
      this.state.playback = 'playing';
      this.state.activeBalloonId = balloon.id;
      this.event('SPEECH_START', balloon.id);
      this.emit();
    }).catch(error => this.handlePlayError(error, audio, balloon, generation, finish, isCurrent));
  }

  handlePlayError(error, audio, balloon, generation, finish, isCurrent) {
    if (!isCurrent()) return;
    if (error?.name !== 'NotAllowedError') { finish(true); return; }
    audio.onended = null;
    audio.onerror = null;
    this.audio = null;
    this.state.playback = 'error';
    this.state.activeBalloonId = null;
    this.state.audioNotice = 'O navegador bloqueou o áudio. Toque em “Ouvir esta cena” para iniciar.';
    this.event('SPEECH_ERROR', balloon.id);
    this.emit();
  }
}
