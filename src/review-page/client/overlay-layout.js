// Dialogs move by dragging their heading (kept on screen).
function makeDialogDraggable(dialog) {
  const handle = dialog.querySelector('h2');
  if (!handle) return;
  handle.classList.add('drag-handle');
  handle.title = 'Drag to move';
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const rect = dialog.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    const move = (moveEvent) => {
      const left = Math.max(0, Math.min(window.innerWidth - rect.width, moveEvent.clientX - offsetX));
      const top = Math.max(0, Math.min(window.innerHeight - 40, moveEvent.clientY - offsetY));
      Object.assign(dialog.style, {
        position: 'fixed',
        margin: '0',
        inset: 'auto',
        left: left + 'px',
        top: top + 'px'
      });
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  });
}
[
  'display-dialog',
  'vote-dialog',
  'boost-dialog',
  'person-dialog',
  'spoke-dialog',
  'zoom-dialog',
  'clip-dialog'
].forEach((id) => makeDialogDraggable($(id)));
// Overlay layout: each overlay's text size (from 🎛) and position (dragged on the video), remembered in this browser.
// Positions are fractions of the video's width and height, so they hold at any size.
const overlayElements = {
  title: 'title-overlay',
  chapter: 'agenda-overlay',
  clock: 'overlay',
  speakers: 'speaker-cards',
  votes: 'vote-overlay'
};
// var, not let: the name and chapter overlays are set up earlier in the page and ask for the chapter's placement
// before this runs (it stays undefined until here).
var overlayLayout = {};
try {
  overlayLayout = JSON.parse(localStorage.getItem('thumbnails.overlayLayout') || '{}') || {};
} catch {}
function saveOverlayLayout() {
  try {
    localStorage.setItem('thumbnails.overlayLayout', JSON.stringify(overlayLayout));
  } catch {}
}
function applyOverlayLayout() {
  Object.entries(overlayElements).forEach(([type, id]) => {
    const element = $(id);
    const layout = overlayLayout[type] || {};
    element.style.setProperty('--s', String(layout.size || 1));
    if (Number.isFinite(layout.x) && Number.isFinite(layout.y)) {
      element.style.left = layout.x * 100 + '%';
      element.style.top = layout.y * 100 + '%';
      element.style.right = 'auto';
      element.style.bottom = 'auto';
    } else {
      ['left', 'top', 'right', 'bottom'].forEach((side) => {
        element.style[side] = '';
      });
    }
  });
  stackChapter();
  document.querySelectorAll('[data-size]').forEach((slider) => {
    const size = Math.round((overlayLayout[slider.dataset.size]?.size || 1) * 100);
    slider.value = size;
    if (slider.nextElementSibling) slider.nextElementSibling.textContent = size + '%';
  });
}
// Unless it has been moved, the chapter sits just under the meeting name (or in its place when the name is hidden).
function stackChapter() {
  const chapter = $('agenda-overlay');
  if (!overlayLayout || Number.isFinite(overlayLayout.chapter?.x)) return;
  const title = $('title-overlay');
  const stage = $('stage');
  if (title.hidden || !stage.clientHeight) {
    chapter.style.top = '';
    chapter.style.left = title.hidden ? '' : title.style.left;
    return;
  }
  chapter.style.left = title.style.left || '';
  chapter.style.top = ((title.offsetTop + title.offsetHeight + 4) / stage.clientHeight) * 100 + '%';
}
document.querySelectorAll('[data-size]').forEach((slider) => {
  slider.addEventListener('input', () => {
    const type = slider.dataset.size;
    overlayLayout[type] = { ...overlayLayout[type], size: Number(slider.value) / 100 };
    saveOverlayLayout();
    applyOverlayLayout();
  });
});
$('layout-reset').addEventListener('click', () => {
  overlayLayout = {};
  saveOverlayLayout();
  applyOverlayLayout();
});
window.addEventListener('resize', stackChapter);
// Dragging: a press that moves more than a few pixels moves the overlay (and the click that follows is ignored, so it
// doesn't also edit, record a vote, or play); a press that doesn't move is an ordinary click.
function makeMovable(type) {
  const element = $(overlayElements[type]);
  element.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest('input, button, select')) return;
    const stage = $('stage');
    const start = { x: event.clientX, y: event.clientY, left: element.offsetLeft, top: element.offsetTop };
    let dragging = false;
    const move = (moveEvent) => {
      const dx = moveEvent.clientX - start.x;
      const dy = moveEvent.clientY - start.y;
      if (!dragging && Math.hypot(dx, dy) < 5) return;
      dragging = true;
      element.classList.add('dragging');
      const left = Math.max(0, Math.min(stage.clientWidth - element.offsetWidth, start.left + dx));
      const top = Math.max(0, Math.min(stage.clientHeight - element.offsetHeight, start.top + dy));
      overlayLayout[type] = {
        ...overlayLayout[type],
        x: left / stage.clientWidth,
        y: top / stage.clientHeight
      };
      applyOverlayLayout();
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      element.classList.remove('dragging');
      if (!dragging) return;
      saveOverlayLayout();
      // Swallow the click that ends the drag.
      window.addEventListener(
        'click',
        (clickEvent) => {
          clickEvent.stopPropagation();
          clickEvent.preventDefault();
        },
        { capture: true, once: true }
      );
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  });
}
Object.keys(overlayElements).forEach(makeMovable);

