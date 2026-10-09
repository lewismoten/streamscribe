import { useRecords } from '../data/useRecords.ts';

// Bible passages mentioned in meetings: the books, a passage's name ("Psalms 121-122", "John 3:16-18"), and where it
// links (the settings record scripture: an address with {passage} where the passage goes, Bible Gateway unless an
// editor changes it on the Religion page).
export const BOOKS = [
  'Genesis',
  'Exodus',
  'Leviticus',
  'Numbers',
  'Deuteronomy',
  'Joshua',
  'Judges',
  'Ruth',
  '1 Samuel',
  '2 Samuel',
  '1 Kings',
  '2 Kings',
  '1 Chronicles',
  '2 Chronicles',
  'Ezra',
  'Nehemiah',
  'Esther',
  'Job',
  'Psalms',
  'Proverbs',
  'Ecclesiastes',
  'Song of Songs',
  'Isaiah',
  'Jeremiah',
  'Lamentations',
  'Ezekiel',
  'Daniel',
  'Hosea',
  'Joel',
  'Amos',
  'Obadiah',
  'Jonah',
  'Micah',
  'Nahum',
  'Habakkuk',
  'Zephaniah',
  'Haggai',
  'Zechariah',
  'Malachi',
  'Matthew',
  'Mark',
  'Luke',
  'John',
  'Acts',
  'Romans',
  '1 Corinthians',
  '2 Corinthians',
  'Galatians',
  'Ephesians',
  'Philippians',
  'Colossians',
  '1 Thessalonians',
  '2 Thessalonians',
  '1 Timothy',
  '2 Timothy',
  'Titus',
  'Philemon',
  'Hebrews',
  'James',
  '1 Peter',
  '2 Peter',
  '1 John',
  '2 John',
  '3 John',
  'Jude',
  'Revelation'
];
export interface Passage {
  book: string;
  reference: string; // chapters and verses: "121-122", "3:16-18", "23"
}
export const SCRIPTURE_ID = 'scripture';
export const DEFAULT_SCRIPTURE_URL = 'https://www.biblegateway.com/passage/?search={passage}';

export const passageName = (passage: Passage) => `${passage.book} ${passage.reference}`.trim();
export const passageUrl = (passage: Passage, template = DEFAULT_SCRIPTURE_URL) =>
  template.replace('{passage}', encodeURIComponent(passageName(passage)));
// The chapter a passage starts in, for ordering a book's passages.
export const firstChapter = (passage: Passage) => Number(passage.reference.match(/\d+/)?.[0] || 0);
export const validReference = (reference: string) =>
  /^\d+(?::\d+)?(?:\s*[-–,]\s*\d+(?::\d+)?)*$/.test(reference.trim());

export function useScriptureSite() {
  const { records } = useRecords<{ url?: string }>('settings');
  return records?.find((record) => record.id === SCRIPTURE_ID)?.data.url || DEFAULT_SCRIPTURE_URL;
}
