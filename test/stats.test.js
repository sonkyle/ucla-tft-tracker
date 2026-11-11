import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProfile, profileUrl } from '../src/tactics.js';
import {
  ladderScore, attributeLp, mergeLp, rankHistory, rankPoints, apexCutoff, parseRank, weekOf, weekOfFrom, weekFromKey, weekRange, weeklySummary, elimTime, matchTime, RANKED_QUEUE,
} from '../src/stats.js';

const TZ = 'America/Los_Angeles';
const MIN = 60e3;

test('ladderScore puts every rank on one scale', () => {
  assert.equal(ladderScore({ tier: 'IRON', rank: 'IV', lp: 0 }), 0);
  assert.equal(ladderScore({ tier: 'GOLD', rank: 'II', lp: 50 }), 1450);
  assert.equal(ladderScore({ tier: 'DIAMOND', rank: 'I', lp: 99 }), 2799);
  assert.equal(ladderScore({ tier: 'MASTER', rank: 'I', lp: 0 }), 2800);
  assert.equal(ladderScore({ tier: 'CHALLENGER', rank: 'I', lp: 900 }), 3700);
  assert.equal(ladderScore({ tier: null }), null);
  // Demotion from Master 10 LP to Diamond I 75 LP is -35, not a tier jump.
  assert.equal(ladderScore({ tier: 'DIAMOND', rank: 'I', lp: 75 }) - ladderScore({ tier: 'MASTER', rank: 'I', lp: 10 }), -35);
});

test('weeks start Monday midnight Pacific, across the DST change', () => {
  // DST ends Sun Nov 1 2026, so Mon Nov 2 00:00 PST = 08:00 UTC.
  assert.equal(weekOf(Date.UTC(2026, 10, 2, 7, 59), TZ).key, '2026-10-26');
  const w = weekOf(Date.UTC(2026, 10, 2, 8, 0), TZ);
  assert.equal(w.key, '2026-11-02');
  assert.equal(w.start, Date.UTC(2026, 10, 2, 8));
  assert.equal(w.end, Date.UTC(2026, 10, 9, 8));
  const prev = weekOf(Date.UTC(2026, 9, 28), TZ);
  assert.equal(prev.start, Date.UTC(2026, 9, 26, 7)); // PDT
  assert.equal(prev.end, w.start);
  const range = weekRange(Date.UTC(2026, 9, 20), Date.UTC(2026, 10, 5), TZ);
  assert.deepEqual(range.map((x) => x.key), ['2026-11-02', '2026-10-26', '2026-10-19']);
});

test('weeks can start Wednesday 10pm Pacific and are named by their Thursday', () => {
  const at = (key) => weekOf(key, TZ, 3, 22 * 60);
  // Wed Nov 4 2026 (PST, UTC-8): 21:59 is still the old week, 22:00 starts the new one
  assert.equal(at(Date.UTC(2026, 10, 5, 5, 59)).key, '2026-10-29');
  const w = at(Date.UTC(2026, 10, 5, 6, 0));
  assert.equal(w.key, '2026-11-05');
  assert.equal(w.start, Date.UTC(2026, 10, 5, 6));
  assert.equal(w.end, Date.UTC(2026, 10, 12, 6));
  // Thursday through Wednesday afternoon are in the same week
  assert.equal(at(Date.UTC(2026, 10, 5, 20)).key, '2026-11-05');
  assert.equal(at(Date.UTC(2026, 10, 11, 20)).key, '2026-11-05');
  // A week that spans the DST change (Sun Nov 1) still starts and ends at 22:00 local
  const dst = at(Date.UTC(2026, 9, 31));
  assert.equal(dst.key, '2026-10-29');
  assert.equal(dst.start, Date.UTC(2026, 9, 29, 5)); // Wed Oct 28 22:00 PDT
  assert.equal(dst.end, w.start); // Wed Nov 4 22:00 PST
  assert.deepEqual(weekFromKey('2026-11-05', TZ, 22 * 60), { key: '2026-11-05', start: w.start, end: w.end });
  const range = weekRange(Date.UTC(2026, 9, 22, 12), Date.UTC(2026, 10, 6), TZ, 3, 22 * 60);
  assert.deepEqual(range.map((x) => x.key), ['2026-11-05', '2026-10-29', '2026-10-22']);
});

