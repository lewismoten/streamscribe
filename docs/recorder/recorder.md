# The recorder

The recorder is a service that runs on a computer with disk space for video. It records the meetings on the hub's schedule and keeps all the video locally. While recording, it tells the hub what it's doing and sends a live picture and quick transcripts, so the web app can show the meeting live. When the meeting ends, it sends the final transcript and stills.

```bash
npm run recorder
```

## Setup

1. Set up the hub ([docs/hub/hub.md](../hub/hub.md)) and make a key for this recorder:

   ```bash
   php tools/new-key.php recorder "Office Mac"
   ```

2. In `config.local.js`, add the sources to record (see `config.example.js`) and a `recorder` section:

   ```js
   recorder: {
     hubUrl: 'https://example.com/streamscribe/api.php',
     key: 'ss_…',
     name: 'Office Mac'
   }
   ```

3. Add meetings to the schedule in the web app, under Schedules. Each schedule names a source by its key.

## What it does

Every few seconds it:
- **Syncs with the hub**, keeping a local copy of the records in `data/state/recorder-<id>.sqlite`.
- **Starts meetings:** `leadMinutes` before a scheduled start (10 by default) it claims the meeting on the hub, so only one recorder records it. Then it starts the capture and a thumbnail watcher. A schedule's `preferredRecorder` gets the head start: other recorders wait until the scheduled start before claiming, so they take over only if it is down. A recorder that found the meeting taken keeps leaving it alone while the hub can't be reached, and looks again each minute in case the other recorder's lease runs out.
- **Reports** its state every 20 seconds, a live picture every 30 seconds, and a quick transcript of each new minute of video.
- **Stops meetings** after the scheduled end, on whichever comes first:
  - the standby slide has shown for 10 minutes
  - no new video has arrived for 15 minutes
  - 4 hours past the end, at the latest

  Before the end, standby is just the lead-up or a recess. A still title card such as "Executive Session" is kept video, so a closed session never counts as the end. The `recorder.overrun` settings change these limits, and so can a schedule's `overrun`.
- **Publishes:** after a meeting it transcribes it in full, then sends the final transcript, up to 300 stills, and the recording's details, including its parts (session folders) and why it stopped.
- **Syncs review marks both ways** (speakers, chapters, votes, names and so on). A change made in the review page on this computer goes to the hub, and a change made elsewhere is written into the files here.

**If something goes wrong:**
- **The hub is down:** recording carries on. Schedules come from the local copy, changes wait in the local outbox until the hub is back, and live reports are skipped.
- **The recorder restarts:** the capture it started keeps running, and the recorder picks it up again. A capture that died mid-meeting is restarted.
- **Two recorders, one schedule:** the second leaves the meeting to the first. It takes over only if the first stops renewing its claim, for example because that computer went down.
- **A capture started by hand:** if one is already running for the source, from a terminal say, the recorder uses it rather than starting another.
- **Low disk:** with less free space than `minFreeGb`, it doesn't start a meeting and reports why.

## Agent work

The recorder is also an agent: it takes work from the hub's queue, cutting published clips and encoding recordings' audio and video, and reports progress on the hub's Agents page. See ../hub/hub.md, Agents and their work.
- **Name it.** Give each machine a short `recorder.id` (such as `mac1`) and a `recorder.name` (such as `Office Mac`).
- **Let it upload.** Give it the deploy settings (`deploy.local.env` with an SSH key the server accepts), since results are uploaded over SSH.
- **Keep it running.** It only works while `npm run recorder` is running; see below.

## Keeping it running (macOS)

A launchd agent starts the recorder at login, restarts it if it stops, and keeps the Mac from sleeping while it runs. Save it as `~/Library/LaunchAgents/com.streamscribe.recorder.plist`, with the paths changed to yours:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.streamscribe.recorder</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string><string>-i</string>
    <string>/opt/homebrew/bin/node</string><string>/Users/you/streamscribe/bin/recorder.js</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/you/streamscribe</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/you/streamscribe/data/logs/recorder.log</string>
  <key>StandardErrorPath</key><string>/Users/you/streamscribe/data/logs/recorder.log</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin</string></dict>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.streamscribe.recorder.plist
```

## Testing

`npm run test:recorder` runs a complete meeting in a temporary folder. It takes a few minutes. It uses:
- a real hub
- the simulated stream (`npm run simulate-hls`), replaying a captured session: program, then an "Executive Session" title card spanning the scheduled end, then the standby slide
- a one-minute meeting on the schedule
- this recorder and a backup recorder

Along the way it restarts the recorder mid-meeting and takes the hub down for 20 seconds. It then checks that:
- only one recorder records
- it starts on time
- the card doesn't stop it, and the standby slide does
- live reports and quick transcripts arrive, with nothing lost
- the final transcript and stills are published
- marks go both ways

To keep the temporary folder for a look afterwards, set `KEEP_E2E=1`.
