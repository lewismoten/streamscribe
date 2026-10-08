# join-sessions

Script: [`join-sessions.js`](../../src/sessions/join-sessions.js)

Command:

```bash
npm run join-sessions -- --session <first folder> --session <next folder> [...] [--apply]
```

Joins captured sessions of one stream that belong to the same meeting into the first of them, the reverse of [`split-session`](split-session.md). Captures made before stream identifier changes stopped starting a new session (Swagit renews the identifier hourly, mid-meeting) left one meeting in several folders.

Without `--apply` it prints the plan. With it:

- **Segments:** the later sessions' segment files are moved (not copied) into the first, and their segment lists, discarded segments, silence periods, and stream identifier changes are combined.
- **Session record:** the joined session takes over the last session's end and its link to whatever came after.
- **Later folders:** they are removed, along with what was built from them (playlists, thumbnails, and their pages).

The later sessions must not have marks (speakers, chapters, votes, views, boosts, a meeting name), transcripts, slides, or clips yet, because their times would need moving; it stops if they do. Transcribe and mark the joined session instead. Captures and other session tools must be stopped first.

Afterward, rebuild the joined session's thumbnails and page:

```bash
npm run extract-thumbnails -- --session <first folder>
```
