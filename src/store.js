// Config + on-disk storage. Data files are written one record per line so
// git diffs (and the commit history of data/) stay readable.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zonedMidnight } from './stats.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

export function loadEnv() {
  const envFile = path.join(ROOT, '.env');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
}

// Windows editors sometimes save JSON with a byte-order mark, which JSON.parse rejects.
const parse = (text) => JSON.parse(text.replace(/^﻿/, ''));

export function loadConfig(file = path.join(ROOT, 'config.json')) {
  const cfg = parse(fs.readFileSync(file, 'utf8'));
  cfg.platform ??= 'na1';
  cfg.timezone ??= 'America/Los_Angeles';
  cfg.weekStartsOn ??= 1;
  // trackFrom means midnight in the team's timezone, not UTC.
  if (cfg.trackFrom) {
    const [y, m, d] = cfg.trackFrom.split('-').map(Number);
    cfg.trackFromMs = zonedMidnight(y, m, d, cfg.timezone);
    if (!Number.isFinite(cfg.trackFromMs)) throw new Error(`trackFrom "${cfg.trackFrom}" must look like 2026-10-21`);
  }
  cfg.players = cfg.players.map((p) => {
    const hash = p.riotId.lastIndexOf('#');
    if (hash < 1) throw new Error(`Riot ID "${p.riotId}" must look like Name#TAG`);
    const gameName = p.riotId.slice(0, hash).trim();
    const tagLine = p.riotId.slice(hash + 1).trim();
    return {
      ...p,
      gameName,
      tagLine,
      key: `${gameName}#${tagLine}`.toLowerCase(),
      name: p.name || gameName,
      slug: slugify(p.name || gameName),
    };
  });
  const slugs = new Set();
  for (const p of cfg.players) {
    while (slugs.has(p.slug)) p.slug += '-2';
    slugs.add(p.slug);
  }
  return cfg;
}

export function slugify(s) {
  return s.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'player';
}

// ---------------------------------------------------------------- JSON files

export function readJson(file, fallback) {
  try {
    return parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

/** Pretty-print the first `depth` levels, keep everything deeper on one line. */
export function stringifyLines(value, depth = 1, indent = '') {
  if (depth <= 0 || value === null || typeof value !== 'object') return JSON.stringify(value);
  const inner = indent + '  ';
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return `[\n${value.map((v) => inner + stringifyLines(v, depth - 1, inner)).join(',\n')}\n${indent}]`;
  }
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  if (!entries.length) return '{}';
  return `{\n${entries
    .map(([k, v]) => `${inner}${JSON.stringify(k)}: ${stringifyLines(v, depth - 1, inner)}`)
    .join(',\n')}\n${indent}}`;
}

export function writeJson(file, value, depth = 1) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = stringifyLines(value, depth) + '\n';
  // Skip identical writes so file mtimes / git stay quiet.
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return false;
  fs.writeFileSync(file, text);
  return true;
}

// ---------------------------------------------------------------- data store

export class DataStore {
  constructor(dir) {
    this.dir = dir;
    this.players = readJson(path.join(dir, 'players.json'), {});
    this.snapshots = readJson(path.join(dir, 'snapshots.json'), {});
    // Per-game LP from tactics.tools:
    // { [puuid]: { fetchedAt, games: { [matchId]: lpDelta }, ranks: { [matchId]: { before, after } } } }
    this.externalLp = readJson(path.join(dir, 'external-lp.json'), {});
    // Estimated LP needed for Grandmaster / Challenger: { t, grandmaster, challenger }
    this.cutoffs = readJson(path.join(dir, 'cutoffs.json'), {});
    // From Community Dragon: trait/item/unit names, unit gold costs, and ids it had no icon for
    this.icons = readJson(path.join(dir, 'icons.json'), { names: {}, costs: {}, missing: {} });
    this.matches = new Map();
    const mdir = path.join(dir, 'matches');
    if (fs.existsSync(mdir)) {
      for (const f of fs.readdirSync(mdir).filter((f) => f.endsWith('.json')).sort()) {
        for (const m of Object.values(readJson(path.join(mdir, f), {}))) this.matches.set(m.id, m);
      }
    }
  }

