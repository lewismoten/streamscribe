// More about a person than their source's roster says (collection profiles, public, edited with edit.bodies): their
// name in parts (title, first, middle, last, suffix) and nicknames (Lewie), who they work for (an organization), their
// ids on other sites, and any other links (Facebook, a personal site…). Each kind of link with an id is kept once (the
// settings record person-links): its name and the address before the id, such as
// https://historical.elections.virginia.gov/candidate/ for Virginia's election results, or
// https://va-warrencounty.civicplus.com/m/directory/employee?eid= for the county's staff directory; a profile keeps
// only the id.
export interface Profile {
  honorific?: string; // Dr., Hon., Rev.
  first?: string;
  middle?: string;
  last?: string;
  suffix?: string; // Jr., III, PhD
  nicknames?: string[];
  formalName?: string; // from before names had parts
  employerId?: string; // an organization (see ../civic)
  links?: Record<string, string>;
  urls?: { label: string; url: string }[];
}
export interface LinkKind {
  id: string;
  name: string;
  url: string; // the address before the id (or with {id} where it goes)
}

export const profileId = (sourceKey: string, personId: string) => `${sourceKey}:${personId}`;
export const LINK_KINDS_ID = 'person-links';

// A name's parts: as given, or (for a profile from before parts) its formal name split at the first and last spaces.
export function nameParts(profile: Profile | undefined) {
  if (!profile) return {};
  if (profile.first || profile.last) return profile;
  const words = (profile.formalName || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return profile;
  return {
    ...profile,
    first: words[0],
    middle: words.slice(1, -1).join(' '),
    last: words.length > 1 ? words.at(-1) : ''
  };
}
// The full name: Title First "Nick" Middle Last, Suffix (the parts given), or '' when the profile has none.
export function fullName(profile: Profile | undefined) {
  const parts = nameParts(profile);
  const nickname = parts.nicknames?.[0];
  const name = [
    parts.honorific,
    parts.first,
    nickname && nickname !== parts.first ? `“${nickname}”` : '',
    parts.middle,
    parts.last
  ]
    .filter(Boolean)
    .join(' ');
  if (!parts.first && !parts.last) return '';
  return parts.suffix ? `${name}, ${parts.suffix}` : name;
}

export const linkUrl = (kind: LinkKind, id: string) =>
  kind.url.includes('{id}') ? kind.url.replace('{id}', encodeURIComponent(id)) : kind.url + encodeURIComponent(id);

// A site's name for a link: the known social sites by name, else the address's host.
const SITES: Record<string, string> = {
  'facebook.com': 'Facebook',
  'fb.com': 'Facebook',
  'x.com': 'X',
  'twitter.com': 'X',
  'instagram.com': 'Instagram',
  'linkedin.com': 'LinkedIn',
  'youtube.com': 'YouTube',
  'tiktok.com': 'TikTok',
  'threads.net': 'Threads',
  'bsky.app': 'Bluesky',
  'nextdoor.com': 'Nextdoor',
  'ballotpedia.org': 'Ballotpedia'
};
export function siteName(address: string) {
  try {
    const host = new URL(address).hostname.replace(/^www\.|^m\./, '');
    return SITES[host] || host;
  } catch {
    return address;
  }
}

// A pasted address: the kind of link it is and its id; or, for a site not known yet, where its id seems to be (the
// last value of its query, such as ?eid=34, else the last part of its path), to make a new kind of link from.
export function readLink(address: string, kinds: LinkKind[]) {
  const text = address.trim();
  for (const kind of kinds) {
    const [before, after = ''] = kind.url.split('{id}');
    if (text.startsWith(before) && text.endsWith(after) && text.length > before.length + after.length)
      return { kind, id: decodeURIComponent(text.slice(before.length, text.length - after.length)) };
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  const query = [...url.searchParams.entries()].at(-1);
  if (query && query[1] && text.endsWith(encodeURIComponent(query[1])) && !url.hash)
    return { prefix: text.slice(0, text.length - encodeURIComponent(query[1]).length), id: query[1] };
  const match = text.match(/^(https?:\/\/.+\/)([^/?#]+)\/?$/);
  return match ? { prefix: match[1], id: decodeURIComponent(match[2]) } : { prefix: '', id: '' };
}

// Every name a person goes by, for finding them.
export const namesOf = (profile: Profile | undefined) => {
  const parts = nameParts(profile);
  return [parts.formalName || '', parts.first || '', parts.last || '', ...(parts.nicknames || [])];
};
