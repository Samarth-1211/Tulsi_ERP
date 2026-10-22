import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LatLng, detourEstimate, haversineKm, nearestNeighbourOrder, positionOnRoute, routeZone, spellingVariants, thinRoute } from '../../src/modules/trips/utils/route-geometry.util';
import { correctedName, latinFirst, medianPoint, pickPlace, soundsSame, tidyCityName } from '../../src/modules/trips/utils/city-match.util';

// Rough road Indore → Dewas → Sehore → Bhopal (AB Road / NH52).
const INDORE: LatLng = [22.7196, 75.8577];
const DEWAS: LatLng = [22.9623, 76.0508];
const SEHORE: LatLng = [23.2032, 77.0844];
const BHOPAL: LatLng = [23.2599, 77.4126];
const UJJAIN: LatLng = [23.1765, 75.7885];
const ROAD: LatLng[] = [INDORE, DEWAS, SEHORE, BHOPAL];

const place = (name: string, state = 'Madhya Pradesh') => ({ name, state, district: null, lat: 0, lng: 0 });

describe('Trip planner — route geometry', () => {
  it('measures distances like a map does', () => {
    const km = haversineKm(INDORE, BHOPAL);
    assert.ok(km > 165 && km < 175, `Indore–Bhopal is ~170 km as the crow flies, got ${km}`);
  });

  it('puts cities on the road in travel order with how far along they are', () => {
    const dewas = positionOnRoute(ROAD, DEWAS);
    const sehore = positionOnRoute(ROAD, SEHORE);
    assert.ok(dewas.offKm < 0.5 && sehore.offKm < 0.5);
    assert.ok(dewas.alongKm > 30 && dewas.alongKm < 40, `Dewas ~33 km from Indore, got ${dewas.alongKm}`);
    assert.ok(sehore.alongKm > dewas.alongKm);
  });

  it('knows a city off the road is off the road', () => {
    const ujjain = positionOnRoute(ROAD, UJJAIN);
    assert.ok(ujjain.offKm > 30, `Ujjain is well north of the Indore–Bhopal road, got ${ujjain.offKm} km`);
  });

  it('thins a dense route but keeps both ends', () => {
    const dense: LatLng[] = Array.from({ length: 1000 }, (_, i) => [INDORE[0] + (i / 999) * 0.5, INDORE[1] + (i / 999) * 1.5]);
    const thin = thinRoute(dense, 2);
    assert.ok(thin.length < 120);
    assert.deepEqual(thin[0], [22.7196, 75.8577]);
    assert.equal(thin[thin.length - 1][0], Math.round(dense[999][0] * 1e5) / 1e5);
  });
});

describe('Trip planner — city spelling', () => {
  it('hears Devas, Dewas and देवास as one name, but not Dhar', () => {
    assert.ok(soundsSame('Devas', 'Dewas'));
    assert.ok(soundsSame('देवास', 'Dewas'));
    assert.ok(!soundsSame('Dhar', 'Dewas'));
  });

  it('tries v↔w and similar swaps, likely first', () => {
    const v = spellingVariants('Devas');
    assert.equal(v[0], 'Dewas');
    assert.ok(!v.includes('Devas'));
  });

  it('only accepts a variant that sounds like what was typed, in the org’s state', () => {
    assert.equal(pickPlace('Devas', [place('Dewas')], { isVariant: true, state: 'Madhya Pradesh' })?.name, 'Dewas');
    assert.equal(pickPlace('Devas', [place('Dewa Sharif', 'Uttar Pradesh')], { isVariant: true, state: 'Madhya Pradesh' }), null);
    assert.equal(pickPlace('Devas', [place('Dhar')], { isVariant: true }), null);
  });

  it('never takes a namesake far from the business (इंदौर is not the Indor in Rajasthan)', () => {
    const indorRajasthan = { name: 'Indor', state: 'Rajasthan', district: null, lat: 28.094, lng: 76.943 };
    const indore = { name: 'Indore', state: 'Madhya Pradesh', district: null, lat: 22.72, lng: 75.868 };
    assert.equal(pickPlace('इंदौर', [indorRajasthan], { isVariant: false, base: DEWAS }), null);
    assert.equal(pickPlace('इंदौर', [indorRajasthan, indore], { isVariant: false, base: DEWAS })?.name, 'Indore');
    assert.deepEqual(medianPoint([INDORE, DEWAS, BHOPAL]), [DEWAS[0], DEWAS[1]]);
  });

  it('looks up English-script names before Hindi ones', () => {
    assert.deepEqual(latinFirst([{ name: 'इंदौर' }, { name: 'Indore' }]).map((c) => c.name), ['Indore', 'इंदौर']);
  });

  it('trusts OSM for the typed name itself (alternate names like Mhow)', () => {
    assert.equal(pickPlace('Mhow', [place('Dr. Ambedkar Nagar')], { isVariant: false, state: 'Madhya Pradesh' })?.name, 'Dr. Ambedkar Nagar');
  });

  it('keeps the typed name unless OSM spells the same name better', () => {
    assert.equal(correctedName('Devas', place('Dewas')), 'Dewas');
    assert.equal(correctedName('देवास', place('Dewas')), 'Dewas');
    assert.equal(correctedName('mhow', place('Dr. Ambedkar Nagar')), 'Mhow');
    assert.equal(tidyCityName('  INDORE  '), 'Indore');
  });
});

describe('Trip planner — order, detours, zones', () => {
  it('orders stops nearest-next when the routing service is down, ends fixed', () => {
    // Indore, Bhopal, Dewas, Sehore, Bhopal-ish end: Dewas should come before Sehore.
    const order = nearestNeighbourOrder([INDORE, SEHORE, DEWAS, BHOPAL]);
    assert.deepEqual(order, [0, 2, 1, 3]);
  });

  it('estimates a side trip as there-and-back on smaller roads', () => {
    const d = detourEstimate(20);
    assert.equal(Math.round(d.extraKm), 52);
    assert.equal(Math.round(d.extraMin), 78);
  });

  it('puts a city beside the start in "start", not "on the way"', () => {
    assert.equal(routeZone({ alongKm: 0, offKm: 20.6 }, 730), 'start'); // Mhow on Indore → Delhi
    assert.equal(routeZone({ alongKm: 57, offKm: 1.2 }, 730), 'route'); // Ujjain
    assert.equal(routeZone({ alongKm: 725, offKm: 15 }, 730), 'end');
  });
});
