// Turn data/ (raw snapshots + matches) into the JSON the website reads:
//   site/data/site.json         players, current ranks, weekly LP + stats, rank history
//   site/data/weeks/<key>.json  every tracked player's games that week, with LP deltas
//   site/data/lobbies/<id>.json every board in one game, for the all-boards popup (not committed)
//
//   node src/build.js [--data data] [--out site/data] [--config config.json]

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, arg, loadConfig, DataStore, writeJson } from './store.js';
import { listIcons } from './icons.js';
import {
  RANKED_QUEUE, attributeLp, elimTime, matchTime, ladderScore, weekRange, weeklySummary, mergeLp, rankHistory, rankPoints, parseRank,
} from './stats.js';

const cfg = loadConfig(arg('config', path.join(ROOT, 'config.json')));
const store = new DataStore(arg('data', path.join(ROOT, 'data')));
const outDir = arg('out', path.join(ROOT, 'site', 'data'));
const now = Number(arg('now', Date.now()));

const players = cfg.players
  .map((p) => ({ ...p, rec: store.players[p.key] }))
  .filter((p) => p.rec?.puuid);
const slugOf = new Map(players.map((p) => [p.rec.puuid, p.slug]));
// Games before trackFrom stay on disk but are left off the site.
const matches = [...store.matches.values()].filter((m) => !cfg.trackFromMs || matchTime(m) >= cfg.trackFromMs);

// ---- per-player LP attribution
const lpOf = new Map(); // `${matchId}|${puuid}` -> {delta, games}
const perPlayer = [];
let earliest = now;
for (const p of players) {
  const puuid = p.rec.puuid;
  const snaps = [...(store.snapshots[puuid] ?? [])].sort((a, b) => a.t - b.t);
  const games = [];
  for (const m of matches) {
    const pp = m.players[puuid];
    if (!pp) continue;
    games.push({ id: m.id, time: matchTime(m), e: elimTime(m, pp), queue: m.queue, placement: pp.placement });
  }
  games.sort((a, b) => a.time - b.time);
  const ranked = games.filter((g) => g.queue === RANKED_QUEUE);
  const { transitions, lpByMatch } = attributeLp(snaps, ranked);
  const gameLp = mergeLp(ranked, lpByMatch, store.externalLp[puuid]?.games ?? {});
  for (const g of ranked) {
    const lp = gameLp.get(g.id);
    if (lp) lpOf.set(`${g.id}|${puuid}`, lp);
  }
  if (snaps.length) earliest = Math.min(earliest, snaps[0].t);
  if (games.length) earliest = Math.min(earliest, games[0].time);
  const history = rankHistory(snaps, ranked, store.externalLp[puuid]?.ranks);
  if (history.length) earliest = Math.min(earliest, history[0][0]);
  const points = rankPoints(snaps, ranked, store.externalLp[puuid]?.ranks);
  perPlayer.push({ p, snaps, games, transitions, gameLp, history, points });
}

// Hand-entered end-of-week ranks from config ("endRanks": { "2026-10-21": "D3 26" }) for weeks no
// data source covers. They win over computed ranks. A rank for the week just before the first week
// on the site is allowed too: it's used as the starting rank of that first week.
const shiftKey = (key, days) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};
function withEndRankOverrides(p, weeksOut) {
  const extra = {};
  for (const [key, text] of Object.entries(p.endRanks ?? {})) {
    const r = parseRank(text);
    if (!r) throw new Error(`${p.name}: endRanks["${key}"] = "${text}" isn't a rank (try "D3 26" or "Diamond III 26")`);
    if (weeksOut[key]) { weeksOut[key].endRank = r; weeksOut[key].endRankManual = true; }
    else extra[key] = r;
  }
  // Net LP for weeks that still have none: the change from last week's end rank to this week's.
  // Exact (decay included) whenever both ranks are known.
  const keys = Object.keys(weeksOut).sort();
  keys.forEach((key, i) => {
    const wk = weeksOut[key];
    if (wk.lp != null || !wk.endRank) return;
    const prevKey = i > 0 ? keys[i - 1] : shiftKey(key, -7);
    const prev = weeksOut[prevKey]?.endRank ?? extra[prevKey];
    if (!prev) return;
    wk.lp = ladderScore(wk.endRank) - ladderScore(prev);
    wk.partial = false;
    wk.fromRanks = true;
  });
  for (const key of Object.keys(extra)) {
    if (key !== shiftKey(keys[0], -7)) console.warn(`! ${p.name}: endRanks has "${key}", which isn't a week on the site (or the week before it)`);
  }
  return weeksOut;
}

