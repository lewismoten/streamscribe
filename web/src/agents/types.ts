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
  sources: string[];
}
export interface AgentStatus {
  state: string;
  agentId?: string;
  name: string;
  version: string;
  freeGb: number | null;
  job: { id: string; title: string; progress: number; message: string } | null;
  recordings: { title: string }[];
  capabilities?: Capabilities | null;
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
