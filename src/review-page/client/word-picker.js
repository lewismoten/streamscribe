// Who starts speaking at a word: clicking a word opens this. Picking a face makes that person the speaker from the
// word on (Cmd/Ctrl-click to pick several people speaking together); Nobody marks silence or no one in particular.
const wordPicker = document.createElement('div');
wordPicker.className = 'word-picker';
wordPicker.hidden = true;
document.body.appendChild(wordPicker);
let pickerSelection = [];
function openWordPicker(word, anchor) {
  const existing = turns.find((turn) => Math.abs(turn.at - word.at) < 0.06);
  const current = speakersAt(word.at);
  pickerSelection = [];
  wordPicker.textContent = '';
  const head = document.createElement('div');
  head.className = 'picker-head';
  head.textContent = '“' + (word.edited ? (word.display || word.original) : word.text) + '” at ' + fmt(word.at) + ' — who starts speaking here?';
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '✕';
  close.title = 'Close (Escape)';
  close.addEventListener('click', closeWordPicker);
  head.appendChild(close);
  wordPicker.appendChild(head);
  // Correct the word: change it, type more words to add after it, delete it, or restore what was transcribed.
  const editRow = document.createElement('form');
  editRow.className = 'picker-edit';
  const input = document.createElement('input');
  input.type = 'text';
  input.value = word.edited ? word.display : word.text;
  input.setAttribute('aria-label', 'Correct this word');
  input.title = 'Correct the word (type more words to add them after it), then Enter';
  const save = document.createElement('button');
  save.type = 'submit';
  save.textContent = '✎ Correct';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.textContent = '🗑';
  remove.title = 'Delete this word';
  remove.addEventListener('click', () => { saveWordEdit(word, ''); closeWordPicker(); });
  editRow.append(input, save, remove);
  if (word.edited) {
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.textContent = '↺';
    restore.title = 'Restore “' + word.original + '” as transcribed';
    restore.addEventListener('click', () => { saveWordEdit(word, word.original); closeWordPicker(); });
    editRow.appendChild(restore);
  }
  editRow.addEventListener('submit', (event) => {
    event.preventDefault();
    saveWordEdit(word, input.value.split(' ').filter(Boolean).join(' '));
    closeWordPicker();
  });
  wordPicker.appendChild(editRow);
  const choose = (id, event) => {
    if (event.metaKey || event.ctrlKey) {
      pickerSelection = pickerSelection.includes(id) ? pickerSelection.filter((item) => item !== id) : [...pickerSelection, id];
      wordPicker.querySelectorAll('[data-id]').forEach((button) => button.classList.toggle('picked', pickerSelection.includes(button.dataset.id)));
      setSpeakersAt(word.at, pickerSelection, 0.05);
    } else {
      setSpeakersAt(word.at, [id], 0.05);
      closeWordPicker();
    }
  };
  const faceRow = (title, ids) => {
    if (!ids.length) return null;
    const block = document.createElement('div');
    block.className = 'picker-row';
    const label = document.createElement('small');
    label.textContent = title;
    block.appendChild(label);
    const faces = document.createElement('div');
    faces.className = 'picker-faces';
    ids.forEach((id) => {
      const person = peopleMap.get(id) || { id, name: id };
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.id = id;
      button.title = nameAndRole(person) + (current.includes(id) ? ' (speaking here now)' : '');
      if (current.includes(id)) button.classList.add('current');
      const name = document.createElement('small');
      name.textContent = lastName(person);
      button.append(avatar(person), name);
      button.addEventListener('click', (event) => choose(id, event));
      faces.appendChild(button);
    });
    block.appendChild(faces);
    wordPicker.appendChild(block);
    return block;
  };
  const voting = voteData.members.map((member) => member.id).filter((id) => peopleMap.has(id));
  const spoken = [...new Set(turns.flatMap((turn) => turn.speakers))].filter((id) => !voting.includes(id) && peopleMap.has(id));
  const others = people.map((person) => person.id).filter((id) => !voting.includes(id) && !spoken.includes(id));
  faceRow('Voting members', voting);
  faceRow('Spoke in this meeting', spoken);
  if (others.length) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'picker-more';
    more.textContent = 'Everyone else (' + others.length + ')…';
    more.addEventListener('click', () => {
      const row = faceRow('Everyone else', others);
      if (row) wordPicker.insertBefore(row, more);
      more.remove();
      placePicker(anchor);
    });
    wordPicker.appendChild(more);
  }
  const actions = document.createElement('div');
  actions.className = 'picker-actions';
  const nobody = document.createElement('button');
  nobody.type = 'button';
  nobody.textContent = 'Nobody';
  nobody.title = 'No one (or no one in particular) speaks from this word';
  nobody.addEventListener('click', () => { setSpeakersAt(word.at, [], 0.05); closeWordPicker(); });
  actions.appendChild(nobody);
  if (existing) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove the change here';
    remove.addEventListener('click', () => {
      turns = turns.filter((turn) => turn !== existing);
      speakersChanged();
      saveTurns();
      closeWordPicker();
    });
    actions.appendChild(remove);
  }
  const hint = document.createElement('small');
  hint.textContent = 'Cmd/Ctrl-click to pick several';
  actions.appendChild(hint);
  wordPicker.appendChild(actions);
  wordPicker.hidden = false;
  placePicker(anchor);
}
function placePicker(anchor) {
  const rect = anchor.getBoundingClientRect();
  const width = wordPicker.offsetWidth;
  const height = wordPicker.offsetHeight;
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.left - width / 2 + rect.width / 2));
  const below = rect.bottom + 6;
  wordPicker.style.left = left + 'px';
  wordPicker.style.top = (below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 6) : below) + 'px';
}
function closeWordPicker() { wordPicker.hidden = true; }
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !wordPicker.hidden) closeWordPicker(); });
document.addEventListener('mousedown', (event) => {
  if (!wordPicker.hidden && !wordPicker.contains(event.target) && !event.target.classList?.contains('w')) closeWordPicker();
});
['wheel', 'touchmove', 'keydown'].forEach((type) => transcriptList.addEventListener(type, () => { userScrolledAt = Date.now(); }, { passive: true }));
transcriptList.addEventListener('mousedown', (event) => { if (event.target === transcriptList) userScrolledAt = Date.now(); });

