// The review page's HTML: the player, toolbar, panels, and dialogs (styles.css and client/ are added around it by
// page.js). playback carries the few values shown in it.
export function renderMarkup(playback, escapeText) {
  return `</head>
<body>
<main>
<div class="player-layout">
<div class="player-main">
<div class="stage" id="stage">
  <img id="frame" alt="">
  <video id="video" hidden playsinline preload="none"></video>
  <canvas class="freeze" id="freeze" hidden></canvas>
  <div class="stage-play" id="stage-play" aria-hidden="true">▶︎</div>
  <canvas class="magnifier" id="magnifier"></canvas>
  <div class="zoom-select" id="zoom-select" hidden></div>
  <div class="title-overlay movable" id="title-overlay" hidden></div>
  <div class="agenda-overlay movable" id="agenda-overlay" hidden></div>
  <div class="vote-overlay movable" id="vote-overlay" hidden></div>
  <div class="speaker-cards movable" id="speaker-cards" hidden></div>
  <div class="overlay movable" id="overlay" hidden><span id="overlay-clock"></span><small id="overlay-position"></small></div>
</div>
<div class="scrub">
  <button type="button" id="scope-toggle" title="The scrubber covers the whole meeting: click to cover only the current chapter">↔ All</button>
  <div class="track">
    <div class="scrub-marks" id="scrub-marks" hidden>
      <div class="lane speakers-lane" id="marks-speakers"></div>
      <div class="lane events-lane" id="marks-events"></div>
    </div>
    <div class="slider-wrap">
      <div class="cut-band" id="cut-band" hidden></div>
      <button type="button" class="cut-mark start-mark" id="cut-start-mark" hidden>▼</button>
      <button type="button" class="cut-mark end-mark" id="cut-end-mark" hidden>▼</button>
      <input id="slider" type="range" min="0" value="0" step="0.1" aria-label="Video position">
    </div>
  </div>
</div>
<div class="toolbar" id="toolbar" role="toolbar" aria-label="Player">
  <a class="home" id="home" href="/" title="The streamscribe library" aria-label="Library" hidden>🏠</a>
  <button type="button" id="play" title="Play or pause (Space)" aria-label="Play">▶︎</button>
  <input type="text" class="position" id="position" value="00:00:00" spellcheck="false" autocomplete="off" aria-label="Video position" title="Type a time and press Enter to go there: 1:04:44, 64:44, seconds, or a time of day such as 2:19 PM">
  <button type="button" id="live-edge" class="live-edge" hidden title="Still being captured: jump to the latest moment">● Live</button>
  <button type="button" id="prev-frame" title="Previous frame (,)" aria-label="Previous frame" hidden>◀</button>
  <button type="button" id="next-frame" title="Next frame (.)" aria-label="Next frame" hidden>▶</button>
  <span class="sep"></span>
  <span class="button-group">
    <button id="set-start" type="button" title="Clip starts here" aria-label="Clip start">✂⟦</button>
    <button type="button" id="clip-open" title="Refine the clip and download it" aria-label="Download clip">🎬</button>
    <button id="set-end" type="button" title="Clip ends here" aria-label="Clip end">⟧✂</button>
  </span>
  <button type="button" id="playlist-add" title="Add the clip (between ✂⟦ and ⟧✂) to the playlist" aria-label="Add clip to playlist">➕</button>
  <button type="button" id="boost-open" title="Boost the volume of the clip (or the next 30 seconds) and transcribe it again" aria-label="Boost and re-transcribe">🔊</button>
  <span class="sep"></span>
  <button type="button" id="snapshot" title="Save this frame as an image" aria-label="Save this frame as an image">📷</button>
  <button type="button" id="frames-toggle" title="Show the frames around this moment" aria-label="Frames around this moment" hidden>🎞</button>
  <span class="sep"></span>
  <span class="button-group">
    <button type="button" id="speaker-prev" title="Previous speaker change" aria-label="Previous speaker change">◀</button>
    <button type="button" id="speakers-toggle" title="Mark who is speaking" aria-label="Speakers">🗣️</button>
    <button type="button" id="speaker-next" title="Next speaker change" aria-label="Next speaker change">▶</button>
  </span>
  <span class="button-group">
    <button type="button" id="chapter-prev" title="Previous chapter" aria-label="Previous chapter">◀</button>
    <button type="button" id="chapters-toggle" title="Show or hide the chapters" aria-label="Chapters">📑</button>
    <button type="button" id="chapter-next" title="Next chapter" aria-label="Next chapter">▶</button>
  </span>
  <span class="button-group">
    <button type="button" id="vote-prev" title="Previous vote" aria-label="Previous vote">◀</button>
    <button type="button" id="votes-toggle" title="Show or hide the votes" aria-label="Votes">🗳</button>
    <button type="button" id="vote-next" title="Next vote" aria-label="Next vote">▶</button>
  </span>
  <button type="button" id="playlist-toggle" title="Show or hide the playlist of clips" aria-label="Playlist">📼</button>
  <button type="button" id="zoom-toggle" title="Magnify: drag a square on the video to show it larger in place (press again to remove it)" aria-label="Magnify">🔍</button>
  <button type="button" id="display-open" title="What to show on the video, and playback settings" aria-label="Display settings">🎛</button>
  <span class="label boost-active" id="boost-active"></span>
  <span class="label status" id="snapshot-status" role="status"></span>
</div>
<div class="frames-panel" id="frames-panel" hidden>
  <div class="row">
    <label for="frame-spacing" class="label">Frames around this moment, spaced</label>
    <select id="frame-spacing">
      <option value="1">1 frame apart</option>
      <option value="5">5 frames apart</option>
      <option value="15">15 frames apart (½ second)</option>
    </select>
    <button type="button" id="frames-refresh">Re-center here</button>
    <span class="label" id="frames-status" role="status"></span>
  </div>
  <div class="frames" id="frames"></div>
  <p class="hint">Click a frame to jump to it, then press 📷 to save it. ◀ ▶ (or the , and . keys) step one frame.</p>
</div>
<div class="speakers-panel" id="speakers-panel" hidden title="Click people to mark who is speaking from this moment on (click again to unmark). Drag them onto a section to group them; dropping on Voting members makes them vote in this meeting.">
  <div class="people-toolbar">
    <strong>Speaking:</strong> <span id="speakers-now"></span>
    <span style="flex: 1"></span>
    <button type="button" id="people-names" title="Show names and titles">🪪 Names</button>
    <button type="button" id="people-icons" title="Show photos only">🙂 Icons</button>
    <button type="button" id="group-add" title="Add a group, such as VDOT">➕ Group</button>
  </div>
  <div class="people" id="people"></div>
  <p class="hint" id="people-empty">No people yet. Pause on someone while they speak and press Add person.</p>
  <div class="row">
    <button type="button" id="person-add">➕ Add person</button>
    <button type="button" id="speaker-none">Nobody</button>
    <button type="button" id="speaker-remove">Remove the change here</button>
    <span class="label" id="speakers-status" role="status"></span>
  </div>
</div>
<section class="agenda-panel" id="agenda-panel" aria-labelledby="agenda-title">
  <h2 id="agenda-title">Chapters</h2>
  <ol class="agenda-list" id="agenda-list"></ol>
  <p class="hint" id="agenda-empty">No chapters yet. Move to where one starts (an agenda item, for example), type its title, and press Add.</p>
  <form class="row" id="agenda-form">
    <input type="text" id="agenda-time" class="time" placeholder="HH:MM:SS" aria-label="Chapter start time">
    <button type="button" id="agenda-now" title="Use the current position">⏱ Now</button>
    <input type="text" id="agenda-title-input" placeholder="Chapter title, such as 4. Public Comment Period" aria-label="Chapter title">
    <button type="submit" class="start" id="agenda-save">Add</button>
    <button type="button" id="agenda-cancel" hidden>Cancel</button>
    <span class="label" id="agenda-status" role="status"></span>
  </form>
</section>
<section class="agenda-panel" id="playlist-panel" aria-labelledby="playlist-title" hidden>
  <h2 id="playlist-title">Playlist <small class="label" id="playlist-total"></small></h2>
  <ol class="agenda-list" id="playlist-list"></ol>
  <p class="hint" id="playlist-empty">No clips yet. Mark a clip with ✂⟦ and ⟧✂, then press ➕ to add it here; mark the next one, and so on.</p>
  <div class="row">
    <button type="button" id="playlist-play" title="Play the clips one after another">▶ Play all</button>
    <button type="button" class="start" id="playlist-video" title="Join the clips into one video and download it">⬇ Video</button>
    <button type="button" id="playlist-text" title="Download what is said in the clips, as text">⬇ Transcript</button>
    <button type="button" id="playlist-captions" title="Download closed captions timed to the playlist video (.srt, for YouTube)">⬇ Captions (.srt)</button>
    <span class="label" id="playlist-status" role="status"></span>
  </div>
</section>
<section class="agenda-panel" id="votes-panel" aria-labelledby="votes-title">
  <h2 id="votes-title">Votes</h2>
  <ol class="agenda-list" id="vote-list"></ol>
  <p class="hint" id="votes-empty">No votes yet. Check the voting members first, then move to a vote and press Record a vote here.</p>
  <div class="row">
    <button type="button" class="start" id="vote-start" title="A vote starts now: then click members on the video as they vote">🗳＋ Vote starts now</button>
    <button type="button" id="vote-add">✎ Record a vote here</button>
    <button type="button" id="members-toggle">Voting members…</button>
    <span class="label" id="votes-status" role="status"></span>
  </div>
  <div id="members-panel" hidden>
    <p class="hint">Check the people who vote in this meeting (add people with 🗣️ Speakers first). If someone leaves early, move to that moment and press Left here; votes after it start them as absent (Arrived here does the same for someone who comes late).</p>
    <ul class="member-list" id="member-list"></ul>
    <h3 class="label">Seating order, left to right as they appear on camera</h3>
    <ol class="seat-order" id="seat-order"></ol>
    <div class="row">
      <label class="label">Seats <input type="number" id="vote-seats" min="1" max="50" placeholder="auto"></label>
      <label class="label">Ayes needed to pass <input type="number" id="vote-needed" min="1" max="50" placeholder="auto"></label>
      <span class="hint" id="vote-rule"></span>
    </div>
  </div>
</section>
<div class="note" id="file-note" hidden></div>
${playback.fullMeetingUrl ? `<p class="hint">This is one part of the meeting as it was captured live. <a href="${escapeText(playback.fullMeetingUrl)}">Open the full meeting</a> (live capture joined with the county's archive).</p>` : ''}
</div>
<aside class="transcript" id="transcript" aria-label="Transcript" hidden>
  <div class="transcript-body">
  <figure class="now-scene" id="now-scene" hidden title="Go to this camera or slide change">
    <img id="now-scene-image" alt="">
    <select class="view-chip" id="view-select" title="Which camera view this is (zoom areas belong to a view)" aria-label="Camera view"></select>
    <figcaption id="now-scene-time"></figcaption>
    <div class="figure-speakers" id="now-speakers"></div>
  </figure>
  <div class="transcript-head">
    <input type="text" id="find" placeholder="Find in transcript" aria-label="Find in transcript" title="Enter for the next result, Shift+Enter for the previous">
    <span class="button-group find-buttons">
      <button type="button" id="find-prev" title="Previous result (Shift+Enter)" aria-label="Previous result">◀</button>
      <button type="button" id="find-next" title="Next result (Enter)" aria-label="Next result">▶</button>
    </span>
    <span class="label" id="find-status"></span>
    <button type="button" id="transcript-download" title="Download the transcript as text (whole meeting or this chapter)" aria-label="Download transcript">⬇</button>
    <select id="transcript-choice" hidden title="Which transcript to show" aria-label="Transcript">
      <option value="latest">Transcript</option>
      <option value="best">Best (word times)</option>
    </select>
  </div>
  <div class="transcript-list" id="transcript-list"></div>
  </div>
</aside>
</div>


<div class="row">
  <h2 class="grid-title">Thumbnails</h2>
  <label for="density" class="label">Show</label>
  <select id="density">
    <option value="0">every 5 minutes</option>
    <option value="1" selected>every 2.5 minutes</option>
    <option value="2">every 75 seconds</option>
    <option value="3">every 37.5 seconds</option>
    <option value="99">all</option>
  </select>
</div>
<div class="grid" id="grid"></div>
</main>
<dialog id="boost-dialog">
  <form id="boost-form">
    <h2>Boost the audio and transcribe again</h2>
    <p class="hint">For stretches where the speaker's microphone was off and others barely picked them up. Adjust and listen, then send it to the local server, which applies the same adjustment and transcribes the portion again. The new lines replace the old ones in that range (the original transcript is kept, and Undo puts it back).</p>
    <div class="row">
      <label>From <input type="text" id="boost-from" placeholder="HH:MM:SS"></label>
      <label>To <input type="text" id="boost-to" placeholder="HH:MM:SS"></label>
      <span class="label" id="boost-length"></span>
    </div>
    <div class="wave">
      <canvas id="boost-wave" height="110" aria-label="Waveform of the portion: drag the edges to refine it"></canvas>
      <div class="wave-labels"><span id="wave-start"></span><span id="wave-status" class="hint">Drag the green (start) and red (end) edges to refine the portion; click elsewhere to move the nearer edge.</span><span id="wave-end"></span></div>
      <button type="button" id="wave-reload" title="Load the waveform around the current range">↻ Waveform</button>
    </div>
    <div class="row">
      <label>Volume boost <input type="range" id="boost-gain" min="-6" max="36" step="1" value="12"> <span id="boost-gain-value" class="position">+12 dB</span></label>
    </div>
    <div class="row">
      <label><input type="checkbox" id="boost-normalize" checked> Even out loudness (quiet voices up, loud ones down)</label>
    </div>
    <div class="row">
      <label><input type="checkbox" id="boost-highpass" checked> Cut low rumble (below 120 Hz)</label>
      <label><input type="checkbox" id="boost-denoise"> Reduce steady background noise (heard in the server's version only)</label>
    </div>
    <div class="row">
      <button type="button" id="boost-preview">▶ Listen here</button>
      <button type="button" id="boost-render">🎧 Hear the server's version</button>
      <span class="label">Listen here plays the video with the boost applied live (close to the result); the server's version is exact.</span>
    </div>
    <audio id="boost-audio" controls hidden></audio>
    <div class="row">
      <label>Transcription <select id="boost-quality"><option value="thorough">thorough</option><option value="quick">quick</option></select></label>
      <button type="submit" class="start" id="boost-send">Re-transcribe this portion</button>
      <label><input type="checkbox" id="boost-keep" checked> and boost it during playback</label>
      <button type="button" id="boost-save">💾 Only save as a playback boost</button>
      <button type="button" id="boost-close">Close</button>
    </div>
    <p class="label" id="boost-status" role="status"></p>
    <h2>Playback boosts</h2>
    <p class="hint">Played wherever they apply while "Boost quiet speakers" (beside the video) is checked.</p>
    <ul class="portions" id="boost-saved"></ul>
    <h2>Re-transcribed portions</h2>
    <ul class="portions" id="boost-portions"></ul>
  </form>
</dialog>
<dialog id="display-dialog">
  <form method="dialog">
    <h2>On the video</h2>
    <div class="settings">
      <label>🕐 <select id="overlay-mode" aria-label="Clock and video time">
        <option value="none">no clock</option>
        <option value="clock">clock</option>
        <option value="position">video time</option>
        <option value="both">clock and video time</option>
      </select> <input type="range" min="50" max="250" step="10" value="100" data-size="clock" aria-label="Clock text size"> <span class="size"></span></label>
      <label><input type="checkbox" id="show-name"> 🏷 Meeting name <input type="range" min="50" max="250" step="10" value="100" data-size="title" aria-label="Meeting name text size"> <span class="size"></span></label>
      <label><input type="checkbox" id="show-agenda"> 📑 Chapter <input type="range" min="50" max="250" step="10" value="100" data-size="chapter" aria-label="Chapter text size"> <span class="size"></span></label>
      <label><input type="checkbox" id="show-speakers"> 🗣️ Speakers <input type="range" min="50" max="250" step="10" value="100" data-size="speakers" aria-label="Speakers text size"> <span class="size"></span></label>
      <label><input type="checkbox" id="show-votes"> 🗳 Votes <input type="range" min="50" max="250" step="10" value="100" data-size="votes" aria-label="Votes text size"> <span class="size"></span></label>
    </div>
    <p class="hint">Drag any overlay on the video to move it. Click the meeting name, chapter, or a vote's motion to edit it.</p>
    <div class="row"><button type="button" id="layout-reset">Reset sizes and positions</button></div>
    <h2>Playback</h2>
    <div class="settings">
      <label><input type="checkbox" id="play-boosts"> 🔊 Boost quiet speakers <span class="hint">where boosts were saved in Boost &amp; re-transcribe</span></label>
      <label><input type="checkbox" id="auto-zoom"> 🔍 Magnify whoever is speaking <span class="hint">where the camera view has zoom areas</span></label>
    </div>
    <div class="row"><button value="done" class="start">Done</button></div>
  </form>
</dialog>
<dialog id="spoke-dialog">
  <h2 id="spoke-title">When they spoke</h2>
  <div class="row">
    <span class="button-group">
      <button type="button" id="spoke-prev" title="Previous time they spoke">◀</button>
      <button type="button" id="spoke-next" title="Next time they spoke">▶</button>
    </span>
    <span class="label" id="spoke-summary"></span>
  </div>
  <div class="spoke-bar" id="spoke-bar" title="Their speaking across the meeting: click to jump"></div>
  <ol class="agenda-list" id="spoke-list"></ol>
  <div class="row"><button type="button" id="spoke-close">Close</button></div>
</dialog>
<dialog id="clip-dialog">
  <form method="dialog" onsubmit="return false">
    <h2>Download clip</h2>
    <div class="row">
      <label class="label">From <input type="text" id="clip-from" class="time" placeholder="HH:MM:SS"></label>
      <label class="label">To <input type="text" id="clip-to" class="time" placeholder="HH:MM:SS"></label>
      <span class="label" id="clip-length"></span>
    </div>
    <div class="wave">
      <canvas id="clip-strip" class="strip" height="54" aria-label="Frames across the same stretch: drag the edges to refine the clip"></canvas>
      <canvas id="clip-wave" height="110" aria-label="Waveform of the clip: drag the edges to refine it"></canvas>
      <div class="wave-labels"><span id="clip-wave-start"></span><span id="clip-wave-status" class="hint"></span><span id="clip-wave-end"></span></div>
      <div class="row">
        <span class="button-group">
          <button type="button" id="clip-zoom-out" title="Zoom out (or scroll down over the waveform)" aria-label="Zoom out">−</button>
          <button type="button" id="clip-zoom-in" title="Zoom in around the clip (or scroll up over the waveform)" aria-label="Zoom in">+</button>
        </span>
        <button type="button" id="clip-wave-reload" title="Load the waveform around the current range">↻ Waveform</button>
      </div>
    </div>
    <div class="row">
      <button type="button" id="clip-preview">▶ Play clip</button>
      <label class="label" title="When playback reaches the end of the clip, start again from the beginning"><input type="checkbox" id="clip-loop"> 🔁 Loop</label>
      <label class="label"><input type="checkbox" id="clip-accurate"> Frame-exact (slower)</label>
      <label class="label" title="Plays the clip and records it with the overlays drawn on, as shown on the video (takes as long as the clip)"><input type="checkbox" id="clip-overlays"> Include the overlays</label>
      <span style="flex: 1"></span>
      <button type="button" class="start" id="clip-download">⬇ Download</button>
      <button type="button" id="clip-close">Close</button>
    </div>
    <p class="label" id="clip-status" role="status"></p>
  </form>
</dialog>
<dialog id="zoom-dialog">
  <form id="zoom-form">
    <h2 id="zoom-title">Zoom areas</h2>
    <div class="row">
      <label class="label">View <input type="text" id="zoom-view-name" autocomplete="off"></label>
      <button type="button" class="end" id="zoom-view-delete">Delete this view</button>
    </div>
    <p class="hint">Pick a person and drag a square around where they sit; a larger copy appears. Switch between ▢ Where they sit and ⧉ Larger copy to move (drag inside) or resize (drag a corner or edge) either one. With 🔍 Magnify whoever is speaking turned on (in 🎛), their larger copy fades in while they talk whenever the camera is on this view, and fades out a few seconds after they stop.</p>
    <div class="zoom-people" id="zoom-people"></div>
    <div class="row">
      <span class="label">Editing</span>
      <span class="button-group">
        <button type="button" id="zoom-edit-source" title="The square around where they sit (drag on an empty spot to draw a new one)">▢ Where they sit</button>
        <button type="button" id="zoom-edit-copy" title="The larger copy shown while they speak">⧉ Larger copy</button>
      </span>
      <span class="hint">Drag inside the box to move it; drag a corner or edge to resize it.</span>
    </div>
    <canvas id="zoom-canvas"></canvas>
    <div class="row">
      <button type="button" id="zoom-area-remove">Remove this person's box</button>
      <button type="button" id="zoom-frame">📷 Use the current video frame</button>
      <span style="flex: 1"></span>
      <button type="submit" class="start">Save</button>
      <button type="button" id="zoom-cancel">Cancel</button>
      <span class="label" id="zoom-status" role="status"></span>
    </div>
  </form>
</dialog>
<dialog id="vote-dialog">
  <form id="vote-form">
    <h2 id="vote-dialog-title">Record a vote</h2>
    <div class="row">
      <label class="label">Time <input type="text" id="vote-time" class="time" placeholder="HH:MM:SS"></label>
      <button type="button" id="vote-now">⏱ Now</button>
      <label class="label">Show on the video for <input type="number" id="vote-show" min="3" max="600" value="20"> seconds</label>
    </div>
    <div class="row"><label class="label" style="flex: 1">Motion <input type="text" id="vote-motion" placeholder="Motion to approve the consent agenda" autocomplete="off"></label></div>
    <div class="row">
      <label class="label">Moved by <select id="vote-moved-by"></select></label>
      <label class="label">at <input type="text" id="vote-moved-at" class="time" placeholder="HH:MM:SS"></label>
      <button type="button" id="vote-moved-now">⏱ Now</button>
    </div>
    <div class="row">
      <label class="label">Seconded by <select id="vote-seconded-by"></select></label>
      <label class="label">at <input type="text" id="vote-seconded-at" class="time" placeholder="HH:MM:SS"></label>
      <button type="button" id="vote-seconded-now">⏱ Now</button>
    </div>
    <p class="hint">This panel stays open while you play or scrub the video: find the motion or second and press ⏱ Now. Picking a person fills in when they last started speaking before the vote.</p>
    <p class="hint">Roll call: as each member votes, pause or play to that moment and click them. Each click records their vote at that moment, cycling aye → nay → abstain → absent → not voted (clicks within a couple of seconds change the same entry).</p>
    <div id="vote-members"></div>
    <div class="row">
      <button type="button" id="vote-all-for">Everyone present: aye, now</button>
      <label class="label">Outcome <select id="vote-outcome">
        <option value="auto">automatic</option>
        <option value="passed">passed</option>
        <option value="failed">failed</option>
      </select></label>
    </div>
    <p><strong id="vote-tally"></strong></p>
    <div class="row">
      <button type="submit" class="start">Save</button>
      <button type="button" id="vote-cancel">Cancel</button>
      <button type="button" class="end" id="vote-delete" hidden>Remove this vote</button>
      <span class="label" id="vote-dialog-status" role="status"></span>
    </div>
  </form>
</dialog>
<dialog id="person-dialog">
  <form id="person-form">
    <h2 id="person-title">Add a person</h2>
    <div class="row">
      <label class="label">Name <input type="text" id="person-name" autocomplete="off"></label>
      <label class="label"><input type="checkbox" id="person-unknown"> Name not known <span class="hint">(shows the role instead)</span></label>
      <label class="label">Role <input type="text" id="person-role" list="roles" placeholder="Supervisor, Fork District" autocomplete="off"></label>
      <label class="label">Group <input type="text" id="person-group" list="group-list" placeholder="Residents" autocomplete="off"></label>
      <label class="label" title="An emoji shown instead of a photo, for an entry that stands for several people (such as everyone reciting the Pledge)">Icon <input type="text" id="person-icon" maxlength="8" placeholder="👥" autocomplete="off" style="width: 4em; min-width: 0"></label>
      <datalist id="group-list"></datalist>
    </div>
    <datalist id="roles">
      <option value="Chair"><option value="Vice Chair"><option value="Supervisor"><option value="County Administrator">
      <option value="Deputy County Administrator"><option value="County Attorney"><option value="Clerk"><option value="Sheriff">
      <option value="Staff"><option value="Presenter"><option value="Public speaker"><option value="Mayor"><option value="Town Council">
    </datalist>
    <img id="person-photo" alt="Current photo" hidden>
    <canvas id="crop-canvas" hidden></canvas>
    <div class="row">
      <button type="button" id="crop-capture">📷 Use the current video frame</button>
      <button type="button" id="photo-none" title="For someone who isn't on screen: no photo, just initials">🚫 No photo</button>
      <label class="label">Circle size <input type="range" id="crop-size" min="16" max="540" value="90"></label>
    </div>
    <p class="hint">Drag the circle onto their face (or click where it should go); the slider or mouse wheel resizes it. Pause on a clear view of them first.</p>
    <div class="row">
      <button type="submit" class="start" id="person-save">Save</button>
      <button type="button" id="person-cancel">Cancel</button>
      <button type="button" class="end" id="person-delete" hidden>Remove from the list</button>
      <span class="label" id="person-status" role="status"></span>
    </div>
  </form>
</dialog>
`;
}
