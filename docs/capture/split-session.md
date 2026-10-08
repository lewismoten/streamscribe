# split-session

Script: [`split-session.js`](../../src/sessions/split-session.js)

Command:

```bash
npm run split-session -- --session <folder> (--at-sequence N | --at-transition <identifier>) [--apply]
```

Splits one captured live session into two at a segment sequence number, for example when a regular meeting and a work session were recorded in one session. Without `--apply` it only prints the plan.

- `--at-sequence N` starts the second session at segment N.
- `--at-transition <identifier>` starts it where that segment identifier first appears (see `stream-identity-transitions.json`).

What it does:

- Moves the later segment files (no copying) into a new sibling folder named for the first moved segment's capture time.
- Splits `segments.jsonl`, `discarded-segments.jsonl`, `silence-boundaries.json`, and `stream-identity-transitions.json`.
- Marks the first session complete and links the two (`nextSessionDir` / `previousSessionDir`, `splitInto` / `splitFrom`).
- Splits the latest transcript to match; the second half's times restart at its first segment. The full transcript files stay in the first session's `transcripts/` folder.
- Divides `slides/` by when each slide was shown (a slide shown on both sides is copied to both), renumbers the second session's slides from its own start, and rebuilds both contact sheets.
- Moves `thumbnails/` at or after the split into the new session, renamed for its timeline, and rebuilds both scrubber pages.
- Clears the capture's saved state for that session, so a restarted capture resumes in the newer session.

Stop `capture` first. `--ignore-running` skips that check, only for sessions the running capture isn't writing to.
