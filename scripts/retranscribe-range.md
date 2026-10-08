# retranscribe-range

Script: [`retranscribe-range.js`](retranscribe-range.js)

Command:

```bash
npm run retranscribe-range -- --session <folder> --from 00:21:33 --to 00:24:00 [--gain 12] [--highpass 120] [--normalize] [--denoise] [--quality thorough|quick] [--preview] [--remove <portion id>]
```

Boosts the audio of part of a live session (or a full meeting from [`build-meeting`](build-meeting.md)) and transcribes that part again. Use it when a speaker's microphone was off and the other microphones barely picked them up. Usually you start it from the thumbnails page instead: set the clip with ✂⟦ and ⟧✂, then press **🔊** in the toolbar.

1. Pulls the audio for the range. Each segment is decoded on its own, so stray packets and switches between the live capture and the archive don't matter, and moments that weren't captured become silence so the times stay right.
2. Applies the adjustment with ffmpeg, in this order:
   - `--highpass` cuts low rumble (Hz)
   - `--denoise` reduces steady background noise
   - `--gain` boosts the volume (dB)
   - `--normalize` evens out loudness, bringing quiet stretches up and loud ones down
   - a limiter always runs last, so a large boost never clips
3. With `--preview`, it only saves the adjusted audio to `{session}/retranscribe/previews/` to listen to. With `--clip` (and `--accurate` for frame-exact), it only cuts the range as an MP4 into `{session}/clips/` with [`extract-clip`](extract-clip.md), for the thumbnails page's Download clip dialog. With `--peaks`, it only measures the original audio's loudness for the dialog's waveform (`{session}/retranscribe/peaks/`).
4. Otherwise it transcribes the adjusted audio with whisper.cpp (thorough by default) and saves the lines as a portion in `transcripts/retranscribed.json`. The lines replace the transcript's lines in that range, and the final transcript (`latest.*`) is rebuilt. `raw.json` is never changed.
5. `--remove <id>` takes a portion back out, and its original lines return.

Corrections and line edits still apply on top. Re-transcribed lines are marked 🔊 in the thumbnails page's transcript. A full meeting's portions move with its timeline when it's rebuilt, and `split-session` splits them along with the session.

## From the thumbnails page

Hovering a transcript line shows 🔊 beside its time: click it to open the dialog for that line (half a second either side). Clicking a speaker's face in the transcript (or on the image above it) sets the clip to that person's whole stretch, from the mark where they start speaking to the mark where they stop, and opens the dialog for it. Otherwise the dialog opens with the clip range, or the next 30 seconds if no clip is set.

- The **waveform** shows the portion with a few seconds either side. It's measured by the local server from the original audio (`--peaks`) and drawn on a loudness scale, so a quiet voice in the background still shows. Drag the green (start) and red (end) edges to trim to just that voice, or click elsewhere to move the nearer edge; a white line follows the video while listening. Typing a range outside it, or ↻ Waveform, loads a new one.
- **Listen here** plays the video with the adjustment applied live in the browser, so you hear slider changes right away. It's close to the result: the browser approximates loudness evening with a compressor, and noise reduction isn't heard.
- **Hear the server's version** renders the exact audio, which takes about a second for a minute of audio.
- **Re-transcribe this portion** sends it off. The page shows progress, then reloads the transcript.
- **💾 Only save as a playback boost** saves the range and settings without transcribing. Re-transcribing saves them too, unless you uncheck **and boost it during playback**.
- The lists at the bottom show the saved playback boosts (**Go**, **Remove**) and every re-transcribed portion (**Go**, **Undo**).

## Playback boosts

Saved boosts are kept in `{session}/audio-boosts.json` as ranges with their settings. A newer boost replaces any older one covering the same stretch. While **Boost quiet speakers** (beside the video) is checked, the page applies each boost live as playback enters its range and shows which one is playing; outside the ranges, the sound is unchanged. The checkbox is remembered.

Live playback uses the browser's version of the adjustment (high-pass, gain, and a compressor for evening out), so noise reduction applies only to re-transcription. Boosts move with a full meeting's timeline when it's rebuilt, and `split-session` splits them.

Sending needs `npm start`; the server runs this script in the background. Each job's progress is in `{session}/retranscribe/jobs/{job}.json`.
