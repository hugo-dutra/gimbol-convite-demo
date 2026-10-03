
export function narrativeModes(bundle) {
  return bundle.schemaVersion === '5.0' ? ['gibi', 'narrada'] : ['gibi'];
}
export function pagesForNarrative(bundle, mode = 'gibi') {
  if (!narrativeModes(bundle).includes(mode)) throw new Error('Versão narrativa indisponível.');
  return bundle.schemaVersion === '5.0' ? bundle.narratives[mode].pages : bundle.pages;
}
export function allNarrativePages(bundle) {
  return bundle.schemaVersion === '5.0' ? narrativeModes(bundle).flatMap(mode => pagesForNarrative(bundle, mode)) : bundle.pages;
}
function validateNarratives(bundle) {
  const modes = bundle.narratives;
  if (!modes || Object.keys(modes).sort().join(',') !== 'gibi,narrada' ||
      Object.values(modes).some(mode => !mode || Object.keys(mode).join(',') !== 'pages' || !Array.isArray(mode.pages) || !mode.pages.length) ||
      JSON.stringify(bundle.pages) !== JSON.stringify(modes.gibi.pages)) throw new Error('Bundle exige Gibi e Narrador completos; página padrão é Gibi.');
  const alignment = pages => pages.map(page => ({ number: page.number, rows: page.rows,
    scenes: page.scenes.map(scene => ({ id: scene.id, trackId: scene.trackId })) }));
  if (JSON.stringify(alignment(modes.gibi.pages)) !== JSON.stringify(alignment(modes.narrada.pages))) throw new Error('Versões narrativas desalinhadas.');
  const ids = new Set();
  for (const mode of ['gibi', 'narrada']) {
    const audioOnlyScenes = new Set();
    for (const scene of modes[mode].pages.flatMap(page => page.scenes)) {
      if (scene.holdAfterSeconds !== undefined && (!Number.isFinite(scene.holdAfterSeconds) || scene.holdAfterSeconds < 0 || scene.holdAfterSeconds > 120)) throw new Error('Tempo de leitura inválido.');
      if (mode === 'narrada' && !scene.balloons?.length) throw new Error('Narração completa ausente na cena.');
      for (const balloon of scene.balloons ?? []) {
        if (ids.has(balloon.id)) throw new Error('ID de fala reutilizado entre versões.');
        ids.add(balloon.id);
        if (balloon.audioOnly !== undefined && balloon.audioOnly !== true) throw new Error('audioOnly inválido.');
        if (balloon.audioOnly) audioOnlyScenes.add(scene.id);
        if (mode === 'narrada' && balloon.kind !== 'narracao' && balloon.audioOnly !== true) throw new Error('Versão narrada exige somente narrador, salvo convite sem balão.');
      }
    }
    if (mode === 'narrada' && audioOnlyScenes.size > 1) throw new Error('A exceção de personagens sem balão deve ficar em uma única cena de convite.');
  }
}

// Shared browser-safe bundle 2.0 validation. Canonical source: packages/bundle-contract/browser.mjs.
export function mediaType(path) {
  if (/^images\/[a-f0-9]{64}\.png$/.test(path)) return 'image/png';
  if (/^images\/[a-f0-9]{64}\.jpeg$/.test(path)) return 'image/jpeg';
  if (/^(paginas|quadrinhos|baloes)\/[A-Za-z0-9_./-]+\.svg$/.test(path)) return 'image/svg+xml';
  if (/^audio\/[A-Za-z0-9_./-]+\.wav$/.test(path)) return 'audio/wav';
  if (/^(audio|trilhas)\/[A-Za-z0-9_./-]+\.mp3$/.test(path)) return 'audio/mpeg';
  throw new Error('Tipo público inválido: ' + path);
}

export function referencedPaths(bundle) {
  return [...new Set([bundle.cover, ...allNarrativePages(bundle).flatMap(page => [page.preview,
    ...page.scenes.flatMap(scene => [scene.panel, ...scene.balloons.flatMap(balloon =>
      [balloon.audio.path, ...(['2.0', '3.0', '4.0', '5.0'].includes(bundle.schemaVersion) ? [balloon.visual?.normal, balloon.visual?.glow] : [])]),
      ...(scene.focused ? [scene.focused.panel, ...scene.focused.balloons.flatMap(balloon => [balloon.visual?.normal, balloon.visual?.glow])] : [])])]),
    ...bundle.tracks.map(track => track.path), ...(['3.0', '4.0', '5.0'].includes(bundle.schemaVersion) ? bundle.images : [])])];
}

