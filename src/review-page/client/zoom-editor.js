// Zoom area editor for the current view, over the video itself: its boxes are drawn on the playing video (which keeps
// playing, so people can be watched moving in the shot), with the editor's controls under the player. Each person has
// a box where they sit and their copy's box; what their copy shows (a larger copy, a picture in picture, or nothing);
// and, for a copy, places from a moment on (keyframes).
let zoomEditing = null;
let zoomPerson = null;
let zoomPicture = null;
let zoomLoop = 0;
const zoomCanvas = $('zoom-canvas');
// What's on the player now (the video, or the frame picture before it has loaded).
const liveSource = () => (playerReady && !video.hidden ? video : $('frame'));
async function openZoomEditor() {
  const view = currentView;
  if (!view) {
    $('snapshot-status').textContent = 'Pick or create a camera view for this shot first (📷 above the transcript)';
    return;
  }
  // A copy of each area, so nothing changes until saved.
  zoomEditing = {
    ...view,
    regions: Object.fromEntries(Object.entries(view.regions || {}).map(([id, region]) => [id, { ...region }])),
    members: [...(view.members || [])]
  };
  $('zoom-title').textContent = 'Zoom areas: ' + view.name;
  $('zoom-view-name').value = view.name;
  $('zoom-status').textContent = '';
  zoomPerson = voteData.members[0]?.id || null;
  renderZoomPeople();
  // On the player: the canvas over the video, the controls just under it.
  const stage = $('stage');
  if (zoomCanvas.parentElement !== stage) stage.appendChild(zoomCanvas);
  stage.after($('zoom-dialog'));
  stage.classList.add('editing-view');
  $('zoom-dialog').classList.add('docked');
  loadZoomPicture();
  $('zoom-dialog').show();
  // Drawn each frame while open, so copies follow the playing video.
  const loop = () => {
    drawZoomCanvas();
    zoomLoop = requestAnimationFrame(loop);
  };
  cancelAnimationFrame(zoomLoop);
  zoomLoop = requestAnimationFrame(loop);
}
$('zoom-dialog').addEventListener('close', () => {
  cancelAnimationFrame(zoomLoop);
  $('stage').classList.remove('editing-view');
});
function loadZoomPicture() {
  zoomPicture = liveSource();
  renderZoomMode();
  drawZoomCanvas();
}
function renderZoomPeople() {
  const box = $('zoom-people');
  box.textContent = '';
  const memberIds = voteData.members.map((member) => member.id);
  const ids = [...memberIds, ...Object.keys(zoomEditing.regions).filter((id) => !memberIds.includes(id))];
  const others = people.filter((person) => !ids.includes(person.id));
  ids.forEach((id) => {
    const person = peopleMap.get(id) || { id, name: id };
    const button = document.createElement('button');
    button.type = 'button';
    button.className = (id === zoomPerson ? 'on' : '') + (zoomEditing.regions[id] ? ' has-area' : '');
    const name = document.createElement('span');
    name.textContent = lastName(person);
    button.append(avatar(person), name);
    button.addEventListener('click', () => {
      zoomPerson = id;
      renderZoomPeople();
      drawZoomCanvas();
    });
    box.appendChild(button);
  });
  renderInView();
  renderZoomMode();
  // Anyone else (presenters, staff) from a menu.
  const select = document.createElement('select');
  const first = document.createElement('option');
  first.value = '';
  first.textContent = '+ someone else…';
  select.appendChild(first);
  others
    .sort((a, b) => shownName(a).localeCompare(shownName(b)))
    .forEach((person) => {
      const option = document.createElement('option');
      option.value = person.id;
      option.textContent = shownName(person);
      select.appendChild(option);
    });
  select.addEventListener('change', () => {
    if (select.value) {
      zoomPerson = select.value;
      renderZoomPeople();
      drawZoomCanvas();
    }
  });
  box.appendChild(select);
}
// Which voting members this camera view shows (when they're there): anyone with a box is; others can be checked
// (seen, but too small or too far for a box) or not (out of the shot). Saved with the view as `members`.
const inView = (id) => Boolean(zoomEditing.regions[id]) || zoomEditing.members.includes(id);
function renderInView() {
  const row = $('zoom-in-view');
  row.textContent = '';
  if (!voteData.members.length) return;
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = 'In this view';
  row.appendChild(label);
  voteData.members.forEach((member) => {
    const item = document.createElement('label');
    item.className = 'inline';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = inView(member.id);
    box.disabled = Boolean(zoomEditing.regions[member.id]);
    box.title = box.disabled ? 'Has a box, so is in this view' : '';
    box.addEventListener('change', () => {
      zoomEditing.members = box.checked
        ? [...new Set([...zoomEditing.members, member.id])]
        : zoomEditing.members.filter((id) => id !== member.id);
    });
    item.append(box, ' ' + lastName(peopleMap.get(member.id) || member));
    row.appendChild(item);
  });
  const all = document.createElement('button');
  all.type = 'button';
  all.textContent = 'All of them';
  all.addEventListener('click', () => {
    zoomEditing.members = voteData.members.map((member) => member.id);
    renderInView();
  });
  row.appendChild(all);
}
// Which box of the selected person is being edited: where they sit ('source') or their larger copy ('copy').
let zoomEditBox = 'source';
function setZoomEditBox(box) {
  zoomEditBox = box;
  $('zoom-edit-source').classList.toggle('on', box === 'source');
  $('zoom-edit-copy').classList.toggle('on', box === 'copy');
  drawZoomCanvas();
}
$('zoom-edit-source').addEventListener('click', () => setZoomEditBox('source'));
$('zoom-edit-copy').addEventListener('click', () => setZoomEditBox('copy'));
setZoomEditBox('source');
const boxOf = (region, which) =>
  which === 'copy'
    ? targetAt(region, currentSeconds())
    : { x: region.x, y: region.y, w: region.w, h: regionHeight(region) };
