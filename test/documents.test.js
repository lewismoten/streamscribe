// A meeting's documents (web/src/meeting/documents.ts): a name pasted from an agenda read as its item's number, title,
// and file; items in agenda order; and every document of a meeting gathered for linking transcript words to one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byNumber, meetingDocuments, parseDocumentName } from '../web/src/meeting/documents.ts';

test('a pasted document name: number, title, and file (line breaks and all)', () => {
  assert.deepEqual(
    parseDocumentName(`I.1. Authorization to Advertise for Public Hearing - Lease of County-
Owned Property located at 229 Stokes Airport Road to Frederik
Willem van Weezendonk - Cover Sheet`),
    {
      number: 'I.1',
      title:
        'Authorization to Advertise for Public Hearing - Lease of County-Owned Property located at 229 Stokes Airport Road to Frederik Willem van Weezendonk',
      label: 'Cover Sheet'
    }
  );
  assert.deepEqual(parseDocumentName('A Resolution honoring 4-H Week'), {
    number: '',
    title: 'A Resolution honoring 4-H Week',
    label: ''
  });
  assert.equal(parseDocumentName('12. Adjournment').number, '12');
});

test("agenda order, and a meeting's documents together", () => {
  const items = ['I.10', 'II.1', 'I.2', 'I.1'].map((number) => ({ number }));
  assert.deepEqual(
    items.sort(byNumber).map((item) => item.number),
    ['I.1', 'I.2', 'I.10', 'II.1']
  );
  const documents = meetingDocuments({
    consent: [{ id: 'a', number: 'I.1', title: 'Lease', links: [{ label: 'Cover Sheet', url: 'https://x/1' }] }],
    chapters: [{ title: 'Budget', links: [{ label: 'Draft minutes', url: 'https://x/2' }] }],
    official: [
      { group: 'Documents', label: 'Agenda', url: 'https://x/3' },
      { group: 'Official video', label: 'Watch', url: 'https://x/4' }
    ]
  });
  assert.deepEqual(
    documents.map((document) => `${document.group}: ${document.label}`),
    ['Consent agenda: I.1 Lease – Cover Sheet', 'Chapters: Budget – Draft minutes', 'Documents: Agenda']
  );
});
