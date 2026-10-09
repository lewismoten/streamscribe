import { putRecord, useRecords } from '../data/useRecords.ts';

// More about a person than their source's roster says (collection profiles, public, edited with edit.bodies): their
// formal name (Victoria, for Vicky), nicknames (Lewie), and their ids on other sites. Each kind of link is kept once
// (the settings record person-links): its name and the address before the id, such as
// https://historical.elections.virginia.gov/candidate/ for Virginia's election results; a profile keeps only the id.
export interface Profile {
  formalName?: string;
  nicknames?: string[];
  links?: Record<string, string>;
}
export interface LinkKind {
  id: string;
  name: string;
  url: string; // the address before the id (or with {id} where it goes)
}

export const profileId = (sourceKey: string, personId: string) => `${sourceKey}:${personId}`;
export const LINK_KINDS_ID = 'person-links';

export function useProfiles() {
  const { records: profiles } = useRecords<Profile>('profiles');
  const { records: settings } = useRecords<{ kinds?: LinkKind[] }>('settings');
  const kinds = settings?.find((record) => record.id === LINK_KINDS_ID)?.data.kinds || [];
  const map = new Map((profiles || []).map((record) => [record.id, record.data]));
  return { profiles: map, kinds };
}

export const linkUrl = (kind: LinkKind, id: string) =>
  kind.url.includes('{id}') ? kind.url.replace('{id}', encodeURIComponent(id)) : kind.url + encodeURIComponent(id);

// A pasted address: the kind of link it is and its id, or (for a site not known yet) the address before its last
// part, to make a new kind of link from.
export function readLink(address: string, kinds: LinkKind[]) {
  const text = address.trim();
  for (const kind of kinds) {
    const [before, after = ''] = kind.url.split('{id}');
    if (text.startsWith(before) && text.endsWith(after) && text.length > before.length + after.length)
      return { kind, id: decodeURIComponent(text.slice(before.length, text.length - after.length)) };
  }
  const match = text.match(/^(https?:\/\/.+\/)([^/?#]+)\/?$/);
  return match ? { prefix: match[1], id: decodeURIComponent(match[2]) } : null;
}

export const saveLinkKinds = (kinds: LinkKind[]) => putRecord('settings', LINK_KINDS_ID, { kinds });
// Every name a person goes by, for finding them.
export const namesOf = (profile: Profile | undefined) => [profile?.formalName || '', ...(profile?.nicknames || [])];