// Resolve artwork and overlays together; narrative/audio always come from the scene.
export function scenePresentation(scene, overview = false) {
  if (overview || !scene.focused) return scene;
  return { ...scene, panel: scene.focused.panel, viewBox: scene.focused.viewBox,
    balloons: scene.balloons.map((balloon, index) => ({ ...balloon, ...scene.focused.balloons[index] })) };
}

export function validateDelivery(bundle) {
  if (bundle.schemaVersion === '5.0') validateNarratives(bundle);
  if (!['4.0', '5.0'].includes(bundle.schemaVersion) && bundle.pages.some(page => page.scenes.some(scene => scene.focused !== undefined))) throw new Error('Composição focused exige entrega 4.0.');
  if (!['2.0', '3.0', '4.0', '5.0'].includes(bundle.schemaVersion)) return;
  if (['3.0', '4.0', '5.0'].includes(bundle.schemaVersion) && (!Array.isArray(bundle.images) ||
    new Set(bundle.images).size !== bundle.images.length || bundle.images.some(path => !/^images\/[a-f0-9]{64}\.(png|jpeg)$/.test(path)))) throw new Error('Imagens compartilhadas inválidas.');
  const paths = referencedPaths(bundle);
  const safe = path => typeof path === 'string' && /^(paginas|quadrinhos|baloes|audio|trilhas|images)\/[A-Za-z0-9_./-]+$/.test(path) &&
    path.split('/').every(part => part && part !== '.' && part !== '..');
  if (paths.some(path => !safe(path))) throw new Error('Asset 2.0 inválido.');
  const visualPaths = new Set();
  for (const scene of allNarrativePages(bundle).flatMap(page => page.scenes)) {
    if (scene.focused !== undefined) {
      const focused = scene.focused;
      if (!focused || !Array.isArray(focused.balloons) || focused.balloons.length !== scene.balloons.length ||
        focused.balloons.some((balloon, index) => balloon.id !== scene.balloons[index].id ||
          Object.keys(balloon).some(key => !['id', 'shape', 'box', 'visual'].includes(key)) ||
          !['oval', 'arredondado', 'legenda'].includes(balloon.shape) ||
          (scene.balloons[index].kind === 'pensamento' && balloon.shape !== 'oval') ||
          (scene.balloons[index].kind === 'narracao' ? balloon.shape !== 'legenda' : balloon.shape === 'legenda') ||
          !validBox(balloon.box)) || Object.keys(focused).some(key => !['panel', 'viewBox', 'balloons'].includes(key))) throw new Error('Composição focused incompleta ou divergente das falas.');
    }
    for (const presentation of scene.focused ? [scene, scenePresentation(scene)] : [scene]) {
    const current = presentation;
    const box = current.viewBox;
    if (!box || box.x !== 0 || box.y !== 0 || !Number.isFinite(box.width) || box.width <= 0 ||
      !Number.isFinite(box.height) || box.height <= 0 || !/^quadrinhos\/.+\.svg$/.test(current.panel)) throw new Error('Canvas 2.0 inválido.');
    if (current !== scene && (box.height <= box.width || current.panel === scene.panel)) throw new Error('Composição focused deve ter painel próprio vertical.');
    for (const balloon of current.balloons) {
      for (const variant of Object.values(balloon.visual ?? {})) {
        if (visualPaths.has(variant)) throw new Error('Variante reutilizada por outra fala.');
        visualPaths.add(variant);
      }
      if (!/^baloes\/.+\.svg$/.test(balloon.visual?.normal) || !/^baloes\/.+\.svg$/.test(balloon.visual?.glow) ||
        balloon.visual.normal === balloon.visual.glow) throw new Error('Variantes 2.0 inválidas.');
    }
    }
  }
  if (!Array.isArray(bundle.assets) || bundle.assets.length !== paths.length) throw new Error('Inventário 2.0 incompleto.');
  const seen = new Set();
  for (const asset of bundle.assets) {
    if (!asset || !paths.includes(asset.path) || seen.has(asset.path) || !Number.isSafeInteger(asset.bytes) ||
      asset.bytes <= 0 || asset.mime !== mediaType(asset.path) || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error('Inventário 2.0 inválido.');
    seen.add(asset.path);
  }
}

function validBox(box) {
  return box && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(box[key]) && box[key] >= 0) &&
    box.width > 0 && box.height > 0 && box.x + box.width <= 1 && box.y + box.height <= 1;
}

