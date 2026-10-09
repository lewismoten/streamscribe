import { useEffect, useState } from 'react';
import { hubCall } from '../data/hub.ts';
import type { Agent } from '../agents/types.ts';

// The models the agents' language-model servers have (from their live reports), for choosing a task's model; and
// whether any agent can run tasks now.
export function useModels() {
  const [found, setFound] = useState<{ models: string[]; ready: boolean }>({ models: [], ready: false });
  useEffect(() => {
    hubCall<{ recorders: Agent[] }>('live')
      .then((value) => {
        // (Every server of every agent: its Ollama server and any others, as last checked.)
        type Checked = { ok: boolean; models?: { name: string }[] };
        const reports = value.recorders
          .flatMap((agent): Checked[] => {
            const settings = agent.status?.settings;
            return settings?.llm || (settings?.ollama ? [settings.ollama] : []);
          })
          .filter((item) => item.ok);
        setFound({
          models: [...new Set(reports.flatMap((report) => (report.models || []).map((model) => model.name)))],
          ready: reports.length > 0
        });
      })
      .catch(() => {});
  }, []);
  return found;
}