// Saved frames: paints the overlays exactly as they appear on the video (where they are, at their size), scaled to
// the frame's full resolution. Walks each visible overlay, drawing backgrounds, borders, photos, and text.
function paintOverlays(context, width) {
  const stage = $('stage');
  const stageRect = stage.getBoundingClientRect();
  if (!stageRect.width) return;
  const scale = width / stageRect.width;
  const roots = Object.values(overlayElements)
    .map((id) => $(id))
    .filter(
      (element) =>
        !element.hidden && !element.classList.contains('placeholder') && !element.classList.contains('fading')
    );
  roots.forEach((root) => paintElement(context, root, stageRect, scale));
}
function parseColor(value) {
  const match = String(value).match(/rgba?[(]([^)]+)[)]/);
  if (!match) return null;
  const parts = match[1].split(',').map((part) => Number(part.trim()));
  return { css: value, alpha: parts.length > 3 ? parts[3] : 1 };
}
function roundedPath(context, x, y, w, h, radius) {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  context.beginPath();
  if (context.roundRect) context.roundRect(x, y, w, h, r);
  else context.rect(x, y, w, h);
}
function paintElement(context, element, stageRect, scale) {
  const style = getComputedStyle(element);
  if (
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    element.classList.contains('vote-modes') ||
    element.tagName === 'BUTTON'
  )
    return;
  const rect = element.getBoundingClientRect();
  const x = (rect.left - stageRect.left) * scale;
  const y = (rect.top - stageRect.top) * scale;
  const w = rect.width * scale;
  const h = rect.height * scale;
  context.save();
  context.globalAlpha *= Number(style.opacity);
  const radius = parseFloat(style.borderTopLeftRadius) * scale || 0;
  const background = parseColor(style.backgroundColor);
  if (background && background.alpha > 0) {
    roundedPath(context, x, y, w, h, radius);
    context.fillStyle = background.css;
    context.fill();
  }
  const borderWidth = parseFloat(style.borderTopWidth) || 0;
  const border = parseColor(style.borderTopColor);
  if (borderWidth > 0 && style.borderTopStyle !== 'none' && border && border.alpha > 0) {
    context.lineWidth = borderWidth * scale;
    context.strokeStyle = border.css;
    context.setLineDash(
      style.borderTopStyle === 'dotted'
        ? [borderWidth * scale, borderWidth * scale * 1.5]
        : style.borderTopStyle === 'dashed'
          ? [borderWidth * scale * 3, borderWidth * scale * 2]
          : []
    );
    roundedPath(
      context,
      x + context.lineWidth / 2,
      y + context.lineWidth / 2,
      w - context.lineWidth,
      h - context.lineWidth,
      radius
    );
    context.stroke();
    context.setLineDash([]);
  }
  if (element.tagName === 'IMG') {
    if (element.complete && element.naturalWidth) {
      roundedPath(context, x, y, w, h, radius);
      context.clip();
      context.drawImage(element, x, y, w, h);
    }
    context.restore();
    return;
  }
  for (const node of element.childNodes) {
    if (node.nodeType === 1) paintElement(context, node, stageRect, scale);
    else if (node.nodeType === 3 && node.textContent.trim()) paintText(context, node, style, stageRect, scale);
  }
  context.restore();
}
// Text, line by line where the browser wrapped it.
function paintText(context, node, style, stageRect, scale) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const lines = [...range.getClientRects()].filter((line) => line.width > 0);
  if (!lines.length) return;
  context.font =
    style.fontStyle + ' ' + style.fontWeight + ' ' + parseFloat(style.fontSize) * scale + 'px ' + style.fontFamily;
  context.fillStyle = style.color;
  context.textBaseline = 'middle';
  context.textAlign = 'left';
  const words = node.textContent.trim().split(/ +/);
  let next = 0;
  lines.forEach((line, index) => {
    const lineWidth = line.width * scale;
    let text = '';
    if (index === lines.length - 1) text = words.slice(next).join(' ');
    else {
      while (next < words.length) {
        const candidate = text ? text + ' ' + words[next] : words[next];
        if (text && context.measureText(candidate).width > lineWidth + 2) break;
        text = candidate;
        next += 1;
      }
    }
    context.fillText(text, (line.left - stageRect.left) * scale, (line.top - stageRect.top + line.height / 2) * scale);
  });
}
applyOverlayLayout();
