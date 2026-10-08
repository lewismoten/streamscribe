# A meeting, start to finish

With the full install (see the README), on the machine with the video:

1. **Capture** while it's live: **Start capture** on the Capture page, or `npm run capture`. It recovers the minutes before you started (as far back as the server keeps them) and any gaps from network drops. A [recorder](recorder/recorder.md) can do this on a schedule instead.
2. **Transcribe**, even while it's still recording: `npm run transcribe`. Fix mishearings once with `npm run transcript-corrections -- add "heard as" "should be"`, and they apply to every transcript.
3. **Review** it from the library: mark speakers, chapters (agenda items), and votes; boost quiet speakers and transcribe them again; magnify whoever is speaking; download clips, with or without the overlays. A capture started outside the app gets its page from `npm run extract-thumbnails` (add `-- --watch` during the meeting to follow it live).
4. **Complete it** once the official recording is posted: `npm run build-meeting -- --url <its page or video link>` (or `--file <video>`). It joins the archive and your capture into one full meeting, carrying your marks over, and lines the two up so links to the official video land at the same moment.
5. **Share it** through a hub (see [hub/hub.md](hub/hub.md)): `npm run publish-library` sends the meeting's details, transcript, stills, and marks; `npm run publish-media` its light audio and video. Meetings stay private on the hub. On a meeting page, publish notes, a summary, part of the transcript, or a clip for everyone.
