// What the hub reports about agents (the recorders, on machines with the video) and the work queued for them, and
// how long ago something happened, for the agents page.
export interface Capabilities {
  machine: string;
  system: string;
  arch: string;
  cpus: number;
  cpuModel: string;
  memoryGb: number;
  node: string;
  ffmpeg: string | null;
  whisper: 'ready' | 'no model' | null;
  whisperModel?: string;
  // GPUs and AI accelerators (NVIDIA, Apple Silicon, Hailo).
  accelerators?: { kind: 'nvidia' | 'apple' | 'hailo'; name: string; memoryGb?: number }[];
  sources: string[];
  hostname?: string;
  // Its data folder, and the recordings in it (agents with the same folder on one machine share them).
  dataDir?: string;
  recordings?: number;
}
export interface AgentStatus {
  state: string;
  agentId?: string;
  name: string;
  // The machine's host name, as of its last report.
  hostname?: string;
  version: string;
  freeGb: number | null;
  job: { id: string; title: string; progress: number; message: string } | null;
  recordings: { title: string }[];
  capabilities?: Capabilities | null;
  // What it found of its settings (src/recorder/agent-settings.js).
  settings?: SettingsReport | null;
  // The recordings it holds (the others fetch from it), and the copies it keeps as a storage agent.
  holds?: string[];
  copies?: CopiesReport | null;
}
export interface PlaceStatus {
  path: string;
  ok: boolean;
  freeGb?: number;
  error?: string;
  label?: string;
  kind?: string;
}
export interface SettingsReport {
  checkedAt: string | null;
  workDir?: PlaceStatus;
  data?: PlaceStatus;
  storage?: PlaceStatus[];
  ollama?: {
    url: string;
    ok: boolean;
    ms?: number;
    models?: { name: string; sizeGb: number }[];
    error?: string;
    checkedAt: string;
  };
  // Its language-model servers for tasks (src/recorder/llm.js), as checked each minute.
  llm?: LlmServerStatus[];
  // Tools it installs on itself when asked (src/recorder/tools.js).
  tools?: { whisper?: ToolStatus };
  tailscale?: {
    ip: string;
    name: string;
    online: boolean;
    port: number;
    listening: boolean;
    // Its own addresses on its networks.
    lan?: string[];
  } | null;
  peers?: Peer[];
}
export interface LlmServerStatus {
  label: string;
  url: string;
  kind: 'ollama' | 'openai';
  ok: boolean;
  ms?: number;
  models?: { name: string; sizeGb: number | null }[];
  error?: string;
  checkedAt: string;
}
export interface ToolStatus {
  state: 'installing' | 'installed' | 'failed';
  step?: string;
  share?: number;
  version?: string;
  model?: string;
  error?: string;
  at?: string;
}
// The whisper.cpp models an agent can be asked to install (the same as WHISPER_MODELS in src/recorder/tools.js).
export const WHISPER_MODELS: Record<string, string> = {
  'tiny.en': 'Tiny (English), 75 MB: fastest, rough',
  'base.en': 'Base (English), 142 MB: for a Raspberry Pi',
  'small.en': 'Small (English), 466 MB: a fast Pi or a small PC',
  'medium.en': 'Medium (English), 1.5 GB',
  'large-v3-turbo': 'Large v3 Turbo, 1.6 GB: nearly as accurate, much faster',
  'large-v3': 'Large v3, 3.1 GB: the most accurate (a Mac with Apple Silicon)'
};
// A storage agent's copies (src/recorder/copies.js).
export interface CopiesReport {
  dir: string;
  recordings: number;
  parts: number;
  freeGb: number | null;
  copying?: { title: string; part: string; share: number } | null;
  missing?: number;
  error?: string | null;
  checkedAt?: string;
}
// Another agent as this one reaches it (src/recorder/agent-settings.js): its ping, the path tailscale takes (local: the
// same network; direct: elsewhere, connected directly; relay: elsewhere, through Tailscale's relay), and the last
// transfer timed from it.
export interface Peer {
  agentId: string;
  name: string;
  host?: string;
  ok: boolean;
  ms?: number;
  error?: string;
  path?: 'local' | 'direct' | 'relay' | null;
  via?: string | null;
  pathMs?: number | null;
  speed?: { ok: boolean; mbps?: number; error?: string; at: string };
  checkedAt?: string;
}
// What an agent is told (collection agent_settings, id = its id).
export interface AgentSettingsData {
  workDir?: string;
  storage?: { label: string; path: string; kind: 'local' | 'usb' | 'network' }[];
  ollama?: { url: string; testAt?: string };
  peerPort?: number;
  // Asks for the transfers from the other agents to be timed again now.
  peerTestAt?: string;
  // A storage agent: keeps a copy of every recording, in copiesDir (its data folder's copies/ unless set).
  keepsCopies?: boolean;
  copiesDir?: string;
  // More language-model servers for tasks, and the model for tasks that don't name one.
  llmServers?: { label: string; url: string; kind: 'ollama' | 'openai' }[];
  taskModel?: string;
  // Tools to install on itself: a new `at` asks again.
  tools?: { whisper?: { model: string; at: string } };
}
// Agents added here (with an install command), as the hub keeps them.
// Agents added here (with an install command), as the hub keeps them.
export interface Enrolled {
  id: string;
  name: string;
  createdAt: string;
  enrolledAt: string | null;
  revoked: boolean;
  joined: boolean;
}
export interface Install {
  agent: { id: string; name: string };
  command: string;
  expiresAt: string;
}
export interface Agent {
  recorderId: string;
  name: string;
  updatedAt: string;
  status: AgentStatus | null;
}
export interface Job {
  type: 'clip' | 'encode';
  status: 'queued' | 'working' | 'done' | 'failed' | 'cancelled';
  title: string;
  recordingId: string;
  publicationId?: string;
  agent: string | null;
  agentName?: string;
  forAgent?: string;
  progress: number;
  message: string;
  error?: string | null;
  createdAt: string;
  createdBy: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt?: string;
}

// "12s ago", "5 min ago", "3 h ago", or the date, counted back from `now`.
export const ago = (iso: string | undefined, now: number) => {
  if (!iso) return '';
  const seconds = Math.round((now - Date.parse(iso)) / 1000);
  return seconds < 90
    ? `${seconds}s ago`
    : seconds < 5400
      ? `${Math.round(seconds / 60)} min ago`
      : seconds < 172800
        ? `${Math.round(seconds / 3600)} h ago`
        : new Date(iso).toLocaleDateString();
};