test('switching to a 10pm start leaves earlier weeks alone and stretches the last old week', () => {
  const at = (t) => weekOfFrom(t, TZ, 3, 22 * 60, '2026-11-11');
  const old = (t) => weekOf(t, TZ, 3);
  // earlier weeks: unchanged Wednesday-midnight weeks
  for (const t of [Date.UTC(2026, 9, 21, 12), Date.UTC(2026, 9, 30), Date.UTC(2026, 10, 4, 7, 59)]) assert.deepEqual(at(t), old(t));
  // Week of Nov 4 runs from Wed Nov 4 00:00 to Wed Nov 11 22:00 PST, so all of Wednesday Nov 11 until 10pm is in it
  const stretched = { key: '2026-11-04', start: Date.UTC(2026, 10, 4, 8), end: Date.UTC(2026, 10, 12, 6) };
  assert.deepEqual(at(Date.UTC(2026, 10, 4, 8)), stretched);
  assert.deepEqual(at(Date.UTC(2026, 10, 11, 9)), stretched); // Wed Nov 11, 1am
  assert.deepEqual(at(Date.UTC(2026, 10, 12, 5, 59)), stretched); // Wed Nov 11, 9:59pm
  // from then on, weeks start Wednesday 10pm and are named by their Thursday
  assert.deepEqual(at(Date.UTC(2026, 10, 12, 6)), { key: '2026-11-12', start: Date.UTC(2026, 10, 12, 6), end: Date.UTC(2026, 10, 19, 6) });
  assert.equal(at(Date.UTC(2026, 10, 19, 6)).key, '2026-11-19');
  const range = weekRange(Date.UTC(2026, 9, 29), Date.UTC(2026, 10, 20), TZ, 3, 22 * 60, '2026-11-11');
  assert.deepEqual(range.map((w) => w.key), ['2026-11-19', '2026-11-12', '2026-11-04', '2026-10-28']);
  assert.ok(range.every((w, i) => i === 0 || w.end === range[i - 1].start), 'weeks leave no gaps');
});

test('elimination time is measured back from game end', () => {
  const m = { created: 1_000_000, datetime: 1_000_000 + 2_000_000 + 30_000, length: 2000 };
  assert.equal(matchTime(m), m.datetime);
  assert.equal(elimTime(m, { elim: 1500 }), m.datetime - 500_000);
});

const snap = (t, tier, rank, lp, games) => ({ t, tier, rank, lp, wins: 0, losses: games });

test('one game between snapshots gets the exact LP change', () => {
  const snaps = [snap(0, 'GOLD', 'II', 50, 10), snap(40 * MIN, 'GOLD', 'II', 80, 11), snap(80 * MIN, 'GOLD', 'I', 10, 12)];
  const games = [{ id: 'a', e: 30 * MIN, time: 31 * MIN }, { id: 'b', e: 70 * MIN, time: 75 * MIN }];
  const { lpByMatch } = attributeLp(snaps, games);
  assert.deepEqual(lpByMatch.get('a'), { delta: 30, games: 1 });
  assert.deepEqual(lpByMatch.get('b'), { delta: 30, games: 1 }); // Gold II 80 -> Gold I 10
});

test('two games in one poll window share a combined delta', () => {
  const snaps = [snap(0, 'GOLD', 'II', 50, 10), snap(90 * MIN, 'GOLD', 'II', 20, 12)];
  const games = [{ id: 'a', e: 30 * MIN, time: 31 * MIN }, { id: 'b', e: 70 * MIN, time: 75 * MIN }];
  const { lpByMatch } = attributeLp(snaps, games);
  assert.deepEqual(lpByMatch.get('a'), { delta: -30, games: 2, at: 90 * MIN });
  assert.deepEqual(lpByMatch.get('b'), { delta: -30, games: 2, at: 90 * MIN });
});