// Delivery SVGs use a deliberately small XML subset; this parser also checks nesting and duplicate attributes.
function svgTree(svg) {
  const stack = [], roots = [];
  let offset = 0;
  for (const token of svg.matchAll(/<[^>]*>|[^<]+/g)) {
    if (token.index !== offset) throw new Error('XML inválido.');
    offset += token[0].length;
    const value = token[0];
    if (!value.startsWith('<')) {
      if (value.trim()) {
        if (!stack.length || !['text', 'tspan'].includes(stack.at(-1).tag)) throw new Error('Texto SVG fora de text.');
        stack.at(-1).children.push(value);
      }
      continue;
    }
    if (/^<\?xml\s[^?]*\?>$/.test(value) && !roots.length && !stack.length) continue;
    const end = /^<\/([A-Za-z][A-Za-z0-9]*)\s*>$/.exec(value);
    if (end) {
      if (stack.pop()?.tag !== end[1]) throw new Error('XML sem fechamento correto.');
      continue;
    }
    const start = /^<([A-Za-z][A-Za-z0-9]*)(\s[^<>]*?)?\s*(\/?)>$/.exec(value);
    if (!start) throw new Error('Elemento SVG inválido.');
    const node = { tag: start[1], attrs: {}, children: [] };
    let tail = (start[2] ?? '').trim();
    while (tail) {
      const attr = /^([A-Za-z][A-Za-z0-9:_-]*)\s*=\s*("([^"<]*)"|'([^'<]*)')\s*/.exec(tail);
      if (!attr || Object.hasOwn(node.attrs, attr[1])) throw new Error('Atributo SVG inválido.');
      node.attrs[attr[1]] = attr[3] ?? attr[4];
      tail = tail.slice(attr[0].length);
    }
    if (stack.length) stack.at(-1).children.push(node); else roots.push(node);
    if (!start[3]) stack.push(node);
  }
  if (offset !== svg.length || stack.length || roots.length !== 1 || roots[0].tag !== 'svg') throw new Error('SVG inválido.');
  return roots[0];
}

function canvas(root, viewBox) {
  const actual = root.attrs.viewBox?.trim().split(/[\s,]+/).map(Number);
  if (!actual || actual.length !== 4 || actual.some((value, index) =>
    value !== [viewBox.x, viewBox.y, viewBox.width, viewBox.height][index]) ||
    Number(root.attrs.width) !== viewBox.width || Number(root.attrs.height) !== viewBox.height ||
    root.attrs.preserveAspectRatio && root.attrs.preserveAspectRatio !== 'xMidYMid meet') throw new Error('Canvas SVG divergente.');
}

export function validateVisuals(scene, getText) {
  validatePresentationVisuals(scene, getText);
  if (scene.focused) validatePresentationVisuals(scenePresentation(scene), getText);
}

