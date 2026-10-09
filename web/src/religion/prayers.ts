// Who led prayer at meetings (each meeting's `prayers` mark), and the faith of the people who do (each source's
// `faith` mark, kept once per person): their church, its denomination, and the tradition it belongs to (Front Royal
// Church of the Nazarene, Church of the Nazarene, Christian), so the Religion page can show how they rotate. Both are
// marks, private like the meetings.
export type PrayerKind = 'prayer' | 'invocation' | 'silence' | 'reading' | 'other';
export interface Prayer {
  id: string;
  personId: string;
  part: string;
  at: number;
  kind: PrayerKind;
  note?: string;
}
export interface Faith {
  church?: string;
  denomination?: string;
  tradition?: string;
}

export const PRAYER_KINDS: Record<PrayerKind, string> = {
  prayer: 'Prayer',
  invocation: 'Invocation',
  silence: 'Moment of silence',
  reading: 'Reading',
  other: 'Other'
};
export const TRADITIONS = [
  'Christian',
  'Jewish',
  'Muslim',
  'Hindu',
  'Buddhist',
  'Sikh',
  "Bahá'í",
  'Unitarian Universalist',
  'Interfaith',
  'Nonreligious',
  'Other'
];

export const prayersMarkId = (recordingId: string) => `${recordingId}:prayers`;
export const faithMarkId = (sourceKey: string) => `${sourceKey}:faith`;

// The tradition a denomination belongs to, from what's been said for anyone of that denomination.
export function traditionOf(people: Record<string, Faith>, denomination: string) {
  const wanted = denomination.trim().toLowerCase();
  return Object.values(people).find((faith) => faith.denomination?.trim().toLowerCase() === wanted && faith.tradition)
    ?.tradition;
}
