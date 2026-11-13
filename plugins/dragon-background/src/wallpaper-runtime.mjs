/** Runs only inside the selected desktop renderer. No user content is read. */
export async function installWallpaper({ image, opacity = 0.72, fit = 'cover', position = 'center center', scale = 100 }) {
  const KEY = '__codexDragonBackgroundV2';
  const ID = 'codex-dragon-wallpaper-v2';
  const ATTR = 'data-codex-dragon-wallpaper';
  if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(image)) throw new Error('Only an embedded image is accepted.');
  if (!['cover', 'contain', '100% 100%'].includes(fit) || !['center center','center top','center bottom','left center','right center'].includes(position)) throw new Error('Unsupported image layout.');
  if (!Number.isInteger(scale) || scale < 25 || scale > 200) throw new Error('Unsupported image scale.');
  const picture = new Image();
  picture.src = image;
  await picture.decode();
  window[KEY]?.remove();

  const marked = new Map();
  let surface = null;
  let host = null;
  let timer = null;
  let stopped = false;
  let renderedImageWidth = 0, renderedImageHeight = 0;
  let observedNodes = new Set();
  const mark = (node, value) => {
    if (!marked.has(node)) marked.set(node, node.getAttribute(ATTR));
    if (node.getAttribute(ATTR) !== value) node.setAttribute(ATTR, value);
  };
  const unmark = () => {
    for (const [node, value] of marked) {
      if (value === null) node.removeAttribute(ATTR);
      else node.setAttribute(ATTR, value);
    }
    marked.clear();
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width >= 300 && r.height >= 250 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const getEditors = () => [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')]
      .filter(el => {
        const r = el.getBoundingClientRect(), s = getComputedStyle(el);
        return r.width > 150 && r.height > 15 && s.display !== 'none' && s.visibility !== 'hidden' &&
          !el.closest('[role="dialog"], [aria-modal="true"]');
      });
  const chooseSurface = (editors) => {
    if (!editors.length) return null;
    const candidates = [...document.querySelectorAll('main, [role="main"], [data-app-shell-active-page="true"]')]
      .filter(visible)
      .filter(el => !el.closest('[role="dialog"], [aria-modal="true"]'));
    // A visible editor identifies the native chat surface, without reading text.
    const pool = candidates.filter(el => editors.some(editor => el.contains(editor)));
    pool.sort((a, b) => {
      const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
      return br.width * br.height - ar.width * ar.height;
    });
    if (pool.length) return pool[0];
    const editor = editors[0];
    for (let el = editor?.parentElement; el && el !== document.body; el = el.parentElement) {
      const r = el.getBoundingClientRect();
      if (r.width >= innerWidth * 0.5 && r.height >= innerHeight * 0.7) return el;
    }
    return null;
  };
  const choosePane = (editors, box) => {
    let node = surface;
    const primary = editors.find(editor => surface.contains(editor) && !editor.closest('article,[data-message-id],[data-message-author-role],[role="listitem"]'));
    for (let parent = primary?.parentElement; parent && parent !== surface; parent = parent.parentElement) {
      const r = parent.getBoundingClientRect();
      if (r.width >= 300 && r.height >= box.height * 0.55 && !parent.closest('article,[data-message-id],[data-message-author-role],[role="listitem"]')) { node = parent; break; }
    }
    const r = node.getBoundingClientRect();
    let left = Math.max(box.left + surface.clientLeft, r.left), top = Math.max(box.top + surface.clientTop, r.top);
    let right = Math.min(box.left + surface.clientLeft + surface.clientWidth, r.right), bottom = Math.min(box.top + surface.clientTop + surface.clientHeight, r.bottom);
    const panels = [...surface.querySelectorAll('aside')].filter(panel => {
      const p = panel.getBoundingClientRect();
      return !panel.contains(primary) && p.width > 250 && p.height > box.height * 0.55;
    });
    for (const panel of panels) {
      const p = panel.getBoundingClientRect();
      if (p.right >= box.right - 3 && p.left > left + 300 && p.left < right) right = p.left;
    }
    return { node, panels, left, top, right, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  };

  const sheet = document.createElement('style');
  sheet.id = ID + '-style';
  sheet.textContent = `
    [${ATTR}="surface"] { isolation: isolate !important; }
    [${ATTR}="surface-static"] { isolation: isolate !important; position: relative !important; }
    [${ATTR}="clear"] { background-color: transparent !important; }
    #${ID} {
      position: absolute !important; inset: auto !important;
      left: var(--wallpaper-left, 0px) !important; top: var(--wallpaper-top, 0px) !important;
      width: var(--wallpaper-width, 100%) !important; height: var(--wallpaper-height, 100%) !important;
      display: block !important; z-index: -1 !important;
      pointer-events: none !important; user-select: none !important;
      background-image: url("${image}") !important;
      background-size: var(--wallpaper-size, ${fit}) !important; background-position: ${position} !important;
      background-repeat: no-repeat !important;
      opacity: ${Math.max(0, Math.min(1, opacity))} !important;
    }
  `;
  (document.head || document.documentElement).append(sheet);

  const refresh = () => {
    if (stopped) return;
    const editors = getEditors();
    const next = chooseSurface(editors);
    if (!next) return;
    if (next !== surface || !host?.isConnected) {
      host?.remove();
      unmark();
      surface = next;
      mark(surface, getComputedStyle(surface).position === 'static' ? 'surface-static' : 'surface');
      host = document.createElement('div');
      host.id = ID;
      host.setAttribute('aria-hidden', 'true');
      surface.prepend(host);
    }
    const box = surface.getBoundingClientRect();
    const pane = choosePane(editors, box);
    const nodes = new Set([surface, pane.node, ...pane.panels]);
    for (const node of observedNodes) if (!nodes.has(node)) resizeObserver.unobserve(node);
    for (const node of nodes) if (!observedNodes.has(node)) resizeObserver.observe(node);
    observedNodes = nodes;
    host.style.setProperty('--wallpaper-left', Math.round(pane.left - box.left - surface.clientLeft) + 'px');
    host.style.setProperty('--wallpaper-top', Math.round(pane.top - box.top - surface.clientTop) + 'px');
    host.style.setProperty('--wallpaper-width', Math.round(pane.width) + 'px');
    host.style.setProperty('--wallpaper-height', Math.round(pane.height) + 'px');
    const base = fit === 'cover' ? Math.max(pane.width / picture.naturalWidth, pane.height / picture.naturalHeight) : Math.min(pane.width / picture.naturalWidth, pane.height / picture.naturalHeight);
    renderedImageWidth = Math.round((fit === '100% 100%' ? pane.width : picture.naturalWidth * base) * scale / 100);
    renderedImageHeight = Math.round((fit === '100% 100%' ? pane.height : picture.naturalHeight * base) * scale / 100);
    host.style.setProperty('--wallpaper-size', renderedImageWidth + 'px ' + renderedImageHeight + 'px');
    // Chat panes can occupy half the workspace and pass through display:contents.
    // Their composer ancestors identify structural paint without touching cards.
    const clearCandidates = new Set();
    for (const editor of editors) {
      const editorBox = editor.getBoundingClientRect();
      if (editorBox.left >= pane.right || editorBox.right <= pane.left) continue;
      for (let node = editor.parentElement; node && node !== surface; node = node.parentElement) {
        if (!surface.contains(node)) break;
        if (node.closest('article,[data-message-id],[data-message-author-role],[role="listitem"],[role="dialog"],[aria-modal="true"]')) continue;
        if (node.matches('iframe,canvas,pre,code,textarea,input,button,nav,[contenteditable="true"]')) continue;
        const r = node.getBoundingClientRect();
        if (r.width < Math.max(300, box.width * 0.25) || r.height < box.height * 0.55) continue;
        const s = getComputedStyle(node);
        if (node.getAttribute(ATTR) === 'clear' || (s.backgroundImage === 'none' && s.backgroundColor !== 'rgba(0, 0, 0, 0)')) clearCandidates.add(node);
      }
    }
    // Dot messaging portals its composer outside the painted transcript root.
    for (const node of surface.querySelectorAll('.messaging-root, .messaging-root .thread-pane')) {
      const r = node.getBoundingClientRect(), s = getComputedStyle(node);
      if (r.width < Math.max(300, box.width * 0.25) || r.height < box.height * 0.55) continue;
      if (node.getAttribute(ATTR) === 'clear' || (s.backgroundImage === 'none' && s.backgroundColor !== 'rgba(0, 0, 0, 0)')) clearCandidates.add(node);
    }
    for (const [node, previous] of marked) {
      if (node !== surface && !clearCandidates.has(node)) {
        if (previous === null) node.removeAttribute(ATTR); else node.setAttribute(ATTR, previous);
        marked.delete(node);
      }
    }
    for (const node of clearCandidates) mark(node, 'clear');
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 180);
  };
  const observer = new MutationObserver(schedule);
  const resizeObserver = new ResizeObserver(schedule);
  const state = {
    status() {
      const r = host?.getBoundingClientRect();
      return {
        installed: Boolean(host?.isConnected), imageDecoded: true,
        imageWidth: picture.naturalWidth, imageHeight: picture.naturalHeight,
        scale, renderedImageWidth, renderedImageHeight,
        surfaceTag: surface?.tagName || null,
        width: r ? Math.round(r.width) : 0, height: r ? Math.round(r.height) : 0,
        pointerEvents: host ? getComputedStyle(host).pointerEvents : null,
        adjustedStructuralBackgrounds: [...marked.values()].length - (surface ? 1 : 0)
      };
    },
    remove() {
      stopped = true;
      observer.disconnect();
      resizeObserver.disconnect();
      clearTimeout(timer);
      window.removeEventListener('resize', schedule);
      host?.remove();
      sheet.remove();
      unmark();
      delete window[KEY];
      return { installed: false, restored: true };
    }
  };
  window[KEY] = state;
  try {
    refresh();
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('resize', schedule);
    return state.status();
  } catch (error) {
    state.remove();
    throw error;
  }
}
