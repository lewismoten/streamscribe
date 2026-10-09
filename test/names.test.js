// People's names and links (web/src/people/names.ts): a name in parts shown as Title First “Nick” Last, Suffix; and a
// pasted link read as an id under a kind of link, including ids in the query (a staff directory's ?eid=34).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fullName, linkUrl, readLink, siteName } from '../web/src/people/names.ts';

test('names: parts, a nickname, a suffix; older formal names split', () => {
  assert.equal(
    fullName({ honorific: 'Hon.', first: 'Victoria', last: 'Cook', suffix: 'Jr.', nicknames: ['Vicky'] }),
    'Hon. Victoria “Vicky” Cook, Jr.'
  );
  assert.equal(fullName({ formalName: 'Zachary Henderson', nicknames: ['Zach'] }), 'Zachary “Zach” Henderson');
  assert.equal(
    fullName({ first: 'Lewis', last: 'Moten', nicknames: ['Lewis'] }),
    'Lewis Moten',
    'a nickname like the name'
  );
  assert.equal(fullName({ nicknames: ['Lewie'] }), '', 'no name parts: the roster name is used');
});

test('links: ids at the end of the path or in the query; other sites by name', () => {
  const kinds = [{ id: 'va', name: 'Virginia elections', url: 'https://historical.elections.virginia.gov/candidate/' }];
  assert.deepEqual(readLink('https://historical.elections.virginia.gov/candidate/87362', kinds), {
    kind: kinds[0],
    id: '87362'
  });
  assert.deepEqual(readLink('https://va-warrencounty.civicplus.com/m/directory/employee?eid=34', kinds), {
    prefix: 'https://va-warrencounty.civicplus.com/m/directory/employee?eid=',
    id: '34'
  });
  const directory = {
    id: 'staff',
    name: 'County staff directory',
    url: 'https://va-warrencounty.civicplus.com/m/directory/employee?eid='
  };
  assert.equal(linkUrl(directory, '34'), 'https://va-warrencounty.civicplus.com/m/directory/employee?eid=34');
  assert.equal(readLink('not a link', kinds), null);
  assert.equal(siteName('https://www.facebook.com/someone'), 'Facebook');
  assert.equal(siteName('https://example.org/page'), 'example.org');
});
