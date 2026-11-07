// Poll the Riot API once: record each player's ranked state (only when it
// changed) and download any matches we haven't stored yet.
//
//   node src/poll.js [--max-matches 400] [--data data] [--config config.json]

import path from 'node:path';
import { RiotClient } from './riot.js';
import { ROOT, arg, loadEnv, loadConfig, DataStore, normalizeMatch } from './store.js';
import { RANKED_QUEUE, matchTime, apexCutoff } from './stats.js';
import { fetchProfileLp } from './tactics.js';
import { syncIcons, idsInMatches } from './icons.js';

const PAGE = 20;

loadEnv();
const cfg = loadConfig(arg('config', path.join(ROOT, 'config.json')));
const store = new DataStore(arg('data', path.join(ROOT, 'data')));
let budget = Number(arg('max-matches', 400));
const riot = new RiotClient(process.env.RIOT_API_KEY, cfg.platform);
const startTime = cfg.trackFromMs ? Math.floor(cfg.trackFromMs / 1000) : undefined;

const sameState = (a, b) =>
  a.tier === b.tier && a.rank === b.rank && a.lp === b.lp && a.wins === b.wins && a.losses === b.losses;

let errors = 0;
const log = (...a) => console.log(...a);

// 1. Riot ID -> PUUID (cached in data/players.json)
for (const p of cfg.players) {
  let rec = store.players[p.key];
  if (!rec?.puuid) {
    const acct = await riot.account(p.gameName, p.tagLine);
    if (!acct) {
      console.error(`✗ Riot ID not found: ${p.riotId} (check spelling and tag in config.json)`);
      errors++;
      continue;
    }
    rec = store.players[p.key] = { riotId: `${acct.gameName}#${acct.tagLine}`, puuid: acct.puuid, backfilled: false };
    log(`resolved ${p.riotId}`);
  }
  p.puuid = rec.puuid;
}
const active = cfg.players.filter((p) => p.puuid);
const tracked = new Set(active.map((p) => p.puuid));

// 2. Ranked snapshots. All players are checked first so snapshot times line up.
const now = Date.now();
let snapsAdded = 0;
for (const p of active) {
  try {
    const entries = (await riot.leagueEntries(p.puuid)) ?? [];
    const e = entries.find((x) => x.queueType === 'RANKED_TFT');
    const snap = e
      ? { t: now, tier: e.tier, rank: e.rank, lp: e.leaguePoints, wins: e.wins, losses: e.losses }
      : { t: now, tier: null, rank: null, lp: 0, wins: 0, losses: 0 };
    const list = (store.snapshots[p.puuid] ??= []);
    if (!list.length || !sameState(list.at(-1), snap)) {
      list.push(snap);
      snapsAdded++;
      log(`rank  ${p.name}: ${snap.tier ? `${snap.tier} ${snap.rank} ${snap.lp} LP (${snap.wins + snap.losses} games)` : 'unranked'}`);
    }
  } catch (err) {
    console.error(`✗ league lookup failed for ${p.name}: ${err.message}`);
    errors++;
  }
}

// 2b. Grandmaster / Challenger LP cutoffs (they move daily), for the rank chart's tier bands.
//     Three league calls, at most once an hour. Failures are warnings only.
if (now - (store.cutoffs.t ?? 0) >= 60 * 60e3) {
  try {
    const lps = async (tier) => ((await riot.apexLeague(tier))?.entries ?? []).map((e) => e.leaguePoints);
    const [m, gm, ch] = [await lps('master'), await lps('grandmaster'), await lps('challenger')];
    const grandmaster = apexCutoff(m, gm), challenger = apexCutoff(gm, ch);
    if (grandmaster != null && challenger != null) {
      store.cutoffs = { t: now, grandmaster, challenger };
      log(`cutoffs Grandmaster ~${grandmaster} LP, Challenger ~${challenger} LP`);
    }
  } catch (err) {
    console.warn(`! apex cutoff lookup failed: ${err.message}`);
  }
}