const weeks = weekRange(earliest, now, cfg.timezone, cfg.weekStartsOn);

// Week numbers count from config.weekOne (the first day of week 1, e.g. the set's launch week).
// Weeks before it, or every week when weekOne isn't set, have no number.
const dayIndex = (key) => { const [y, m, d] = key.split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400e3; };
if (cfg.weekOne && !/^\d{4}-\d{2}-\d{2}$/.test(cfg.weekOne)) throw new Error(`weekOne "${cfg.weekOne}" must look like 2026-09-23`);
// The "Check for new games" button's worker (worker/update-button.js); no button without it.
if (cfg.updateUrl && !/^https:\/\/\S+$/.test(cfg.updateUrl)) throw new Error(`updateUrl "${cfg.updateUrl}" must be an https:// URL`);

const weekNumber = (key) => {
  if (!cfg.weekOne) return null;
  const n = Math.floor((dayIndex(key) - dayIndex(cfg.weekOne)) / 7) + 1;
  return n >= 1 ? n : null;
};

// ---- site.json
const pick = (s) => (s && s.tier ? { tier: s.tier, rank: s.rank, lp: s.lp } : null);
const site = {
  teamName: cfg.teamName ?? 'TFT Team',
  updateUrl: cfg.updateUrl ?? null,
  timezone: cfg.timezone,
  rankedQueue: RANKED_QUEUE,
  queueNames: cfg.queueNames ?? {},
  latestActivity: null,
  // Ids with an icon in site/img/traits, items and units (the site falls back to text otherwise),
  // and in-game names for traits/items from Community Dragon.
  traitIcons: listIcons(path.join(ROOT, 'site', 'img', 'traits')),
  itemIcons: listIcons(path.join(ROOT, 'site', 'img', 'items')),
  unitIcons: listIcons(path.join(ROOT, 'site', 'img', 'units')),
  tacticianIcons: listIcons(path.join(ROOT, 'site', 'img', 'tacticians')),
  names: store.icons.names ?? {},
  unitCosts: store.icons.costs ?? {}, // champion gold cost (1-5), for the portrait border
  // Estimated LP needed for Grandmaster / Challenger (they move daily); null until first polled.
  apexCutoffs: store.cutoffs.t ? { grandmaster: store.cutoffs.grandmaster, challenger: store.cutoffs.challenger, t: store.cutoffs.t } : null,
  weeks: weeks.map(({ key, start, end }) => ({ key, start, end, num: weekNumber(key) })),
  players: perPlayer.map(({ p, snaps, games, transitions, gameLp, history, points }) => {
    const last = snaps.at(-1);
    const peak = snaps.reduce((best, s) => (ladderScore(s) > (ladderScore(best) ?? -1) ? s : best), null);
    const trackedRanked = games.filter((g) => g.queue === RANKED_QUEUE && snaps.length && g.time > snaps[0].t);
    return {
      slug: p.slug,
      name: p.name,
      riotId: p.rec.riotId ?? p.riotId,
      current: last?.tier ? { ...pick(last), wins: last.wins, losses: last.losses } : null,
      peak: peak?.tier ? { ...pick(peak), t: peak.t } : null,
      trackedSince: snaps[0]?.t ?? null,
      lpCoverage: { games: trackedRanked.length, matched: trackedRanked.filter((g) => gameLp.get(g.id)?.games === 1).length },
      weeks: withEndRankOverrides(p, weeklySummary({ snaps, transitions, games, weeks, now, gameLp, rankPoints: points })),
      history,
    };
  }),
};
for (const { snaps, games } of perPlayer) {
  const latest = Math.max(snaps.at(-1)?.t ?? 0, games.at(-1)?.time ?? 0);
  site.latestActivity = Math.max(site.latestActivity ?? 0, latest) || null;
}
writeJson(path.join(outDir, 'site.json'), site, 3);
// When this build ran (the site's "Last updated" line) and who was in a game at the last check, from
// data/live.json (not shown on the site at the moment; see poll.js). Its own small file, kept out of git
// (.gitignore) like live.json, so a check that finds nothing new doesn't make a commit.
let live = null;
try {
  const raw = JSON.parse(fs.readFileSync(path.join(store.dir, 'live.json'), 'utf8'));
  live = { checkedAt: raw.checkedAt, players: {} };
  for (const [puuid, g] of Object.entries(raw.players ?? {})) if (slugOf.has(puuid)) live.players[slugOf.get(puuid)] = g;
} catch {} // no check has run here yet
writeJson(path.join(outDir, 'status.json'), { updatedAt: now, live }, 3);

