// What a place is called (web/src/locations/types.ts): its name first, then its street address (with its town,
// county, and ZIP when they aren't where the meeting is), its coordinates, its tax map id, or what it is on the map.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { curved, hasAnything, placeName, placeText } from '../web/src/locations/types.ts';

test("a place's name, by what's given", () => {
  const around = { city: 'Front Royal', postal: '22630' };
  const address = { address: '229 Stokes Airport Road', city: 'Front Royal', state: 'VA', postal: '22630' };
  assert.equal(
    placeName({ ...address, name: 'Front Royal-Warren County Airport' }, around),
    'Front Royal-Warren County Airport'
  );
  assert.equal(
    placeName(address, around),
    '229 Stokes Airport Road',
    "in the meeting's town and ZIP: the street alone"
  );
  assert.equal(
    placeName(
      { address: '100 Main Street', city: 'Strasburg', county: 'Shenandoah', state: 'VA', postal: '22657' },
      around
    ),
    '100 Main Street, Strasburg, Shenandoah County, VA 22657'
  );
  assert.equal(placeName({ latitude: 38.91821, longitude: -78.19441 }), '38.91821, -78.19441');
  assert.equal(placeName({ taxMap: '20A-1-2' }), 'Tax map 20A-1-2');
  assert.equal(
    placeName({
      paths: [
        [
          [38.9, -78.2],
          [38.91, -78.19]
        ]
      ]
    }),
    'Roads on the map'
  );
  assert.equal(hasAnything({}), false, 'a place needs something');
  assert.equal(hasAnything({ circle: { center: [38.9, -78.2], radius: 200 } }), true);
});

test('roads: by name and route number; found by either; curved between points', () => {
  assert.equal(placeName({ roadName: 'Poe Drive', routeNumber: '682' }), 'Poe Drive (Route 682)');
  assert.equal(placeName({ routeNumber: 'SR 682' }), 'Route 682');
  assert.equal(placeName({ roadName: 'Poe Drive' }), 'Poe Drive');
  const poe = placeText({ roadName: 'Poe Drive', routeNumber: '682', aliases: ['Old Poe Road'] });
  for (const words of ['682', 'route 682', 'poe drive', 'old poe']) assert.ok(poe.includes(words), words);
  const points = [
    [38.9, -78.2],
    [38.91, -78.19],
    [38.9, -78.18]
  ];
  assert.deepEqual(curved(points, 0), points, 'straight: the points themselves');
  const smooth = curved(points, 1);
  assert.equal(smooth.length, 21, 'a curve: ten steps between each pair');
  assert.deepEqual(smooth.at(-1), points.at(-1), 'through the last point');
  assert.ok(smooth[5][0] > 38.905, 'bowed outward between the first two points');
});