  save() {
    let changed = false;
    changed = writeJson(path.join(this.dir, 'players.json'), this.players, 2) || changed;
    changed = writeJson(path.join(this.dir, 'snapshots.json'), this.snapshots, 2) || changed;
    if (Object.keys(this.icons.names ?? {}).length || Object.keys(this.icons.missing ?? {}).length) {
      changed = writeJson(path.join(this.dir, 'icons.json'), this.icons, 2) || changed;
    }
    if (this.cutoffs.t) changed = writeJson(path.join(this.dir, 'cutoffs.json'), this.cutoffs, 1) || changed;
    if (Object.keys(this.externalLp).length) {
      changed = writeJson(path.join(this.dir, 'external-lp.json'), this.externalLp, 2) || changed;
    }
    const byMonth = new Map();
    for (const m of [...this.matches.values()].sort((a, b) => a.datetime - b.datetime)) {
      const month = new Date(m.datetime).toISOString().slice(0, 7);
      if (!byMonth.has(month)) byMonth.set(month, {});
      byMonth.get(month)[m.id] = m;
    }
    for (const [month, ms] of byMonth) {
      changed = writeJson(path.join(this.dir, 'matches', `${month}.json`), ms, 1) || changed;
    }
    return changed;
  }
}

// ---------------------------------------------------------------- normalization

function parsePatch(version = '') {
  const m = /(\d+)\.(\d+)\./.exec(version);
  return m ? `${m[1]}.${m[2]}` : null;
}

function normalizeParticipant(p) {
  return {
    placement: p.placement,
    level: p.level,
    round: p.last_round,
    elim: Math.round((p.time_eliminated ?? 0) * 10) / 10,
    dmg: p.total_damage_to_players,
    gold: p.gold_left,
    traits: (p.traits ?? [])
      .filter((t) => t.tier_current > 0)
      .sort((a, b) => (b.style ?? 0) - (a.style ?? 0) || b.num_units - a.num_units)
      .map((t) => ({ name: t.name, units: t.num_units, style: t.style ?? 0 })),
    units: (p.units ?? []).map((u) => ({
      id: u.character_id ?? u.name,
      star: u.tier,
      rarity: u.rarity,
      items: u.itemNames ?? [],
    })),
    augments: p.augments?.length ? p.augments : undefined,
    // tactician (Little Legend): Community Dragon's companions list is keyed by this content id
    tactician: p.companion?.content_ID ?? null,
  };
}

/** Someone else in the lobby: just their name and board, for the site's all-boards popup. */
function normalizeOpponent(p) {
  const { placement, level, traits, units, tactician } = normalizeParticipant(p);
  return { name: p.riotIdGameName ?? null, tag: p.riotIdTagline ?? null, placement, level, traits, units, tactician };
}

const opponentKey = (o) => `${o.name}#${o.tag}`;
// rank: { tier, rank, lp }, null when the player was unranked, left off when it was never looked up
const withRank = (board, rank) => (rank === undefined ? board : { ...board, rank });

/**
 * Keep only what the site needs: full detail for tracked players, name and board for everyone else.
 * `ranks` (puuid -> rank) is passed only right after a game ends; a re-download keeps whatever was saved.
 */
export function normalizeMatch(raw, trackedPuuids, existing, ranks) {
  const info = raw.info;
  const players = { ...(existing?.players ?? {}) };
  const others = [];
  const savedRank = new Map((existing?.others ?? []).map((o) => [opponentKey(o), o.rank]));
  for (const p of info.participants) {
    if (trackedPuuids.has(p.puuid)) {
      players[p.puuid] = withRank(normalizeParticipant(p), ranks?.get(p.puuid) ?? existing?.players?.[p.puuid]?.rank);
    } else {
      const board = normalizeOpponent(p);
      others.push(withRank(board, ranks?.has(p.puuid) ? ranks.get(p.puuid) : savedRank.get(opponentKey(board))));
    }
  }
  return {
    id: raw.metadata.match_id,
    created: info.gameCreation ?? null,
    datetime: info.game_datetime,
    length: Math.round(info.game_length * 10) / 10,
    queue: info.queue_id ?? info.queueId,
    set: info.tft_set_number,
    patch: parsePatch(info.game_version),
    players,
    others,
  };
}