// ---- lobbies/<matchId>.json: fetched only when someone opens the popup, so the week files stay small.
// Rebuilt from data/ on every run and kept out of git (.gitignore).
const lobbyDir = path.join(outDir, 'lobbies');
const lobbyFiles = new Set();
/** Writes the game's lobby file and returns its number of boards, or null if the other boards aren't saved yet. */
function writeLobby(m) {
  if (!m.others) return null;
  const team = Object.entries(m.players)
    .filter(([puuid]) => slugOf.has(puuid))
    .map(([puuid, pp]) => ({ player: slugOf.get(puuid), placement: pp.placement, level: pp.level, tactician: pp.tactician ?? null, rank: pp.rank, traits: pp.traits, units: pp.units }));
  const boards = [...team, ...m.others].sort((a, b) => a.placement - b.placement);
  const file = `${m.id}.json`;
  writeJson(path.join(lobbyDir, file), { id: m.id, boards }, 0);
  lobbyFiles.add(file);
  return boards.length;
}

// ---- weeks/<key>.json
const byWeek = new Map(weeks.map((w) => [w.key, []]));
for (const m of matches) {
  const entries = Object.entries(m.players)
    .filter(([puuid]) => slugOf.has(puuid))
    .map(([puuid, pp]) => ({
      player: slugOf.get(puuid),
      placement: pp.placement,
      level: pp.level,
      round: pp.round,
      dmg: pp.dmg,
      lp: lpOf.get(`${m.id}|${puuid}`) ?? null,
      traits: pp.traits,
      units: pp.units,
      augments: pp.augments,
      tactician: pp.tactician ?? null,
    }))
    .sort((a, b) => a.placement - b.placement);
  if (!entries.length) continue;
  const time = matchTime(m);
  const week = weeks.find((w) => time >= w.start && time < w.end);
  if (!week) continue;
  byWeek.get(week.key).push({ id: m.id, time, queue: m.queue, set: m.set, patch: m.patch, length: m.length, lobby: writeLobby(m), entries });
}
const weekDir = path.join(outDir, 'weeks');
fs.mkdirSync(weekDir, { recursive: true });
const keep = new Set();
for (const [key, matches] of byWeek) {
  matches.sort((a, b) => b.time - a.time);
  writeJson(path.join(weekDir, `${key}.json`), { key, matches }, 2);
  keep.add(`${key}.json`);
}
for (const f of fs.readdirSync(weekDir)) if (!keep.has(f)) fs.rmSync(path.join(weekDir, f));
fs.mkdirSync(lobbyDir, { recursive: true });
for (const f of fs.readdirSync(lobbyDir)) if (!lobbyFiles.has(f)) fs.rmSync(path.join(lobbyDir, f));

const totalMatches = [...byWeek.values()].reduce((s, l) => s + l.length, 0);
console.log(`built ${outDir}: ${players.length} players, ${weeks.length} weeks, ${totalMatches} matches`);
