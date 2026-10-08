import path from 'path';
import { LOCALE } from '../config/runtime-config.js';
import { escapeHtml } from '../util/html.js';
import { formatPosition } from '../transcription/transcript.js';

// Contact sheet (index.html) for a session's slides/ folder, written by extract-slides and
// rebuilt by split-session.
export function renderContactSheet(slides, sessionDir) {
  const clock = (iso) =>
    iso
      ? new Intl.DateTimeFormat('en-US', {
          timeZone: LOCALE.timeZone,
          hour: 'numeric',
          minute: '2-digit',
          second: '2-digit'
        }).format(new Date(iso))
      : '';
  const cards = slides
    .map((slide) => {
      const times = slide.showings
        .map(
          (showing) =>
            `${formatPosition(showing.startSeconds)}${showing.clockTime ? ` (~${clock(showing.clockTime)})` : ''}, ${Math.round(showing.durationSeconds)}s`
        )
        .join('<br>');
      return `<figure><a href="${escapeHtml(slide.fileName)}"><img src="${escapeHtml(slide.fileName)}" alt="Slide ${slide.number}" loading="lazy"></a><figcaption><strong>Slide ${slide.number}</strong><br>${times}</figcaption></figure>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Meeting Slides</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f6f4; --fg: #1d1d1b; --muted: #66665f; --card: #ffffff; --line: #d9d9d3; }
  @media (prefers-color-scheme: dark) { :root { --bg: #161615; --fg: #ececea; --muted: #a2a29b; --card: #222220; --line: #3a3a37; } }
  body { margin: 0; padding: 24px 16px; background: var(--bg); color: var(--fg); font: 15px/1.45 system-ui, sans-serif; }
  h1 { margin: 0 0 4px; font-size: 1.4rem; }
  p { margin: 0 0 20px; color: var(--muted); overflow-wrap: anywhere; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
  figure { margin: 0; background: var(--card); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
  img { display: block; width: 100%; height: auto; }
  figcaption { padding: 10px 12px; font-size: 0.9rem; color: var(--muted); }
  figcaption strong { color: var(--fg); }
</style>
</head>
<body>
<h1>Meeting Slides</h1>
<p>${slides.length} slides from ${escapeHtml(path.basename(sessionDir))}. Times are video positions (matching the transcript) and approximate time of day.</p>
<div class="grid">
${cards}
</div>
</body>
</html>
`;
}
