import { putRecord, useRecords } from '../data/useRecords.ts';
import { LINK_KINDS_ID, type LinkKind, type Profile } from './names.ts';

// The profiles and kinds of link, kept current (see names.ts for what they hold and the helpers that read them).
export * from './names.ts';

export function useProfiles() {
  const { records: profiles } = useRecords<Profile>('profiles');
  const { records: settings } = useRecords<{ kinds?: LinkKind[] }>('settings');
  const kinds = settings?.find((record) => record.id === LINK_KINDS_ID)?.data.kinds || [];
  const map = new Map((profiles || []).map((record) => [record.id, record.data]));
  return { profiles: map, kinds };
}

export const saveLinkKinds = (kinds: LinkKind[]) => putRecord('settings', LINK_KINDS_ID, { kinds });
