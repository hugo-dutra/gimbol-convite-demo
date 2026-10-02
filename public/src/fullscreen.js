// Each request owns a distinct DOM surface: stale promises cannot exit a new session.
export class FullscreenPresentation {
  constructor({ doc, createSurface, onChange = () => {}, onLayout = () => {}, onRestore = () => {} }) {
    Object.assign(this, { doc, createSurface, onChange, onLayout, onRestore });
    this.session = null;
    this.changed = () => this.sync();
    this.failed = event => {
      const session = this.session;
      if (session && event.target === session.target && session.phase === 'entering') this.activate(session, 'expanded');
    };
    doc.addEventListener('fullscreenchange', this.changed);
    doc.addEventListener('fullscreenerror', this.failed);
  }

  activate(session, phase) {
    if (this.session !== session || session.cancelled) return;
    session.phase = phase;
    this.onChange(phase, session.target);
  }

  enter() {
    if (this.session) return;
    this.onLayout();
    const surface = this.createSurface();
    const session = { ...surface, phase: 'entering', cancelled: false };
    this.session = session;
    this.activate(session, 'entering');
    if (!session.target.requestFullscreen || this.doc.fullscreenEnabled === false) {
      this.activate(session, 'expanded'); return;
    }
    let pending;
    try { pending = session.target.requestFullscreen(); }
    catch { this.activate(session, 'expanded'); return; }
    Promise.resolve(pending).then(() => {
      if (session.cancelled || this.session !== session) {
        if (this.doc.fullscreenElement === session.target) return this.exitOwned(session);
        return;
      }
      if (this.doc.fullscreenElement === session.target) this.activate(session, 'native');
      else if (session.phase === 'entering') this.activate(session, 'expanded');
    }).catch(() => { if (this.session === session) this.activate(session, 'expanded'); });
  }

  sync() {
    const session = this.session;
    if (!session) return;
    if (this.doc.fullscreenElement === session.target) this.activate(session, 'native');
    else if (session.phase === 'native' || session.phase === 'exiting') this.restore(session);
  }

  exitOwned(session) {
    if (this.doc.fullscreenElement !== session.target) return Promise.resolve();
    try { return Promise.resolve(this.doc.exitFullscreen()); }
    catch (error) { return Promise.reject(error); }
  }

  exit({ dispose = false } = {}) {
    const session = this.session;
    if (!session) return Promise.resolve();
    this.onLayout();
    session.cancelled = true;
    if (this.doc.fullscreenElement !== session.target) { this.restore(session); return Promise.resolve(); }
    session.phase = 'exiting';
    this.onChange('exiting', session.target);
    return this.exitOwned(session).then(() => {
      if (this.doc.fullscreenElement !== session.target) this.restore(session);
    }).catch(() => {
      if (this.session !== session) return;
      if (dispose) {
        // Removing our own fullscreen surface also invokes the browser's unfullscreen steps.
        this.restore(session);
      } else {
        session.cancelled = false;
        this.activate(session, 'native');
        this.onChange('exit-error', session.target);
      }
    });
  }

  restore(session) {
    if (this.session !== session) return;
    this.session = null; session.cancelled = true;
    session.remove();
    this.onChange('normal', null);
    this.onRestore();
  }
}
