// Tasks for agents (collection prompts) and their answers (prompt_results); see src/sync/prompts.js.
export interface Prompt {
  name: string;
  description?: string;
  prompt: string;
  model?: string;
  // Run after each meeting that finishes from then on.
  auto?: boolean;
  autoSince?: string;
  sourceKeys?: string[];
}
export interface PromptResult {
  recordingId: string;
  promptId: string;
  name: string;
  model: string;
  text: string;
  seconds: number;
  createdAt: string;
}
