// Camera views and zoom areas ({session}/views.json). A view is a camera angle (such as the dais from the back of the
// room), recognized by its picture: each camera change is matched to the view whose reference picture looks most
// like it, unless set by hand. Each view has a box for each person; the video can zoom to the speaker's box.
let viewData = { views: page.views.views || [], sceneViews: page.views.sceneViews || {} };
let manualZoom = null;
let zoomSelecting = false;
let zoomSelectedAt = 0;
let autoZoom = false;
try {
  autoZoom = localStorage.getItem('thumbnails.autoZoom') === '1';
} catch {}
$('auto-zoom').checked = autoZoom;
function setAutoZoom(on) {
  autoZoom = on;
  $('auto-zoom').checked = on;
  try {
    localStorage.setItem('thumbnails.autoZoom', on ? '1' : '0');
  } catch {}
  updateZoom();
}
$('auto-zoom').addEventListener('change', () => setAutoZoom($('auto-zoom').checked));
// A picture's signature: a 16x9 grayscale copy. Two shots from the same camera angle differ by a few levels on
// average (people move); different angles differ by 40 or more (out of 255), so 15 separates them well.
const pictureSignatures = new Map();
function pictureSignature(url) {
  if (!pictureSignatures.has(url)) {
    pictureSignatures.set(
      url,
      new Promise((resolve) => {
        const image = new Image();
        image.onload = () => {
          // Shrink in two steps so each point averages its area.
          const middle = document.createElement('canvas');
          middle.width = 64;
          middle.height = 36;
          const middleContext = middle.getContext('2d');
          middleContext.imageSmoothingQuality = 'high';
          middleContext.drawImage(image, 0, 0, 64, 36);
          const canvas = document.createElement('canvas');
          canvas.width = 16;
          canvas.height = 9;
          const context = canvas.getContext('2d');
          context.imageSmoothingQuality = 'high';
          context.drawImage(middle, 0, 0, 16, 9);
          const data = context.getImageData(0, 0, 16, 9).data;
          const gray = new Float32Array(144);
          for (let index = 0; index < 144; index += 1)
            gray[index] = data[index * 4] * 0.3 + data[index * 4 + 1] * 0.59 + data[index * 4 + 2] * 0.11;
          resolve(gray);
        };
        image.onerror = () => resolve(null);
        image.src = url;
      })
    );
  }
  return pictureSignatures.get(url);
}
const signatureDifference = (left, right) => {
  let total = 0;
  for (let index = 0; index < 144; index += 1) total += Math.abs(left[index] - right[index]);
  return total / 144;
};
const sameAngle = 15;
const sceneViewCache = new Map();
// The view a camera change shows: set by hand, else the view whose picture it looks most like (within 15), else none.
async function viewForScene(file) {
  if (Object.prototype.hasOwnProperty.call(viewData.sceneViews, file))
    return viewData.views.find((view) => view.id === viewData.sceneViews[file]) || null;
  const signature = await pictureSignature(file);
  if (!signature) return null;
  let best = null;
  for (const view of viewData.views) {
    if (!view.scene) continue;
    const reference = await pictureSignature(view.scene);
    if (!reference) continue;
    const difference = signatureDifference(signature, reference);
    if (difference <= sameAngle && (!best || difference < best.difference)) best = { view, difference };
  }
  return best ? best.view : null;
}
function currentSceneFile() {
  return nowScene >= 0 && page.scenes[nowScene] ? page.scenes[nowScene][1] : null;
}
let currentView = null;
async function refreshCurrentView() {
  const file = currentSceneFile();
  const view = file ? await viewForScene(file) : null;
  if (file !== currentSceneFile()) return;
  currentView = view;
  sceneViewCache.set(file, view ? view.id : null);
  // The shots either side too, so the magnifier switches views on the exact frame of a cut.
  [nowScene - 1, nowScene + 1].forEach((index) => {
    if (page.scenes[index]) cachedViewFor(page.scenes[index][1]);
  });
  renderViewSelect();
  updateZoom();
}
// The view of a shot if it's known yet (undefined while it's being worked out, null for none).
const pendingViews = new Set();
function cachedViewFor(file) {
  if (!sceneViewCache.has(file)) {
    if (!pendingViews.has(file)) {
      pendingViews.add(file);
      viewForScene(file).then((view) => {
        sceneViewCache.set(file, view ? view.id : null);
        pendingViews.delete(file);
        updateZoom();
      });
    }
    return undefined;
  }
  const id = sceneViewCache.get(file);
  return id ? viewData.views.find((view) => view.id === id) || null : null;
}
// The shot (camera change) showing at a video position, as an index into page.scenes, or -1.
function sceneIndexAt(seconds) {
  const scenes = page.scenes;
  let low = 0,
    high = scenes.length - 1,
    found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (scenes[middle][0] <= seconds + 0.05) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return found;
}
function renderViewSelect() {
  const select = $('view-select');
  const file = currentSceneFile();
  if (!file) return;
  if (!sceneViewCache.has(file)) {
    refreshCurrentView();
  }
  const manual = Object.prototype.hasOwnProperty.call(viewData.sceneViews, file);
  const shownId = sceneViewCache.get(file) ?? null;
  const options = [
    [
      '',
      manual
        ? '📷 automatic'
        : '📷 ' + (viewData.views.find((view) => view.id === shownId)?.name || 'no view') + ' (automatic)'
    ]
  ]
    .concat(viewData.views.map((view) => [view.id, '📷 ' + view.name]))
    .concat([
      ['none', '📷 not a view'],
      ['new', '➕ New view from this camera…'],
      ['edit', '✎ Zoom areas…']
    ]);
  select.textContent = '';
  options.forEach(([value, label]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  });
  select.value = manual ? (viewData.sceneViews[file] === null ? 'none' : viewData.sceneViews[file]) : '';
}
$('view-select').addEventListener('click', (event) => event.stopPropagation());
$('view-select').addEventListener('change', async (event) => {
  event.stopPropagation();
  const file = currentSceneFile();
  const value = $('view-select').value;
  if (!file) return;
  if (value === 'edit') {
    renderViewSelect();
    openZoomEditor();
    return;
  }
  if (value === 'new') {
    const name = (prompt('Name this camera view (for example: Dais, wide):') || '').trim();
    if (!name) {
      renderViewSelect();
      return;
    }
    const view = { id: Date.now().toString(36), name, scene: file, regions: {} };
    viewData.views = [...viewData.views, view];
    viewData.sceneViews = { ...viewData.sceneViews, [file]: view.id };
    sceneViewCache.clear();
    if (await saveViews('Added the view ' + name)) openZoomEditor();
    return;
  }
  const sceneViews = { ...viewData.sceneViews };
  if (value === '') delete sceneViews[file];
  else sceneViews[file] = value === 'none' ? null : value;
  viewData.sceneViews = sceneViews;
  sceneViewCache.clear();
  await saveViews('Saved the camera view for this shot');
});
async function saveViews(done) {
  try {
    if (location.protocol === 'file:') throw new Error('saving needs the local server (npm start)');
    const response = await fetch('../views.json', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        { updatedAt: new Date().toISOString(), views: viewData.views, sceneViews: viewData.sceneViews },
        null,
        2
      )
    });
    if (!response.ok)
      throw new Error('the server answered ' + response.status + ' ' + (await response.text().catch(() => '')));
    $('snapshot-status').textContent = done;
    sceneViewCache.clear();
    refreshCurrentView();
    return true;
  } catch (error) {
    $('snapshot-status').textContent = 'Not saved: ' + error.message;
    return false;
  }
}