test('a game estimated just past a poll is pulled back into the right window', () => {
  const snaps = [snap(0, 'GOLD', 'II', 50, 10), snap(40 * MIN, 'GOLD', 'II', 80, 11), snap(80 * MIN, 'GOLD', 'II', 60, 12)];
  const games = [{ id: 'a', e: 41 * MIN, time: 41 * MIN }, { id: 'b', e: 70 * MIN, time: 75 * MIN }];
  const { lpByMatch } = attributeLp(snaps, games);
  assert.equal(lpByMatch.get('a').delta, 30);
  assert.equal(lpByMatch.get('b').delta, -20);
});

test('count mismatch (missing match) leaves the game unattributed instead of guessing', () => {
  const snaps = [snap(0, 'GOLD', 'II', 50, 10), snap(90 * MIN, 'GOLD', 'II', 20, 12)];
  const { lpByMatch } = attributeLp(snaps, [{ id: 'a', e: 30 * MIN, time: 31 * MIN }]);
  assert.equal(lpByMatch.size, 0);
});

test('season reset is not counted as an LP change', () => {
  const snaps = [snap(0, 'DIAMOND', 'II', 50, 200), snap(60 * MIN, 'IRON', 'IV', 30, 1)];
  const { transitions, lpByMatch } = attributeLp(snaps, [{ id: 'a', e: 30 * MIN, time: 30 * MIN }]);
  assert.equal(transitions[0].dScore, null);
  assert.equal(lpByMatch.size, 0);
});

test('weekly summary sums LP per week, including decay, and flags partial weeks', () => {
  const w1 = weekOf(Date.UTC(2026, 9, 28), TZ);
  const w2 = weekOf(Date.UTC(2026, 10, 4), TZ);
  const t = (w, h) => w.start + h * 3600e3;
  const snaps = [
    snap(t(w1, 30), 'GOLD', 'II', 50, 10),
    snap(t(w1, 31), 'GOLD', 'II', 90, 11),  // +40 in w1
    snap(t(w2, 10), 'GOLD', 'I', 10, 12),   // +20 in w2
    snap(t(w2, 50), 'GOLD', 'II', 95, 12),  // -15 decay/adjustment in w2, no game
  ];
  const games = [
    { id: 'a', e: t(w1, 30.5), time: t(w1, 30.5), queue: RANKED_QUEUE, placement: 2 },
    { id: 'b', e: t(w2, 9), time: t(w2, 9), queue: RANKED_QUEUE, placement: 3 },
    { id: 'c', e: t(w2, 20), time: t(w2, 20), queue: 1090, placement: 8 },
  ];
  const { transitions } = attributeLp(snaps, games.filter((g) => g.queue === RANKED_QUEUE));
  const s = weeklySummary({ snaps, transitions, games, weeks: [w2, w1], now: t(w2, 100) });
  assert.equal(s[w1.key].lp, 40);
  assert.equal(s[w1.key].partial, true);
  assert.equal(s[w2.key].lp, 5);
  assert.equal(s[w2.key].partial, false);
  assert.deepEqual(s[w2.key].ranked, { games: 1, avg: 3, top4: 100, firsts: 0 });
  assert.equal(s[w2.key].otherGames, 1);
  assert.deepEqual(s[w2.key].endRank, { tier: 'GOLD', rank: 'II', lp: 95 });
});

test('tactics.tools LP fills combined groups; a single leftover game gets the exact remainder', () => {
  const ranked = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const lpByMatch = new Map([
    ['a', { delta: 20, games: 1 }],
    ['b', { delta: -45, games: 3, at: 99 }],
    ['c', { delta: -45, games: 3, at: 99 }],
    ['d', { delta: -45, games: 3, at: 99 }],
  ]);
  // tactics.tools knows b and c; d is whatever is left of the -45
  const lp = mergeLp(ranked, lpByMatch, { a: 999, b: -30, c: 10 });
  assert.deepEqual(lp.get('a'), { delta: 20, games: 1 }); // our own exact number wins
  assert.deepEqual(lp.get('b'), { delta: -30, games: 1, src: 'tactics.tools' });
  assert.deepEqual(lp.get('d'), { delta: -25, games: 1 });
  // only one game known: the other two still share the remainder
  const lp2 = mergeLp(ranked, lpByMatch, { b: -30 });
  assert.deepEqual(lp2.get('c'), { delta: -15, games: 2, at: 99 });
  assert.deepEqual(lp2.get('d'), { delta: -15, games: 2, at: 99 });
});