// The 8 resize handles of a box: corners and edge midpoints, with which sides each one moves.
function boxHandles(box) {
  const left = box.x,
    right = box.x + box.w,
    top = box.y,
    bottom = box.y + box.h;
  const middleX = box.x + box.w / 2,
    middleY = box.y + box.h / 2;
  return [
    { x: left, y: top, sides: 'nw', cursor: 'nwse-resize' },
    { x: right, y: top, sides: 'ne', cursor: 'nesw-resize' },
    { x: left, y: bottom, sides: 'sw', cursor: 'nesw-resize' },
    { x: right, y: bottom, sides: 'se', cursor: 'nwse-resize' },
    { x: middleX, y: top, sides: 'n', cursor: 'ns-resize' },
    { x: middleX, y: bottom, sides: 's', cursor: 'ns-resize' },
    { x: left, y: middleY, sides: 'w', cursor: 'ew-resize' },
    { x: right, y: middleY, sides: 'e', cursor: 'ew-resize' }
  ];
}
function drawZoomCanvas() {
  if (!zoomEditing) return;
  zoomPicture = liveSource();
  // The canvas covers the player; the video shows through it.
  const stage = $('stage');
  const ratio = window.devicePixelRatio || 1;
  const canvasWidth = Math.round((stage.clientWidth || 960) * ratio);
  const canvasHeight = Math.round((stage.clientHeight || 540) * ratio);
  if (zoomCanvas.width !== canvasWidth) zoomCanvas.width = canvasWidth;
  if (zoomCanvas.height !== canvasHeight) zoomCanvas.height = canvasHeight;
  const W = zoomCanvas.width;
  const H = zoomCanvas.height;
  const context = zoomCanvas.getContext('2d');
  if (!context || !context.clearRect) return;
  context.clearRect(0, 0, W, H);
  const pictureWidth = zoomPicture.videoWidth || zoomPicture.naturalWidth || 0;
  const pictureHeight = zoomPicture.videoHeight || zoomPicture.naturalHeight || 0;
  // (A picture still loading, or that didn't load, has no copy to show yet; its boxes still do.)
  const pictureReady = pictureWidth > 0 && pictureHeight > 0;
  const line = Math.max(2, W / 400);
  context.font = '600 ' + Math.round(H * 0.022) + 'px system-ui, sans-serif';
  context.textBaseline = 'top';
  // Names sit just outside a box (above it, or below when there's no room), so they never cover what's inside.
  const label = (text, box, color) => {
    const height = H * 0.03;
    const width = context.measureText(text).width + line * 4;
    const x = Math.max(0, Math.min(W - width, box.x * W));
    const above = box.y * H - height - line;
    const y = above >= 0 ? above : Math.min(H - height, (box.y + box.h) * H + line);
    context.fillStyle = 'rgba(0, 0, 0, 0.7)';
    context.fillRect(x, y, width, height);
    context.fillStyle = color;
    context.fillText(text, x + line * 2, y + line);
  };
  const drawCopy = (region, active) => {
    const target = targetAt(region, currentSeconds());
    const border = Math.max(2, W / 320);
    context.save();
    context.globalAlpha = active ? 1 : 0.45;
    context.shadowColor = 'rgba(0, 0, 0, 0.7)';
    context.shadowBlur = W / 80;
    context.fillStyle = '#000';
    context.fillRect(
      target.x * W - border,
      target.y * H - border,
      target.w * W + border * 2,
      target.h * H + border * 2
    );
    context.shadowColor = 'transparent';
    // (A picture that didn't load can't be drawn from; its box still shows.)
    if (pictureReady)
      try {
        context.drawImage(
          zoomPicture,
          region.x * pictureWidth,
          region.y * pictureHeight,
          region.w * pictureWidth,
          regionHeight(region) * pictureHeight,
          target.x * W,
          target.y * H,
          target.w * W,
          target.h * H
        );
      } catch {
        /* nothing to copy */
      }
    context.restore();
  };
  const drawHandles = (box) => {
    const size = W / 90;
    context.fillStyle = '#ffd166';
    context.strokeStyle = '#000';
    context.lineWidth = Math.max(1, line / 2);
    boxHandles(box).forEach((handle) => {
      context.fillRect(handle.x * W - size / 2, handle.y * H - size / 2, size, size);
      context.strokeRect(handle.x * W - size / 2, handle.y * H - size / 2, size, size);
    });
  };
  // Others: just their squares. The selected person: both boxes, the one being edited on top with its handles.
  Object.entries(zoomEditing.regions).forEach(([id, region]) => {
    if (id === zoomPerson) return;
    context.lineWidth = line;
    context.strokeStyle = 'rgba(255, 255, 255, 0.8)';
    context.strokeRect(region.x * W, region.y * H, region.w * W, regionHeight(region) * H);
    label(lastName(peopleMap.get(id) || { id, name: id }), boxOf(region, 'source'), '#ffffff');
  });
  const region = zoomEditing.regions[zoomPerson];
  if (!region) return;
  const name = lastName(peopleMap.get(zoomPerson) || { id: zoomPerson, name: zoomPerson });
  const source = boxOf(region, 'source');
  const copy = boxOf(region, 'copy');
  const drawSource = (active) => {
    context.lineWidth = active ? line * 1.5 : line;
    context.setLineDash(active ? [] : [line * 3, line * 2]);
    context.strokeStyle = active ? '#ffd166' : 'rgba(255, 209, 102, 0.6)';
    context.strokeRect(source.x * W, source.y * H, source.w * W, source.h * H);
    context.setLineDash([]);
  };
  if (zoomEditBox === 'copy') {
    drawSource(false);
    drawCopy(region, true);
    context.lineWidth = line * 1.5;
    context.strokeStyle = '#ffd166';
    context.strokeRect(copy.x * W, copy.y * H, copy.w * W, copy.h * H);
    drawHandles(copy);
    label(name, copy, '#ffd166');
  } else {
    // Editing where they sit: the larger copy is hidden so it can't get in the way.
    drawSource(true);
    drawHandles(source);
    label(name, source, '#ffd166');
  }
}
// What a press at a point would do to the box being edited: a handle (resize), inside (move), or outside.
function zoomHit(point, rect) {
  const region = zoomEditing.regions[zoomPerson];
  if (!region) return { mode: 'draw' };
  const box = boxOf(region, zoomEditBox);
  const toleranceX = 10 / rect.width;
  const toleranceY = 10 / rect.height;
  const handle = boxHandles(box).find(
    (item) => Math.abs(point.x - item.x) <= toleranceX && Math.abs(point.y - item.y) <= toleranceY
  );
  if (handle) return { mode: 'resize', handle, box };
  if (point.x >= box.x && point.x <= box.x + box.w && point.y >= box.y && point.y <= box.y + box.h)
    return { mode: 'move', box };
  return { mode: zoomEditBox === 'source' ? 'draw' : 'none' };
}
// Resizes a box from a handle, keeping its shape (h/w as fractions), anchored on the opposite side (or centered on
// the other axis for an edge handle), and kept inside the picture.
function resizedBox(box, sides, point, minimum) {
  const shape = box.h / box.w;
  const anchorX = sides.includes('w') ? box.x + box.w : box.x;
  const anchorY = sides.includes('n') ? box.y + box.h : box.y;
  let w;
  if (sides.length === 2) w = Math.max(Math.abs(point.x - anchorX), Math.abs(point.y - anchorY) / shape);
  else if (sides === 'e' || sides === 'w') w = Math.abs(point.x - anchorX);
  else w = Math.abs(point.y - anchorY) / shape;
  w = Math.max(minimum, Math.min(1, 1 / shape, w));
  const h = w * shape;
  let x = sides.includes('w') ? anchorX - w : sides.includes('e') ? anchorX : box.x + box.w / 2 - w / 2;
  let y = sides.includes('n') ? anchorY - h : sides.includes('s') ? anchorY : box.y + box.h / 2 - h / 2;
  x = Math.max(0, Math.min(1 - w, x));
  y = Math.max(0, Math.min(1 - h, y));
  return { x, y, w, h };
}
function setZoomBox(which, box) {
  const region = zoomEditing.regions[zoomPerson];
  if (which === 'copy') {
    // From this moment on (a keyframe), or always.
    if ($('zoom-keyframe').checked) {
      const at = Math.round(currentSeconds() * 10) / 10;
      region.moves = [...(region.moves || []).filter((move) => Math.abs(move.at - at) > 0.5), { at, target: box }].sort(
        (a, b) => a.at - b.at
      );
    } else region.target = box;
    return;
  }
  // Changing where they sit keeps the larger copy where it is, at the same size (reshaped to match if needed).
  const target = targetOf(region);
  const shape = box.h / box.w;
  zoomEditing.regions[zoomPerson] = {
    ...region,
    x: box.x,
    y: box.y,
    w: box.w,
    h: box.h,
    target: { ...target, h: Math.min(1 - target.y, target.w * shape) }
  };
}
zoomCanvas.addEventListener('pointermove', (event) => {
  if (event.buttons || !zoomPerson || !zoomEditing) return;
  const rect = zoomCanvas.getBoundingClientRect();
  const hit = zoomHit(
    { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height },
    rect
  );
  zoomCanvas.style.cursor =
    hit.mode === 'resize'
      ? hit.handle.cursor
      : hit.mode === 'move'
        ? 'move'
        : hit.mode === 'draw'
          ? 'crosshair'
          : 'default';
});
zoomCanvas.addEventListener('pointerdown', (event) => {
  if (!zoomPerson || !zoomPicture) {
    $('zoom-status').textContent = 'Pick a person first';
    return;
  }
  const rect = zoomCanvas.getBoundingClientRect();
  const point = (pointerEvent) => ({
    x: (pointerEvent.clientX - rect.left) / rect.width,
    y: (pointerEvent.clientY - rect.top) / rect.height
  });
  const start = point(event);
  const hit = zoomHit(start, rect);
  if (hit.mode === 'none') return;
  const which = zoomEditBox;
  const aspect = zoomCanvas.width / Math.max(1, zoomCanvas.height);
  zoomCanvas.setPointerCapture(event.pointerId);
  const move = (moveEvent) => {
    const now = point(moveEvent);
    if (hit.mode === 'move') {
      setZoomBox(which, {
        ...hit.box,
        x: Math.max(0, Math.min(1 - hit.box.w, hit.box.x + now.x - start.x)),
        y: Math.max(0, Math.min(1 - hit.box.h, hit.box.y + now.y - start.y))
      });
    } else if (hit.mode === 'resize') {
      setZoomBox(which, resizedBox(hit.box, hit.handle.sides, now, 0.02));
    } else {
      // A new square where they sit: as wide (in pixels) as the larger of the two drags.
      const dx = now.x - start.x;
      const dy = now.y - start.y;
      const w = Math.min(1, 1 / aspect, Math.max(Math.abs(dx), Math.abs(dy) / aspect, 0.02));
      const h = w * aspect;
      const square = {
        x: Math.max(0, Math.min(1 - w, dx < 0 ? start.x - w : start.x)),
        y: Math.max(0, Math.min(1 - h, dy < 0 ? start.y - h : start.y)),
        w,
        h
      };
      if (zoomEditing.regions[zoomPerson]) setZoomBox('source', square);
      else zoomEditing.regions[zoomPerson] = { ...square, target: magnifiedPlace(square, defaultGrow) };
    }
    drawZoomCanvas();
  };
  const up = () => {
    zoomCanvas.removeEventListener('pointermove', move);
    zoomCanvas.removeEventListener('pointerup', up);
    renderZoomPeople();
  };
  zoomCanvas.addEventListener('pointermove', move);
  zoomCanvas.addEventListener('pointerup', up);
});
$('zoom-area-remove').addEventListener('click', () => {
  if (zoomPerson) {
    delete zoomEditing.regions[zoomPerson];
    renderZoomPeople();
    drawZoomCanvas();
  }
});
// The video plays (and pauses) under the editor.
$('zoom-frame').addEventListener('click', () => togglePlay());
$('zoom-cancel').addEventListener('click', () => $('zoom-dialog').close());
$('zoom-view-delete').addEventListener('click', async () => {
  if (!zoomEditing || !confirm('Delete the view "' + zoomEditing.name + '" and its zoom areas?')) return;
  const id = zoomEditing.id;
  viewData.views = viewData.views.filter((view) => view.id !== id);
  viewData.sceneViews = Object.fromEntries(Object.entries(viewData.sceneViews).filter(([, value]) => value !== id));
  if (await saveViews('Deleted the view')) $('zoom-dialog').close();
});
$('zoom-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = $('zoom-view-name').value.trim() || zoomEditing.name;
  // Everyone with a box is in the view, with whoever else was checked.
  const members = voteData.members.map((member) => member.id).filter(inView);
  const edited = { ...zoomEditing, name, members };
  viewData.views = viewData.views.map((view) => (view.id === edited.id ? edited : view));
  if (await saveViews('Saved the zoom areas for ' + name)) {
    $('zoom-dialog').close();
    // Saving zoom areas means they're wanted: turn on magnifying whoever is speaking (also in 🎛).
    if (!autoZoom) {
      setAutoZoom(true);
      $('snapshot-status').textContent =
        'Saved the zoom areas for ' + name + ', and turned on 🔍 Magnify whoever is speaking (in 🎛)';
    }
  }
});
