// Copy this file to config.local.js (git ignores it) and edit it. Every setting is optional except sources.
export default {
  // Where captures, transcripts, and state go (default: ./data; the DATA_DIR and STATE_DIR environment variables
  // override these). One folder per source, plus data/state.
  // dataDir: '/Volumes/Archive/streamscribe',
  // stateDir: '/Volumes/Archive/streamscribe/state',

  // Times of day on pages, transcripts, and clocks are shown in this time zone.
  locale: { timeZone: 'America/New_York' },

  // Command-line tools (defaults: found on PATH). drawtext (for render-mp4's clock) needs an ffmpeg built with
  // libfreetype, such as Homebrew's ffmpeg-full.
  tools: {
    ffmpeg: '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg',
    ffprobe: '/opt/homebrew/opt/ffmpeg-full/bin/ffprobe',
    whisperCpp: 'whisper-cli'
  },

  // Reading the text on slides (npm run ocr-slides) with a vision model on an Ollama server.
  // ocr: { ollamaUrl: 'http://127.0.0.1:11434', model: 'deepseek-ocr:3b' },

  // Local transcription with whisper.cpp.
  transcription: {
    // whisperCppModel: '~/.cache/whisper-cpp/ggml-large-v3.bin',
    // whisperCppVadModel: '~/.cache/whisper-cpp/ggml-silero-v5.1.2.bin',
    whisperLanguage: 'en',
    // What is being transcribed; starts Whisper's prompt.
    context: 'Springfield City Council meeting in Springfield, Illinois.',
    // Names and terms Whisper should expect, most important first (as many as fit go into its prompt). Mishearings are
    // better fixed with `npm run transcript-corrections`, which keeps them in transcription-corrections.local.json.
    vocabulary: ['Mayor Jane Smith', 'Council Member Lee', 'Elm Street', 'Lincoln Park']
    // correctionsFile: 'transcription-corrections.local.json',
    // corrections: { 'heard as': 'should be' }
  },

  // Web requests: robots.txt is obeyed (cached for a day) and requests are spaced out per host. Profiles set the pace
  // for live media; any host can be exempted from robots.txt checks.
  http: {
    // cooldownMs: 1000,
    // profiles: { liveMedia: { cooldownMs: 1000, burst: 3 }, liveBackfill: { cooldownMs: 500, burst: 1 } },
    // robots: { enabled: true, userAgentToken: 'streamscribe', ignoreHosts: [] }
  },

  // Streams to capture. Each source gets data/<key>/ with live/ (captures), meetings/ (full meetings), archive/
  // (downloaded official recordings), and people/ (the roster shared by its meetings).
  sources: [
    {
      key: 'springfield-council',
      name: 'Springfield City Council',
      // 'hls' (any plain HLS stream, the default) or 'swagit' (Swagit: page discovery, stream identifiers, standby
      // slides, and archive downloads). Swagit addresses below imply 'swagit' when this is left out.
      provider: 'hls',
      // Live HLS playlists to watch (.m3u8), or pages that name one.
      liveUrls: ['https://streams.example.gov/live/council/playlist.m3u8'],
      // Pages to search for the live stream when no playlist is given directly (Swagit: the government's video page).
      discoveryUrls: [],
      // Plain HLS only: a regular expression for segment file names whose first group is a stream identifier and
      // second the sequence number, to track identifier changes as Swagit's are (optional).
      // segmentPattern: '^chunk-([a-z0-9]+)-(\\d+)\\.ts$',
      // Each meeting gets its own session folder: a new one starts when the stream comes back from the provider's standby
      // slide after at least this many minutes (Swagit; a recess shows the meeting's own title card instead).
      newSessionAfterStandbyMinutes: 10,
      // Also start a new session folder at every stream identifier change (Swagit renews it hourly, mid-meeting).
      splitOnStreamIdentifierChange: false
      // Where this source's files go (default: data/<key>/), and its live captures (default: <storageDir>/live).
      // storageDir: '/Volumes/Archive/springfield-council',
      // liveStorageDir: '/Volumes/Archive/springfield-council/live',
    }
    // {
    //   key: 'warren-county-va',
    //   name: 'Warren County, VA',
    //   provider: 'swagit',
    //   discoveryUrls: ['https://va-warrencounty.civicplus.com/259/Board-of-Supervisors-Meetings---Videos'],
    //   liveUrls: ['https://edge-f.swagit.com/live/frontroyalva/live-1-a-1/playlist.m3u8']
    // }
  ],

  // The recorder (agent; npm run recorder, see docs/recorder/recorder.md): records the meetings on the hub's schedule
  // and does work from its queue. An agent installed from the hub's Agents page has this written for it.
  recorder: {
    // The hub (docs/hub/hub.md) and this recorder's key (from the Agents page's installer, or made by hand with
    // php tools/new-key.php recorder "Name").
    // hubUrl: 'https://example.com/hub/api.php',
    // key: 'ss_…',
    // id: 'office-mac',            // default: this computer's name
    // name: 'Office Mac',
    // sources: ['springfield-council'],   // default: every source above
    // How often to sync with the hub, report, send a live picture, and transcribe quickly (seconds).
    pollSeconds: 30,
    heartbeatSeconds: 20,
    thumbnailSeconds: 30,
    quickTranscribe: true,
    quickTranscribeSeconds: 60,
    // quickModel: '~/.cache/whisper-cpp/ggml-small.en.bin',   // faster quick transcripts (default: the main model)
    finalTranscribe: true,
    maxStills: 300,
    // After a meeting's scheduled end, stop when the standby slide has shown this long, or no new video has come
    // this long, and at the latest this long past the end (minutes). Each schedule can override these.
    overrun: { standbyMinutes: 10, idleMinutes: 15, capMinutes: 240 },
    minFreeGb: 2,
    // How long its claim on a meeting or a job lasts between renewals (seconds).
    leaseSeconds: 300,
    // The light copies sent to the hub (npm run publish-media, and agents' encode jobs; docs/media/publish-media.md):
    // silent video height, frame rate, quality (CRF, lower is better) and cap, audio bit rate, and how many days the
    // video stays on the hub (audio stays).
    media: { height: 360, fps: 15, crf: 34, maxrateKbps: 150, audioKbps: 48, keepVideoDays: 365 }
  }
};
