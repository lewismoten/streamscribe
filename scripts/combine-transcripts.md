# combine-transcripts

Script: [`combine-transcripts.js`](combine-transcripts.js)

Command:

```bash
npm run combine-transcripts -- --session <folder> [--with best] [--apply]
```

Combines a session's usual transcript with a second one made by `npm run transcribe -- --best --output best` into the usual transcript. It works chunk by chunk, using the 10-minute chunks the second one was transcribed in.

- **Where the second transcript is used:** chunks that came out well, meaning at least 70% of their longer lines are punctuated and Whisper didn't get stuck repeating itself. Those lines keep their word times, unless the times fall outside the line.
- **Where the usual transcript stays:** every other chunk. The second transcript only fills gaps of 5 seconds or more where the usual one has nothing (speech it missed).

Without `--apply`, it prints which chunks come from where. With it:

- **Backups:** `transcripts/raw.json` and `latest.json` are saved as `raw-before-combine-{time}.json` and `latest-before-combine-{time}.json`. To undo, copy those back.
- **Combined transcript:** the combined lines become `raw.json`, each line from the second transcript marked `"source": "best"`.
- **Rebuild:** the final transcript is rebuilt as usual. Boosted re-transcriptions made on the review page, corrections, and line edits are applied on top.