// 3. Match history. First run pages back to `trackFrom`; later runs stop at
//    the first match we already have. `--max-matches` caps API use per run so
//    a big backfill is spread over several runs instead of timing out.
let fetched = 0;
for (const p of active) {
  const rec = store.players[p.key];
  // Caught up = history already downloaded back to (at least) the current trackFrom.
  // Moving trackFrom earlier makes this false, so older games get fetched once.
  const caughtUp = rec.backfilled && (rec.backfilledFrom ?? Infinity) <= (startTime ?? 0);
  try {
    const fresh = [];
    let reachedEnd = false;
    for (let start = 0; ; start += PAGE) {
      const ids = (await riot.matchIds(p.puuid, { start, count: PAGE, startTime })) ?? [];
      const unknown = ids.filter((id) => !store.matches.get(id)?.players[p.puuid]);
      fresh.push(...unknown);
      if (ids.length < PAGE) { reachedEnd = true; break; }
      if (caughtUp && unknown.length < ids.length) break;
      if (fresh.length >= budget) break;
    }
    const todo = fresh.slice(0, budget);
    for (const id of todo) {
      const raw = await riot.match(id);
      budget--;
      if (!raw) continue;
      store.matches.set(id, normalizeMatch(raw, tracked, store.matches.get(id)));
      fetched++;
    }
    if (reachedEnd && todo.length === fresh.length) {
      rec.backfilled = true;
      rec.backfilledFrom = Math.min(rec.backfilledFrom ?? Infinity, startTime ?? 0);
    }
    if (todo.length < fresh.length) rec.backfilled = false;
    if (todo.length) log(`games ${p.name}: +${todo.length}${rec.backfilled ? '' : ' (backfill continues next run)'}`);
  } catch (err) {
    console.error(`✗ match history failed for ${p.name}: ${err.message}`);
    errors++;
  }
  store.save(); // save as we go so an interrupted backfill keeps its progress
}

// 3b. Matches saved before the tracker kept each player's tactician: re-download them (newest first)
//     with whatever is left of this run's match budget, so the backfill spreads over a few runs.
let refreshed = 0;
{
  const stale = [...store.matches.values()]
    .filter((m) => Object.entries(m.players).some(([puuid, pp]) => tracked.has(puuid) && !('tactician' in pp)))
    .sort((a, b) => b.datetime - a.datetime);
  for (const m of stale.slice(0, Math.max(0, budget))) {
    try {
      const raw = await riot.match(m.id);
      budget--;
      if (!raw) continue;
      store.matches.set(m.id, normalizeMatch(raw, tracked, m));
      refreshed++;
      if (refreshed % 50 === 0) store.save();
    } catch (err) {
      console.error(`✗ re-download of ${m.id} failed: ${err.message}`);
      break;
    }
  }
  if (refreshed) log(`games re-downloaded ${refreshed} older match(es) for tacticians${stale.length > refreshed ? `, ${stale.length - refreshed} left for next run` : ''}`);
}

// 4. Per-game LP from tactics.tools, to fill in games whose LP Riot can't give us
//    (see src/tactics.js). Only players with recent ranked games still missing a
//    number are fetched, each at most every 20 minutes. Failures are warnings only.
let lpFilled = 0;
if (cfg.tacticsTools !== false) {
  const RECENT = 3 * 24 * 3600e3, MIN_GAP = 20 * 60e3;
  for (const p of active) {
    const ext = (store.externalLp[p.puuid] ??= { fetchedAt: 0, games: {} });
    const missing = [...store.matches.values()].filter((m) =>
      m.players[p.puuid] && m.queue === RANKED_QUEUE && matchTime(m) > now - RECENT && !(m.id in ext.games));
    // `ranks` was added later; data saved before then is fetched once more to get it.
    const stale = !ext.fetchedAt || !ext.ranks;
    if (!stale && (!missing.length || now - ext.fetchedAt < MIN_GAP)) continue;
    try {
      const { games, ranks } = await fetchProfileLp(p.gameName, p.tagLine, cfg.platform);
      const before = Object.keys(ext.games).length;
      Object.assign(ext.games, games);
      ext.ranks = Object.assign(ext.ranks ?? {}, ranks);
      ext.fetchedAt = now;
      const added = Object.keys(ext.games).length - before;
      lpFilled += added;
      if (added) log(`lp    ${p.name}: ${added} game(s) from tactics.tools`);
    } catch (err) {
      ext.fetchedAt = now; // don't retry a failing page every run
      console.warn(`! tactics.tools lookup failed for ${p.name}: ${err.message}`);
    }
  }
}

// 5. Trait/item icons and names for anything that doesn't have them yet (about once per set). Warnings only.
let iconsAdded = 0;
try {
  iconsAdded = await syncIcons(idsInMatches(store.matches.values()), path.join(ROOT, 'site', 'img'), store.icons);
  if (iconsAdded) log(`icons ${iconsAdded} new trait/item icon(s)`);
} catch (err) {
  console.warn(`! icon download failed: ${err.message}`);
}

store.save();
log(`done: ${snapsAdded} rank change(s), ${fetched} new match(es), ${lpFilled} LP value(s) from tactics.tools, ${riot.requests} API calls`);
if (errors && errors >= active.length) process.exit(1);
