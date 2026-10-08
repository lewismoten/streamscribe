# The recorder

The recorder is a service that runs on a computer with disk space for video. It records the meetings on the hub's schedule and keeps all the video locally. While recording, it tells the hub what it's doing and sends a live picture and quick transcripts, so the web app can show the meeting live. When the meeting ends, it sends the final transcript and stills.

```bash
npm run recorder
```

## Setup

The easiest way, on a Raspberry Pi or another Debian or Ubuntu machine, is the one-line install from the hub's Agents page: see [Installing an agent](#installing-an-agent-raspberry-pi-debian-ubuntu) below. To set one up by hand (on a Mac, say):

1. Set up the hub ([hub/hub.md](../hub/hub.md)) and make a key for this recorder, on the hub's server:

   ```bash
   php tools/new-key.php recorder "Office Mac"
   ```

2. In `config.local.js`, add the sources to record (see `config.example.js`) and a `recorder` section:

   ```js
   recorder: {
     hubUrl: 'https://example.com/hub/api.php',
     key: 'ss_…',
     id: 'mac1',          // short, shown on the Agents page (default: the machine's name)
     name: 'Office Mac'
   }
   ```

   Other settings in that section (with their defaults): `sources` (the source keys it records; all), `pollSeconds` (30, how often it syncs), `heartbeatSeconds` (20), `thumbnailSeconds` (30), `quickTranscribe` (true), `quickModel` (a smaller whisper.cpp model for quick transcripts), `finalTranscribe` (true), `maxStills` (300), `leaseSeconds` (300, how long its claim on a meeting lasts between renewals), `minFreeGb` (2), `overrun` (below), and `media` (see [publish-media](../media/publish-media.md)).

3. Add meetings to the schedule in the web app, under Schedules. Each schedule names a source by its key, and its `leadMinutes` (10 by default) says how early to start.

## What it does

It checks what to do every 5 seconds (`npm run recorder -- --tick-seconds N` changes that) and:

- **Syncs with the hub** every `pollSeconds`, keeping a local copy of the records in `data/state/recorder-<id>.sqlite`.
- **Starts meetings:** the schedule's `leadMinutes` before its start (10 by default), it claims the meeting on the hub, so only one recorder records it. Then it starts the capture and a thumbnail watcher. A schedule's `preferredRecorder` gets the head start: other recorders wait until the scheduled start before claiming, so they take over only if it is down. A recorder that found the meeting taken keeps leaving it alone while the hub can't be reached, and looks again each minute in case the other recorder's lease runs out.
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

## Installing an agent (Raspberry Pi, Debian, Ubuntu)

On the hub's Agents page, as an admin, add an agent with a short id (such as `pi1`) and a name. You get a command; ssh into the machine and run it there as the user the agent should run as:

```bash
curl -fsSL 'https://example.com/hub/api.php/agent-install?token=…' | bash
```

The script:

- installs ffmpeg and Node.js 24 (asking for sudo where it must)
- puts the agent in `~/streamscribe` and its data in `~/streamscribe-data`
- trades the command's token for the agent's own key and writes `~/streamscribe/config.local.js`
- sets up the `streamscribe-agent` systemd service, which restarts if it stops and starts with the machine

The token works once and expires after 48 hours, and the key never appears in the command or your shell history. Within a minute the agent shows as online on the Agents page, with what its machine has (CPU, memory, ffmpeg, whisper.cpp) and so what it can do.

To update the agent or give it a new key, use Reinstall command on the Agents page and run that; its other settings stay. Revoke stops its key at once. On the machine:

- **Logs:** `journalctl -u streamscribe-agent -f`
- **Restart:** `sudo systemctl restart streamscribe-agent`

**If the install stops.** The script works in seven numbered steps and keeps a log in `~/streamscribe-install.log`. If a step fails, it says which one, and the lines just above are what went wrong. Fix that, or paste those lines into an issue, then run the same command again. It's good until it joins the hub or 48 hours pass, and finished steps go quickly the second time. Along the way it:

- **Repairs:** finishes an earlier package install that was interrupted (`dpkg --configure -a`).
- **Waits:** if automatic updates are installing packages, it waits for them.
- **Warns:** about a Raspberry Pi that is short of power. That can drop its network or reset it partway through.

A 64-bit system is best (a Raspberry Pi 4 or 5 with 64-bit Raspberry Pi OS); Node.js 24 may not install on 32-bit ones.

## Agent work

The recorder is also an agent: it takes work from the hub's queue, cutting published clips and encoding recordings' audio and video, and reports progress on the hub's Agents page. See ../hub/hub.md, Agents and their work.

- **Name it.** Give each machine a short `recorder.id` (such as `mac1`) and a `recorder.name` (such as `Office Mac`).
- **Uploads.** Results go up through the hub's API in pieces, with the agent's own key, so no SSH access to the server is needed.
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
