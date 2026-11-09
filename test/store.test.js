import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMatch } from '../src/store.js';
import zlib from 'node:zlib';
import { idsInMatches, readPng, shrinkPng } from '../src/icons.js';

const participant = (puuid, placement, unit, item) => ({
  puuid,
  placement,
  level: 8,
  last_round: 30,
  time_eliminated: 1500.25,
  total_damage_to_players: 50,
  gold_left: 3,
  riotIdGameName: `name-${puuid}`,
  riotIdTagline: 'NA1',
  traits: [
    { name: `Trait_${puuid}`, num_units: 2, style: 1, tier_current: 1 },
    { name: 'Trait_Inactive', num_units: 1, style: 0, tier_current: 0 },
  ],
  units: [{ character_id: unit, tier: 2, rarity: 1, itemNames: [item] }],
  companion: { content_ID: `tactician-${puuid}` },
});

const raw = {
  metadata: { match_id: 'NA1_1' },
  info: {
    game_datetime: 2000,
    gameCreation: 1000,
    game_length: 1800,
    queue_id: 1100,
    tft_set_number: 18,
    game_version: 'Version 16.5.1',
    participants: [participant('team', 2, 'Unit_Team', 'Item_Team'), participant('foe', 1, 'Unit_Foe', 'Item_Foe')],
  },
};

test('a saved game keeps full detail for the team and name + board for everyone else', () => {
  const m = normalizeMatch(raw, new Set(['team']));
  assert.deepEqual(Object.keys(m.players), ['team']);
  assert.equal(m.players.team.tactician, 'tactician-team');
  assert.deepEqual(m.others, [{
    name: 'name-foe',
    tag: 'NA1',
    placement: 1,
    level: 8,
    traits: [{ name: 'Trait_foe', units: 2, style: 1 }],
    units: [{ id: 'Unit_Foe', star: 2, rarity: 1, items: ['Item_Foe'] }],
    tactician: 'tactician-foe',
  }]);
});

const diamond = { tier: 'DIAMOND', rank: 'I', lp: 52 };
const master = { tier: 'MASTER', rank: 'I', lp: 12 };

test('ranks read right after a game are saved for everyone, and unranked is told apart from unknown', () => {
  const m = normalizeMatch(raw, new Set(['team']), undefined, new Map([['team', master], ['foe', null]]));
  assert.deepEqual(m.players.team.rank, master);
  assert.equal(m.others[0].rank, null);

  const lookupFailed = normalizeMatch(raw, new Set(['team']), undefined, new Map());
  assert.equal('rank' in lookupFailed.others[0], false);
  assert.equal('rank' in lookupFailed.players.team, false);
});

test('re-downloading a game keeps the ranks saved the first time', () => {
  const first = normalizeMatch(raw, new Set(['team']), undefined, new Map([['team', master], ['foe', diamond]]));
  const again = normalizeMatch(raw, new Set(['team']), first);
  assert.deepEqual(again.players.team.rank, master);
  assert.deepEqual(again.others[0].rank, diamond);
});

test('re-downloading an older game adds no rank', () => {
  const old = normalizeMatch(raw, new Set(['team']));
  delete old.others;
  const again = normalizeMatch(raw, new Set(['team']), old);
  assert.equal('rank' in again.others[0], false);
});

test('a game with only teammates still counts as having its other boards saved', () => {
  const m = normalizeMatch(raw, new Set(['team', 'foe']));
  assert.deepEqual(m.others, []);
});

test('icons are collected from opponents too', () => {
  const ids = idsInMatches([normalizeMatch(raw, new Set(['team']))]);
  assert.ok(ids.units.has('Unit_Foe'));
  assert.ok(ids.items.has('Item_Foe'));
  assert.ok(ids.traits.has('Trait_foe'));
  assert.deepEqual([...ids.tacticians].sort(), ['tactician-foe', 'tactician-team']);
});

// Builds a small unfiltered PNG; `pixel(x, y)` returns the bytes for one pixel.
function makePng(w, h, color, pixel, { interlace = 0, extra = [] } = {}) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]), len = Buffer.alloc(4), crc = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w, 0);
  header.writeUInt32BE(h, 4);
  header[8] = 8;
  header[9] = color;
  header[12] = interlace;
  const rows = [];
  for (let y = 0; y < h; y++) {
    rows.push(0);
    for (let x = 0; x < w; x++) rows.push(...pixel(x, y));
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), ...extra.map(([t, d]) => chunk(t, d)),
    chunk('IDAT', zlib.deflateSync(Buffer.from(rows))), chunk('IEND', Buffer.alloc(0))]);
}
const RED = [255, 0, 0, 255], GREEN = [0, 200, 0, 255];
const pixelAt = (img, x, y) => [...img.rgba.subarray((y * img.w + x) * 4, (y * img.w + x + 1) * 4)];

test('a wide tactician image becomes a small square of its center', () => {
  const wide = makePng(12, 4, 6, (x) => (x >= 4 && x < 8 ? GREEN : RED));
  const out = readPng(shrinkPng(wide, 2));
  assert.deepEqual([out.w, out.h], [2, 2]);
  for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]]) assert.deepEqual(pixelAt(out, x, y), GREEN);
});

test('colors average when shrinking, and transparent pixels add no color', () => {
  const clear = [0, 0, 0, 0];
  const out = readPng(shrinkPng(makePng(4, 4, 6, (x) => (x % 2 ? clear : RED)), 2));
  assert.deepEqual(pixelAt(out, 0, 0), [255, 0, 0, 128]);
});

test('palette images are read with their transparency', () => {
  const extra = [['PLTE', Buffer.from([255, 0, 0, 0, 200, 0])], ['tRNS', Buffer.from([0])]];
  const img = readPng(makePng(2, 1, 3, (x) => [x], { extra }));
  assert.deepEqual(pixelAt(img, 0, 0), [255, 0, 0, 0]);
  assert.deepEqual(pixelAt(img, 1, 0), GREEN);
});

test('images that are small already, or unreadable, are saved unchanged', () => {
  const small = makePng(4, 4, 6, () => RED);
  assert.equal(shrinkPng(small, 96), small);
  const interlaced = makePng(200, 200, 6, () => RED, { interlace: 1 });
  assert.equal(shrinkPng(interlaced, 96), interlaced);
  const notPng = Buffer.from('not an image at all, just some text padding it out');
  assert.equal(shrinkPng(notPng, 96), notPng);
});

test('games saved before opponents were kept still work', () => {
  const old = normalizeMatch(raw, new Set(['team']));
  delete old.others;
  assert.ok(idsInMatches([old]).units.has('Unit_Team'));
});
