import { useEffect, useState } from 'react';
import { hubCall } from '../data/hub.ts';
import type { Agent } from './types.ts';

// The hub's agent package (its build), checked each minute: so an agent shows as behind right after a deploy, before
// it checks for itself (every ten minutes).
export interface AgentBuild {
  commit: string | null;
  builtAt?: string | null;
}

export function useAgentBuild() {
  const [build, setBuild] = useState<AgentBuild | null>(null);
  useEffect(() => {
    const load = () =>
      hubCall<AgentBuild>('agent-build')
        .then(setBuild)
        .catch(() => setBuild(null));
    load();
    const timer = setInterval(load, 60000);
    return () => clearInterval(timer);
  }, []);
  return build;
}

// Whether an agent runs an older build than the hub's package (and can update itself).
export const isBehind = (agent: Agent, build: AgentBuild | null) => {
  const update = agent.status?.update;
  if (!update?.canUpdate) return false;
  return Boolean(update.behind || (build?.commit && update.current !== build.commit));
};
