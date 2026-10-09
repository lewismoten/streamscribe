// The selected person's copy in the zoom area editor: what it shows (a larger copy grown from their seat, a picture in
// picture fading in at its place, or nothing), and where it moves from a moment on (keyframes, listed with their
// times: a click goes there, × removes one).
function renderZoomMode() {
  const region = zoomEditing && zoomPerson ? zoomEditing.regions[zoomPerson] : null;
  $('zoom-show').disabled = !region;
  $('zoom-show').value = region ? showOf(region) : 'copy';
  const moves = $('zoom-moves');
  moves.textContent = '';
  if (!region?.moves?.length) return;
  moves.append('Moves at ');
  region.moves.forEach((move, index) => {
    const go = document.createElement('button');
    go.type = 'button';
    go.textContent = fmt(move.at);
    go.title = 'Go there';
    go.addEventListener('click', () => showPosition(move.at));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = 'Remove this move';
    remove.addEventListener('click', () => {
      region.moves = region.moves.filter((_, at) => at !== index);
      renderZoomMode();
      drawZoomCanvas();
    });
    moves.append(go, remove, ' ');
  });
}
$('zoom-show').addEventListener('change', () => {
  const region = zoomEditing?.regions[zoomPerson];
  if (!region) return;
  region.show = $('zoom-show').value;
  drawZoomCanvas();
});
