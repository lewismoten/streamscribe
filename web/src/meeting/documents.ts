// A meeting's documents: files of its consent agenda's items (its `consent` mark), of its chapters (each agenda item's
// links), and its official ones (the agenda, the packet). The consent agenda is a list of its own, as its items are
// usually approved together unless one is pulled for discussion. Documents are named as copied from an agenda, such
// as "I.1. Authorization to Advertise for Public Hearing - Lease of … - Cover Sheet": the item's number, its title,
// and which of its files this is.
export interface DocumentLink {
  label: string;
  url: string;
}
export interface ConsentItem {
  id: string;
  number: string; // I.1
  title: string;
  links: DocumentLink[];
  pulled?: boolean; // pulled from the consent agenda, to be discussed on its own
  at?: number; // when it was discussed (seconds into the first part)
}
export const consentMarkId = (recordingId: string) => `${recordingId}:consent`;

// "I.1. Title - Cover Sheet" (line breaks and all, as copied) → its number, title, and file label.
export function parseDocumentName(text: string) {
  // A word broken at a hyphen across lines (County-⏎Owned) joins up; other line breaks are spaces.
  const clean = text
    .replace(/-[ \t]*\r?\n\s*/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  const numbered = clean.match(/^((?:[IVXLC]+|[A-Z]|\d+)(?:\.\d+)+|\d+)\.?\s+(.+)$/);
  const number = numbered ? numbered[1] : '';
  let title = numbered ? numbered[2] : clean;
  let label = '';
  // A short last part after " - " names the file (Cover Sheet, Resolution, Staff Report).
  const dash = title.lastIndexOf(' - ');
  if (dash > 0 && title.length - dash - 3 <= 40) {
    label = title.slice(dash + 3).trim();
    title = title.slice(0, dash).trim();
  }
  return { number, title, label };
}

// Item numbers in agenda order: I.2 before I.10, II after I (Roman numerals read as numbers).
const ROMAN: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100 };
const romanValue = (text: string) =>
  [...text].reduce(
    (sum, letter, index, letters) =>
      ROMAN[letters[index + 1]] > ROMAN[letter] ? sum - ROMAN[letter] : sum + ROMAN[letter],
    0
  );
const partValue = (part: string) =>
  /^\d+$/.test(part) ? Number(part) : /^[IVXLC]+$/.test(part) ? romanValue(part) : part.charCodeAt(0) - 64;
export function byNumber(a: { number: string }, b: { number: string }) {
  const [left, right] = [a.number.split('.'), b.number.split('.')];
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = partValue(left[index] || '0') - partValue(right[index] || '0');
    if (difference) return difference;
  }
  return 0;
}

// Every document of the meeting, for linking words of the transcript to one.
export function meetingDocuments({
  consent,
  chapters,
  official
}: {
  consent: ConsentItem[];
  chapters: { title: string; links?: DocumentLink[] }[];
  official: { group: string; label: string; url: string }[];
}) {
  return [
    ...[...consent].sort(byNumber).flatMap((item) =>
      item.links.map((link) => ({
        group: 'Consent agenda',
        label: `${item.number} ${item.title}${link.label ? ` – ${link.label}` : ''}`.trim(),
        url: link.url
      }))
    ),
    ...chapters.flatMap((chapter) =>
      (chapter.links || []).map((link) => ({
        group: 'Chapters',
        label: `${chapter.title} – ${link.label}`,
        url: link.url
      }))
    ),
    ...official.filter((link) => link.group === 'Documents')
  ];
}
