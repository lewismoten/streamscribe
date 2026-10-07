# transcribe

Script: [`transcribe.js`](transcribe.js)

Command:

```bash
npm run transcribe -- [options]
```

Transcribes a captured live session locally with [whisper.cpp](https://github.com/ggerganov/whisper.cpp), including a session that is still recording (it transcribes everything captured so far). Nothing is sent to an online service.

The script joins the captured segments' audio in sequence order and runs Whisper over it in one pass. Whisper itself has no length limit for local files; the 25 MB limit applies only to OpenAI's hosted API.

Each line gets two timestamps:

- **Video position** (`[01:23:45]`), counting discarded slides and missed segments, so it matches the MP4 from `render-mp4`.
- **Approximate time of day** (`~3:12:05 PM`), estimated from when live segments arrived.

Output goes to `{session}/transcripts/`: `raw.json` (Whisper's untouched output) and the final `latest.txt`, `.srt` (subtitles), and `.json`, with corrections and line edits applied. Fix mishearings with [`transcript-corrections`](transcript-corrections.md); it rebuilds the final transcript without re-transcribing.

Audio is transcribed in chunks of about 10 minutes, cached in `transcripts/chunks/`, so a re-run only transcribes new or changed chunks. Each 30-second window is transcribed without the previous window's text (`-mc 0`), and a chunk whose output repeats a line is retried at a higher temperature; this keeps Whisper from looping on one phrase for hours. In whisper.cpp this setting also makes it ignore the prompt, and tests showed even a fully active names prompt did not fix misheard names, so use [`transcript-corrections`](transcript-corrections.md) for names.

Options:

- `--continue` transcribes only segments captured after the latest transcript and appends them (for a session that kept recording after the last run); timestamps stay on one timeline
- `--session <folder>` transcribes this session folder (default: the most recently updated capture)
- `--source <key>` limits the default session search to one source
- `--model <file>` uses another whisper.cpp model (default `transcription.whisperCppModel`)
- `--vad-model <file>` / `--no-vad` changes or disables voice activity detection
- `--language <code>` (default `transcription.whisperLanguage`)
- `--prompt <text>` gives Whisper context for names and spelling (default: the jurisdiction from `reportGeoFocus` plus as many `transcription.vocabulary` terms as fit in Whisper's ~224-token prompt)

Setup (once):

```bash
brew install whisper-cpp
mkdir -p ~/.cache/whisper-cpp && cd ~/.cache/whisper-cpp
curl -LO https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin          # most accurate, 3.1 GB
curl -LO https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin    # VAD, 0.9 MB
```

`ggml-large-v3-q5_0.bin` (1.1 GB) is nearly as accurate when disk space is tight; `ggml-large-v3-turbo.bin` is several times faster with slightly lower accuracy. Point `transcription.whisperCppModel` at the one you use.

Voice activity detection skips silence, which keeps Whisper from repeating phrases over long quiet stretches such as recess slides.