function validatePresentationVisuals(scene, getText) {
  const base = svgTree(getText(scene.panel));
  canvas(base, scene.viewBox);
  // The base cannot carry speech text or balloon geometry: image(s), frame rectangle, and optional groups only.
  function baseOnly(node) {
    if (typeof node === 'string' || !['svg', 'g', 'image', 'rect'].includes(node.tag)) throw new Error('Base contém balão ou conteúdo inválido.');
    if (node.tag === 'rect' && node.attrs.fill !== 'none') throw new Error('Base contém preenchimento de balão.');
    node.children.forEach(baseOnly);
  }
  baseOnly(base);
  for (const balloon of scene.balloons) {
    const normal = svgTree(getText(balloon.visual.normal)), glow = svgTree(getText(balloon.visual.glow));
    canvas(normal, scene.viewBox); canvas(glow, scene.viewBox);
    if (balloon.audioOnly === true) {
      if (normal.children.length || glow.children.length) throw new Error('Fala sem balão deve ter overlays vazios.');
      continue;
    }
    const filters = new Set();
    let appliedFilters = 0;
    function geometry(node, inDefs = false) {
      if (typeof node === 'string') return node;
      const allowed = inDefs ? ['defs', 'filter', 'feGaussianBlur', 'feFlood', 'feComposite', 'feMerge', 'feMergeNode'] :
        ['svg', 'g', 'ellipse', 'rect', 'circle', 'polygon', 'path', 'text', 'tspan', 'defs'];
      if (!allowed.includes(node.tag)) throw new Error('Variante contém arte ou elemento inválido.');
      const attrs = { ...node.attrs };
      if (Object.keys(attrs).some(key => /^on/i.test(key) || ['style', 'href', 'xlink:href'].includes(key)) ||
        Object.values(attrs).some(value => /(?:javascript:|data:|url\s*\((?!#[A-Za-z0-9_-]+\))|&(?:#|[a-z]+;))/i.test(value))) throw new Error('Variante SVG ativa.');
      if (node.tag === 'defs') {
        if (Object.keys(attrs).length) throw new Error('Defs inválido.');
        node.children.forEach(child => geometry(child, true));
        return null;
      }
      if (inDefs) {
        if (node.tag === 'filter') {
          if (!/^[A-Za-z0-9_-]+$/.test(attrs.id ?? '') || filters.has(attrs.id) ||
            attrs.filterUnits !== 'userSpaceOnUse' || Number(attrs.x) > -8 || Number(attrs.y) > -8 ||
            Number(attrs.width) < scene.viewBox.width + 16 || Number(attrs.height) < scene.viewBox.height + 16 ||
            !['x','y','width','height'].every(key => Number.isFinite(Number(attrs[key])))) throw new Error('Margem de filtro inválida.');
          filters.add(attrs.id);
        }
        node.children.forEach(child => geometry(child, true));
        return null;
      }
      if (attrs.filter !== undefined) {
        const ref = /^url\(#([A-Za-z0-9_-]+)\)$/.exec(attrs.filter);
        if (!ref || !filters.has(ref[1]) || ['text', 'tspan', 'svg'].includes(node.tag) || attrs.fill !== 'none') throw new Error('Glow deve afetar somente contorno.');
        appliedFilters++;
        delete attrs.filter;
      }
      return [node.tag, Object.entries(attrs).sort(([a], [b]) => a.localeCompare(b)),
        node.children.map(child => geometry(child)).filter(child => child !== null)];
    }
    function textContent(node) {
      if (typeof node === 'string') return node.replace(/&(amp|lt|gt|quot|apos);/g, (_, key) =>
        ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[key]).replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_, value) =>
        String.fromCodePoint(value.startsWith('x') ? parseInt(value.slice(1), 16) : Number(value)));
      return node.children.map(textContent).filter(Boolean).join(' ');
    }
    const normalize = value => value.trim().split(/\s+/).join(' ');
    if (normalize(textContent(normal)) !== normalize(balloon.text)) throw new Error('Texto do balão divergente da fala.');
    const normalGeometry = geometry(normal);
    if (filters.size || appliedFilters) throw new Error('Normal contém filtro de glow.');
    filters.clear();
    const glowGeometry = geometry(glow);
    if (!filters.size || !appliedFilters || JSON.stringify(normalGeometry) !== JSON.stringify(glowGeometry)) throw new Error('Normal/glow divergem em geometria, texto ou preenchimento.');
  }
}


// Only content-addressed raster dependencies from this exact release may be hydrated.
export function sharedImageReferences(svg, images) {
  if (/<!|<\?(?!xml\b)|<\s*(?:script|foreignObject|iframe|object|embed|animate\w*|set|use|style)\b|\bon[a-z]+\s*=|\b(?:javascript|vbscript):|@import|url\s*\(\s*(?!#)/i.test(svg)) throw new Error('SVG ativo ou recurso externo.');
  const refs = [];
  for (const match of svg.matchAll(/\b(?:href|xlink:href)\s*=\s*(["'])(.*?)\1/gi)) {
    const value = match[2];
    if (/^data:image\/svg\+xml;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) continue;
    if (!/^images\/[a-f0-9]{64}\.(png|jpeg)$/.test(value) || images && !images.includes(value)) throw new Error('Dependência de imagem inválida: ' + value);
    refs.push(value);
  }
  if ((svg.match(/<image\b/gi) ?? []).length !== [...svg.matchAll(/\b(?:href|xlink:href)\s*=\s*(["'])(.*?)\1/gi)].length) throw new Error('Imagem SVG sem href válido.');
  return [...new Set(refs)];
}

export function validateImageReferences(bundle, getText) {
  if (!['3.0', '4.0', '5.0'].includes(bundle.schemaVersion)) return;
  const used = new Set();
  for (const asset of bundle.assets) {
    if (asset.mime === 'image/svg+xml') sharedImageReferences(getText(asset.path), bundle.images).forEach(path => used.add(path));
    if (asset.path.startsWith('images/') && asset.path !== `images/${asset.sha256}.${asset.mime === 'image/png' ? 'png' : 'jpeg'}`) throw new Error('Hash da imagem diverge do path.');
  }
  if (used.size !== bundle.images.length || bundle.images.some(path => !used.has(path))) throw new Error('Inventário de imagens sem uso ou incompleto.');
}
