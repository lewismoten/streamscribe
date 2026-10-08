// Captions for the player: a part's transcript as shown (corrections and speaker names applied) written as WebVTT,
// one cue per line, named for its speaker when it's known.
export interface CaptionLine {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

// Seconds as WebVTT writes them: HH:MM:SS.mmm.
export function vttTime(seconds: number) {
  const millis = Math.max(0, Math.round(seconds * 1000));
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  const hours = Math.floor(millis / 3_600_000);
  const minutes = Math.floor(millis / 60_000) % 60;
  const secs = Math.floor(millis / 1000) % 60;
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}.${pad(millis % 1000, 3)}`;
}

// Cue text can't hold "&", "<", or ">" as they are (they start entities and tags), nor a blank line (it ends the cue).
const cueText = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll(/\n\s*\n/g, '\n');

export function captionsVtt(lines: CaptionLine[]) {
  const cues = lines
    .filter((line) => line.text.trim())
    .map((line) => {
      // A cue must end after it starts.
      const end = Math.max(line.end, line.start + 0.01);
      const text = cueText(line.text.trim());
      const spoken = line.speaker ? `<v ${cueText(line.speaker)}>${text}` : text;
      return `${vttTime(line.start)} --> ${vttTime(end)}\n${spoken}`;
    });
  return ['WEBVTT', ...cues].join('\n\n') + '\n';
}
