export const DRAG_THRESHOLDS = Object.freeze({ distance: 12, dominance: 1.3, commit: .25 });

export function adjacentIndex(reader, direction) {
  if (reader.state.status !== 'ready') return -1;
  if (!reader.state.pageOverviewEnabled) {
    const index = reader.state.sceneIndexGlobal + direction;
    return index >= 0 && index < reader.scenes.length ? index : -1;
  }
  return reader.scenes.findIndex(scene => scene.pageNumber === reader.scene.pageNumber + direction);
}

// Pointer recognition is separate from the decorative renderer and logical navigation.
export class DragTurn {
  constructor({ getReader, prepare, sheet, capture = () => {}, release = () => {},
    frame = callback => requestAnimationFrame(callback), unframe = id => cancelAnimationFrame(id),
    onError = () => {}, canResume = () => true }) {
    Object.assign(this, { getReader, prepare, sheet, capture, release, frame, unframe, onError, canResume });
    this.gesture = null;
    this.serial = 0;
    this.frameId = null;
  }

  down(event, width) {
    if (this.gesture) { if (event.pointerId !== this.gesture.id) this.cancel(); return; }
    const reader = this.getReader();
    if (!reader || reader.state.status !== 'ready' || reader.presentationGeneration !== null || reader.suspension ||
        event.button !== 0 || event.isPrimary === false || !['mouse', 'touch'].includes(event.pointerType) ||
        (event.pointerType === 'mouse' && event.buttons !== 1) || !width) return;
    this.gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, width, reader,
      generation: reader.state.generation, overview: reader.state.pageOverviewEnabled,
      serial: ++this.serial, progress: 0, recognized: false, released: false };
  }

  valid(gesture) {
    return this.gesture === gesture && this.getReader() === gesture.reader &&
      gesture.generation === gesture.reader.state.generation && gesture.overview === gesture.reader.state.pageOverviewEnabled;
  }

  move(event, releasing = false) {
    const gesture = this.gesture;
    if (!gesture || gesture.id !== event.pointerId || gesture.released) return;
    if (!this.valid(gesture) || (!releasing && event.pointerType === 'mouse' && event.buttons !== 1)) { this.cancel(); return; }
    const dx = event.clientX - gesture.x; const dy = event.clientY - gesture.y;
    if (!gesture.recognized) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < DRAG_THRESHOLDS.distance) return;
      if (Math.abs(dx) < Math.abs(dy) * DRAG_THRESHOLDS.dominance) { this.cancel(); return; }
      gesture.direction = dx < 0 ? 1 : -1;
      gesture.index = adjacentIndex(gesture.reader, gesture.direction);
      if (gesture.index < 0) { this.cancel(); return; }
      if (gesture.reader.scenes[gesture.index].pageIndex >= gesture.reader.availablePages) {
        gesture.reader.enter(gesture.index); this.cancel(); return;
      }
      gesture.suspension = gesture.reader.suspendReading();
      if (!gesture.suspension) { this.cancel(); return; }
      gesture.recognized = true;
      this.capture(gesture.id);
      gesture.prepared = Promise.resolve().then(() => this.prepare(gesture)).then(({ source, destination }) => {
        if (!this.valid(gesture)) return;
        gesture.art = { source, destination };
        try {
          this.sheet.begin(source, destination, gesture.direction);
          this.sheet.update(gesture.progress);
        } catch { this.sheet.cancel(); }
      }).catch(error => {
        if (this.valid(gesture)) { this.cancel(); this.onError(error); }
      });
    }
    event.preventDefault?.();
    gesture.progress = Math.min(1, Math.max(0, -dx * gesture.direction / gesture.width));
    if (this.frameId === null) this.frameId = this.frame(() => {
      this.frameId = null;
      if (this.valid(gesture)) this.sheet.update(gesture.progress);
    });
  }

  async up(event) {
    const gesture = this.gesture;
    if (!gesture || gesture.id !== event.pointerId || gesture.released) return;
    this.move(event, true);
    if (!this.valid(gesture)) return;
    if (!gesture.recognized || gesture.progress < DRAG_THRESHOLDS.commit) { this.cancel(); return; }
    gesture.released = true;
    this.release(gesture.id);
    await gesture.prepared;
    if (!this.valid(gesture)) return;
    const progress = gesture.progress;
    this.clear();
    gesture.reader.enter(gesture.index, { progress, prepared: gesture.art });
  }

  clear() {
    const gesture = this.gesture;
    this.gesture = null; this.serial += 1;
    if (this.frameId !== null) this.unframe(this.frameId);
    this.frameId = null;
    gesture?.cleanup?.();
    if (gesture) this.release(gesture.id);
    return gesture;
  }

  cancel(resume = true, animate = true) {
    const gesture = this.clear();
    if (!gesture?.recognized) return;
    const done = animate ? this.sheet.animate(0) : (this.sheet.cancel(), null);
    Promise.resolve(done).then(() => {
      if (resume && this.canResume() && this.getReader() === gesture.reader) gesture.reader.resumeReading(gesture.suspension);
    });
  }

  changed() {
    if (this.gesture && !this.valid(this.gesture)) this.cancel(false, false);
  }

  lostCapture(event) {
    // Touch starts with implicit capture on the image. Its bubbled loss during
    // transfer to the viewport is not a loss of the viewport's own capture.
    if (event.target !== event.currentTarget) return;
    if (event.pointerId === this.gesture?.id && !this.gesture.released) this.cancel();
  }
}