test('weeks before tracking use summed per-game LP when every ranked game has one', () => {
  const w0 = weekOf(Date.UTC(2026, 9, 21), TZ);
  const w1 = weekOf(Date.UTC(2026, 9, 28), TZ);
  const t = (w, h) => w.start + h * 3600e3;
  const snaps = [snap(t(w1, 30), 'GOLD', 'II', 50, 10), snap(t(w1, 31), 'GOLD', 'II', 90, 11)];
  const games = [
    { id: 'x', time: t(w0, 5), queue: RANKED_QUEUE, placement: 1 },
    { id: 'y', time: t(w0, 6), queue: RANKED_QUEUE, placement: 7 },
    { id: 'z', time: t(w1, 2), queue: RANKED_QUEUE, placement: 4 },
    { id: 'a', e: t(w1, 30.5), time: t(w1, 30.5), queue: RANKED_QUEUE, placement: 2 },
  ];
  const { transitions } = attributeLp(snaps, games.filter((g) => g.e));
  const gameLp = new Map([['x', { delta: 40, games: 1 }], ['y', { delta: -25, games: 1 }], ['z', { delta: 10, games: 1 }], ['a', { delta: 40, games: 1 }]]);
  const s = weeklySummary({ snaps, transitions, games, weeks: [w1, w0], now: t(w1, 100), gameLp });
  assert.equal(s[w0.key].lp, 15);
  assert.equal(s[w0.key].fromGames, true);
  assert.equal(s[w1.key].lp, 50); // tracking began mid-week, but every game is known
  assert.equal(s[w1.key].partial, false);
  // missing one game's LP -> falls back to the rank checks
  gameLp.delete('z');
  const s2 = weeklySummary({ snaps, transitions, games, weeks: [w1, w0], now: t(w1, 100), gameLp });
  assert.equal(s2[w1.key].lp, 40);
  assert.equal(s2[w1.key].partial, true);
});

