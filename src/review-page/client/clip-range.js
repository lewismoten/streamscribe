// Markers above the scrubber at the clip's start and end, and a highlight between them (within the scrubber's range).
function renderCutMarks() {
  let from = start;
  let to = end;
  if (from !== null && to !== null && to < from) [from, to] = [to, from];
  const min = Number(slider.min) || 0;
  const max = Number(slider.max) || endSeconds;
  const span = Math.max(0.001, max - min);
  const at = (seconds) => 'calc(8px + (100% - 16px) * ' + ((seconds - min) / span).toFixed(5) + ')';
  const inRange = (seconds) => seconds !== null && seconds >= min && seconds <= max;
  [['cut-start-mark', from, 'Clip start'], ['cut-end-mark', to, 'Clip end']].forEach(([id, seconds, label]) => {
    const mark = $(id);
    mark.hidden = !inRange(seconds);
    if (mark.hidden) return;
    mark.style.left = at(seconds);
    mark.title = label + ' ' + fmt(seconds) + ' (click to go there)';
  });
  const band = $('cut-band');
  band.hidden = from === null || to === null || to <= min || from >= max;
  if (!band.hidden) {
    const left = Math.max(from, min);
    const right = Math.min(to, max);
    band.style.left = at(left);
    band.style.width = 'calc((100% - 16px) * ' + ((right - left) / span).toFixed(5) + ')';
  }
}
$('cut-start-mark').addEventListener('click', () => { if (start !== null) showPosition(Math.min(start, end ?? start)); });
$('cut-end-mark').addEventListener('click', () => { if (end !== null) showPosition(Math.max(end, start ?? end)); });
// The clip range (set with ✂⟦ ⟧✂, refined and downloaded with 🎬): shown on the toolbar buttons' tooltips and on
// the thumbnails, and kept in the address bar.
function update() {
  let from = start;
  let to = end;
  if (from !== null && to !== null && to < from) [from, to] = [to, from];
  const ready = from !== null && to !== null && Math.floor(to) > Math.floor(from);
  $('set-start').title = 'Clip starts here' + (from !== null ? ' (now ' + fmt(from) + ')' : '');
  $('set-end').title = 'Clip ends here' + (to !== null ? ' (now ' + fmt(to) + ')' : '');
  $('clip-open').title = ready ? 'Refine and download the clip ' + fmt(from) + '-' + fmt(to) : 'Refine the clip and download it';
  renderCutMarks();
  scheduleQueryUpdate();
  document.querySelectorAll('.grid button').forEach((button) => {
    const seconds = Number(button.dataset.seconds);
    button.classList.toggle('is-start', from !== null && Math.abs(seconds - from) < 0.5);
    button.classList.toggle('is-end', to !== null && Math.abs(seconds - to) < 0.5);
    button.classList.toggle('in-range', ready && seconds > from && seconds < to);
  });
}


function renderGrid() {
  const maxLevel = Number($('density').value);
  const grid = $('grid');
  grid.textContent = '';
  thumbs.forEach((item) => {
    if (item.l > maxLevel) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.seconds = item.s;
    button.title = 'Go to ' + fmt(item.s);
    button.innerHTML = '<img loading="lazy" alt="" src="' + item.f + '"><span>' + fmt(item.s) + (item.c ? ' · ' + item.c : '') + '</span>';
    button.addEventListener('click', () => { showPosition(item.s); window.scrollTo({ top: 0, behavior: 'smooth' }); });
    grid.appendChild(button);
  });
  update();
}
