// Lift the lower corner first, then flatten its trajectory into a lateral page turn.
// Keep the remaining face and the folded paper separate, with one outgoing DOM copy.
export function cornerFold(width, height, progress) {
  const p = Math.min(1, Math.max(0, progress));
  const flatten = Math.min(1, Math.max(0, (p - .2) / .45));
  const settle = flatten * flatten * (3 - 2 * flatten);
  const lift = Math.min(height * .45, width * .4) * Math.sin(Math.PI * p) * (1 - settle);
  const corner = { x: width * (1 - 2 * p), y: height - lift };
  const dx = width - corner.x; const dy = height - corner.y;
  const length = Math.hypot(dx, dy);
  const normal = length ? { x: dx / length, y: dy / length } : { x: Math.SQRT1_2, y: Math.SQRT1_2 };
  const k = normal.x * (width + corner.x) / 2 + normal.y * (height + corner.y) / 2;
  const signed = point => normal.x * point.x + normal.y * point.y - k;
  const rectangle = [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }];
  const clip = keepFront => {
    const result = [];
    for (let i = 0; i < rectangle.length; i++) {
      const a = rectangle[i]; const b = rectangle[(i + 1) % rectangle.length];
      const da = signed(a); const db = signed(b);
      const insideA = keepFront ? da <= 0 : da >= 0;
      const insideB = keepFront ? db <= 0 : db >= 0;
      if (insideA) result.push(a);
      if (insideA !== insideB) {
        const t = da / (da - db);
        result.push({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
      }
    }
    return result;
  };
  const front = clip(true);
  const peeled = clip(false);
  const hinge = front.filter(point => Math.abs(signed(point)) < .001)
    .filter((point, index, points) => points.findIndex(other => Math.hypot(point.x - other.x, point.y - other.y) < .001) === index);
  const radius = Math.sin(Math.PI * p) * Math.min(width, height) * .11;
  const center = hinge.length >= 2 ? { x: (hinge[0].x + hinge[1].x) / 2 - radius * normal.x,
    y: (hinge[0].y + hinge[1].y) / 2 - radius * normal.y } : { x: width, y: height };
  const path = points => {
    if (!points.length) return '';
    let d = `M ${points[0].x} ${points[0].y}`;
    for (let i = 1; i <= points.length; i++) {
      const a = points[i - 1]; const b = points[i % points.length];
      const crease = Math.abs(signed(a)) < .001 && Math.abs(signed(b)) < .001;
      d += crease ? ` Q ${center.x} ${center.y} ${b.x} ${b.y}` : ` L ${b.x} ${b.y}`;
    }
    return d + ' Z';
  };
  const folded = peeled.map(point => ({ x: point.x - 2 * signed(point) * normal.x,
    y: point.y - 2 * signed(point) * normal.y }));
  const crease = hinge.length >= 2 ? `M ${hinge[0].x} ${hinge[0].y} Q ${center.x} ${center.y} ${hinge[1].x} ${hinge[1].y}` : '';
  return { front: path(front), paper: path(folded), crease,
    corner, hinge, center };
}

// Decorative sheet composition shared by navigation and drag previews.
export class PageTurn {
  constructor(viewport, { reduced = () => false } = {}) {
    this.viewport = viewport;
    this.reduced = reduced;
    this.active = null;
    this.serial = 0;
  }

  snapshot(root, normalVariant = () => null) {
    const clone = root.cloneNode(true);
    for (const node of [clone, ...clone.querySelectorAll('*')]) {
      node.removeAttribute('id');
      node.removeAttribute('aria-labelledby');
      node.removeAttribute('aria-describedby');
      if (node.tagName === 'IMG') {
        node.alt = ''; node.draggable = false;
        const normal = normalVariant(node);
        if (normal) node.src = normal;
      }
    }
    clone.querySelectorAll('.balloon-glow').forEach(node => node.remove());
    clone.querySelectorAll('.current').forEach(node => node.classList.remove('current'));
    clone.hidden = false;
    clone.setAttribute('aria-hidden', 'true');
    clone.inert = true;
    const box = root.getBoundingClientRect();
    const area = this.viewport.getBoundingClientRect();
    const bounds = { left: box.left - area.left, top: box.top - area.top, width: box.width, height: box.height };
    if (root.classList.contains('panel-frame')) {
      const image = root.querySelector('img');
      if (image?.naturalWidth && image.naturalHeight) {
        const scale = Math.min(box.width / image.naturalWidth, box.height / image.naturalHeight);
        const width = image.naturalWidth * scale; const height = image.naturalHeight * scale;
        bounds.left += (box.width - width) / 2; bounds.top += (box.height - height) / 2;
        bounds.width = width; bounds.height = height;
        const layer = clone.querySelector('.highlight-layer');
        if (layer) Object.assign(layer.style, { inset: '0', width: '100%', height: '100%', left: '0', top: '0' });
      }
    }
    return { clone, box: bounds };
  }

  begin(source, destination, direction) {
    this.cancel();
    if (!source || !destination || this.reduced() || !source.box.width || !source.box.height ||
        !destination.box.width || !destination.box.height || !this.viewport.clientWidth || !this.viewport.clientHeight) return false;
    const width = this.viewport.clientWidth; const height = this.viewport.clientHeight;
    const doc = this.viewport.ownerDocument;
    const fit = snapshot => {
      const scale = Math.min(width / snapshot.box.width, height / snapshot.box.height);
      const artWidth = snapshot.box.width * scale; const artHeight = snapshot.box.height * scale;
      return { ...snapshot, box: { width: artWidth, height: artHeight, left: (width - artWidth) / 2,
        top: (height - artHeight) / 2 } };
    };
    source = fit(source); destination = fit(destination);
    const layer = doc.createElement('div');
    layer.className = 'sheet-turn'; layer.setAttribute('aria-hidden', 'true'); layer.inert = true;
    const back = doc.createElement('div'); back.className = 'sheet-destination';
    const front = doc.createElement('div'); front.className = 'sheet-source';
    const place = (frame, snapshot) => {
      // Both opaque sheets cover the viewport; only their artwork has variable bounds.
      Object.assign(frame.style, { left: '0px', top: '0px', width: `${width}px`, height: `${height}px` });
      Object.assign(snapshot.clone.style, { position: 'absolute', margin: '0',
        left: `${snapshot.box.left}px`, top: `${snapshot.box.top}px`,
        width: `${snapshot.box.width}px`, height: `${snapshot.box.height}px` });
      frame.append(snapshot.clone);
    };
    place(back, destination); place(front, source);
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('sheet-fold');
    Object.assign(svg.style, { left: '0px', top: '0px', width: `${width}px`, height: `${height}px` });
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const id = `sheet-${++this.serial}`;
    svg.innerHTML = `<defs><clipPath id="${id}"><path/></clipPath>
      <linearGradient id="${id}-paper" gradientUnits="userSpaceOnUse"><stop stop-color="#fffaf0"/>
      <stop offset=".45" stop-color="#f8efdc"/><stop offset=".8" stop-color="#e4d3af"/>
      <stop offset="1" stop-color="#bda984"/></linearGradient></defs>
      <path class="sheet-shadow"/><path class="sheet-paper" fill="url(#${id}-paper)"/>`;
    front.style.clipPath = `url(#${id})`;
    layer.append(back, front, svg); this.viewport.append(layer);
    let resolve;
    const finished = new Promise(done => { resolve = done; });
    this.active = { layer, front, svg, direction, width, height,
      clip: svg.querySelector('clipPath path'), paper: svg.querySelector('.sheet-paper'),
      shadow: svg.querySelector('.sheet-shadow'), gradient: svg.querySelector('linearGradient'),
      progress: 0, resolve, finished, frame: null };
    this.update(0);
    return true;
  }

  update(progress) {
    const turn = this.active;
    if (!turn) return;
    const p = Math.min(1, Math.max(0, progress)); turn.progress = p;
    const { width: w, height: h } = turn;
    const fold = cornerFold(w, h, p);
    turn.clip.setAttribute('d', fold.front);
    turn.paper.setAttribute('d', fold.paper);
    turn.shadow.setAttribute('d', fold.crease);
    turn.gradient.setAttribute('x1', fold.corner.x); turn.gradient.setAttribute('y1', fold.corner.y);
    turn.gradient.setAttribute('x2', fold.center.x); turn.gradient.setAttribute('y2', fold.center.y);
    const transform = turn.direction < 0 ? `translate(${w} 0) scale(-1 1)` : '';
    turn.clip.setAttribute('transform', transform);
    turn.paper.setAttribute('transform', transform); turn.shadow.setAttribute('transform', transform);
    turn.front.style.visibility = p >= 1 ? 'hidden' : 'visible';
    turn.svg.style.opacity = p > 0 && p < 1 ? '1' : '0';
  }

  animate(to = 1) {
    const turn = this.active;
    if (!turn) return null;
    if (turn.frame !== null) cancelAnimationFrame(turn.frame);
    if (this.reduced() || document.hidden) { this.cancel(); return turn.finished; }
    const start = performance.now(); const from = turn.progress;
    const duration = 600 * Math.abs(to - from);
    const tick = time => {
      if (this.active !== turn) return;
      const p = duration ? Math.min(1, (time - start) / duration) : 1;
      const eased = p * p * (3 - 2 * p);
      this.update(from + (to - from) * eased);
      if (p < 1) turn.frame = requestAnimationFrame(tick); else this.cancel();
    };
    turn.frame = requestAnimationFrame(tick);
    return turn.finished;
  }

  cancel() {
    const turn = this.active;
    this.active = null;
    if (!turn) return;
    if (turn.frame !== null) cancelAnimationFrame(turn.frame);
    turn.layer.remove(); turn.resolve();
  }
}