test('tactics.tools profile parsing', () => {
  assert.equal(profileUrl('UCLA sws', 'tft', 'na1'), 'https://tactics.tools/player/na/UCLA%20sws/tft');
  const page = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps: { initialData: { matches: [
      { id: 'NA1_1', queueId: 1100, lpDiff: 18, rankBefore: ['MASTER I', 20], rankAfter: ['MASTER I', 38] }, { id: 'NA1_2', queueId: 1090, lpDiff: null }, { id: 'NA1_3', queueId: 1100, lpDiff: -60 },
    ] } } },
  })}</script></html>`;
  assert.deepEqual(parseProfile(page).games, { NA1_1: 18, NA1_3: -60 });
  assert.deepEqual(parseProfile(page).ranks, { NA1_1: { before: ['MASTER', 'I', 20], after: ['MASTER', 'I', 38] } });
  assert.equal(parseProfile('<html>nope</html>'), null);
});

test('rank history uses per-game ranks where known and rank checks outside that stretch', () => {
  const snaps = [snap(100, 'GOLD', 'II', 0, 5), snap(1000, 'GOLD', 'I', 20, 8), snap(2000, 'GOLD', 'I', 5, 8)];
  const games = [{ id: 'a', time: 200, e: 300 }, { id: 'b', time: 400, e: 500 }, { id: 'c', time: 600, e: 700 }];
  const ranks = {
    a: { before: ['GOLD', 'II', 10], after: ['GOLD', 'II', 40] },
    b: { before: ['GOLD', 'II', 40], after: ['GOLD', 'II', 40] }, // 0 LP game -> repeated value dropped
    c: { before: ['GOLD', 'II', 40], after: ['GOLD', 'I', 20] },
  };
  const g = (div, lp) => ladderScore({ tier: 'GOLD', rank: div, lp });
  assert.deepEqual(rankHistory(snaps, games, ranks), [
    [100, g('II', 0), 'GOLD'], [200, g('II', 10), 'GOLD'], [300, g('II', 40), 'GOLD'], [700, g('I', 20), 'GOLD'], [2000, g('I', 5), 'GOLD'],
  ]);
  // nothing from tactics.tools: just the rank checks
  assert.deepEqual(rankHistory(snaps, games, {}).map(([t]) => t), [100, 1000, 2000]);
});

test('rank history keeps the tier, so apex tiers at the same LP stay apart', () => {
  const snaps = [
    { t: 1, tier: 'MASTER', rank: 'I', lp: 500, wins: 0, losses: 1 },
    { t: 2, tier: 'GRANDMASTER', rank: 'I', lp: 500, wins: 0, losses: 1 }, // cutoff moved, same LP
  ];
  assert.deepEqual(rankHistory(snaps, []).map(([, , tier]) => tier), ['MASTER', 'GRANDMASTER']);
});

test('apex cutoff picks the LP that misplaces the fewest players', () => {
  // lists overlap because Riot only re-sorts the tiers daily
  assert.equal(apexCutoff([0, 100, 200, 300, 450], [180, 400, 500, 600]), 401); // 301..500 all misplace 2
  assert.equal(apexCutoff([0, 50], [100, 200]), 76); // 51..100 all clean
  assert.equal(apexCutoff([], [100]), null);
});

test('rank at end of week uses the latest known rank, including per-game ranks from before tracking', () => {
  const w0 = weekOf(Date.UTC(2026, 9, 21), TZ);
  const w1 = weekOf(Date.UTC(2026, 9, 28), TZ);
  const t = (w, h) => w.start + h * 3600e3;
  const snaps = [snap(t(w1, 30), 'GOLD', 'II', 50, 10)]; // tracking starts mid week 1
  const games = [{ id: 'x', e: t(w0, 5), time: t(w0, 4) }, { id: 'y', e: t(w0, 9), time: t(w0, 8) }];
  const ranks = { x: { after: ['SILVER', 'I', 80] }, y: { after: ['GOLD', 'IV', 10] } };
  const pts = rankPoints(snaps, games, ranks);
  const s = weeklySummary({ snaps, transitions: [], games: [], weeks: [w1, w0], now: t(w1, 100), rankPoints: pts });
  assert.deepEqual(s[w0.key].endRank, { tier: 'GOLD', rank: 'IV', lp: 10 }); // after the week's last game
  assert.deepEqual(s[w1.key].endRank, { tier: 'GOLD', rank: 'II', lp: 50 }); // from the rank check
  // without tactics.tools ranks the earlier week is unknown, as before
  assert.equal(weeklySummary({ snaps, transitions: [], games: [], weeks: [w1, w0], now: t(w1, 100) })[w0.key].endRank, null);
});

test('hand-written ranks parse in short and long forms', () => {
  assert.deepEqual(parseRank('d3 26 lp'), { tier: 'DIAMOND', rank: 'III', lp: 26 });
  assert.deepEqual(parseRank('Diamond III 26 LP'), { tier: 'DIAMOND', rank: 'III', lp: 26 });
  assert.deepEqual(parseRank('E1 0'), { tier: 'EMERALD', rank: 'I', lp: 0 });
  assert.deepEqual(parseRank('Silver IV 5'), { tier: 'SILVER', rank: 'IV', lp: 5 });
  assert.deepEqual(parseRank('GM 512'), { tier: 'GRANDMASTER', rank: 'I', lp: 512 });
  assert.deepEqual(parseRank('Master 0'), { tier: 'MASTER', rank: 'I', lp: 0 });
  assert.equal(parseRank('D 26'), null);      // needs a division below Master
  assert.equal(parseRank('banana 3 4'), null);
});
