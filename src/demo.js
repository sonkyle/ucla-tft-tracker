// Generate fake-but-realistic data so the site can be previewed without an
// API key. It simulates players playing games and the poller checking their
// rank every ~15 minutes, then runs the normal build.
//
//   node src/demo.js   ->  .demo/data (raw)  +  .demo/site-data (site JSON)

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, DataStore, slugify, writeJson } from './store.js';
import { ladderScore, TIERS, RANKED_QUEUE } from './stats.js';

const DEMO = path.join(ROOT, '.demo');
const DATA = path.join(DEMO, 'data');
fs.rmSync(DEMO, { recursive: true, force: true });

let seed = 20261105;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const between = (a, b) => a + rand() * (b - a);

const HOUR = 3600e3, DAY = 24 * HOUR;
const now = Date.now();
const matchStart = now - 6 * 7 * DAY;     // match history goes back 6 weeks
const trackStart = now - 24 * DAY;        // ...but rank tracking began ~3.5 weeks ago

const NAMES = ['Ari', 'Benji', 'Cass', 'Dev', 'Elle', 'Finn', 'Gabe', 'Hana', 'Ivy', 'Jules', 'Kai'];
const COMPS = [
  { traits: ['Arcanist', 'Scholar', 'Invoker'], units: ['Ahri', 'Lux', 'Syndra', 'Zoe', 'Karma', 'Seraphine', 'Taric', 'Galio', 'Orianna'] },
  { traits: ['Duelist', 'Brawler', 'Bastion'], units: ['Yasuo', 'Fiora', 'Irelia', 'Garen', 'Sett', 'Volibear', 'Shen', 'Braum', 'Jax'] },
  { traits: ['Sniper', 'Vanguard', 'Strategist'], units: ['Jinx', 'Caitlyn', 'Ashe', 'Leona', 'Nautilus', 'Ekko', 'Zeri', 'Poppy', 'Jhin'] },
  { traits: ['Assassin', 'Shadow', 'Rogue'], units: ['Akali', 'Katarina', 'Kayn', 'Zed', 'Talon', 'Pyke', 'Evelynn', 'Nocturne', 'Rengar'] },
  { traits: ['Bruiser', 'Sorcerer', 'Guardian'], units: ['Cho\'Gath', 'Sion', 'Vel\'Koz', 'Swain', 'Annie', 'Malphite', 'Neeko', 'Rumble', 'Lissandra'] },
];
const ITEMS = ['InfinityEdge', 'GuinsoosRageblade', 'JeweledGauntlet', 'WarmogsArmor', 'Bloodthirster', 'GiantSlayer',
  'SpearOfShojin', 'ArchangelsStaff', 'DragonsClaw', 'BrambleVest', 'TitansResolve', 'HandOfJustice'];
const RARITY = [0, 0, 1, 1, 2, 2, 4, 4, 6];

function fromScore(score) {
  score = Math.max(0, Math.round(score));
  if (score >= 2800) {
    const lp = score - 2800;
    return { tier: lp >= 700 ? 'CHALLENGER' : lp >= 300 ? 'GRANDMASTER' : 'MASTER', rank: 'I', lp };
  }
  return { tier: TIERS[Math.floor(score / 400)], rank: ['IV', 'III', 'II', 'I'][Math.floor((score % 400) / 100)], lp: score % 100 };
}

function board(level) {
  const comp = pick(COMPS);
  const units = comp.units.slice(0, Math.min(level, 9)).map((u, i) => ({
    id: `TFT16_${u.replace(/\W/g, '')}`,
    star: rand() < 0.15 ? 3 : rand() < 0.6 ? 2 : 1,
    rarity: RARITY[i],
    items: i < 3 ? Array.from({ length: Math.floor(between(0, 4)) }, () => `TFT_Item_${pick(ITEMS)}`) : [],
  }));
  const traits = comp.traits.map((t, i) => ({ name: `TFT16_${t}`, units: Math.max(2, 6 - i * 2), style: [3, 2, 1][i] ?? 1 }));
  return { units, traits };
}

const store = new DataStore(DATA);
const LP_FOR = [45, 35, 22, 10, -12, -22, -35, -45];
const players = NAMES.map((name, i) => {
  const puuid = `demo-puuid-${i}`;
  store.players[`${name}#ucla`.toLowerCase()] = { riotId: `${name}#UCLA`, puuid, backfilled: true };
  return {
    name, puuid, skill: between(-0.6, 0.9),
    score: Math.round(between(1500, 3000)), games: Math.floor(between(40, 120)),
    activity: between(0.25, 0.8), events: [],
  };
});

let matchNo = 1;
const shared = []; // normal-queue lobbies teammates joined together
for (const p of players) {
  for (let day = matchStart; day < now; day += DAY) {
    if (rand() > p.activity) continue;
    let t = day + between(17, 23) * HOUR;
    const sessionGames = Math.floor(between(2, 7));
    for (let g = 0; g < sessionGames && t < now - HOUR; g++) {
      const ranked = rand() < 0.85;
      const length = Math.round(between(1500, 2400));
      const w = Array.from({ length: 8 }, (_, k) => Math.exp(-(k - 3.5) * p.skill * 0.5));
      let r = rand() * w.reduce((a, b) => a + b), placement = 1;
      while ((r -= w[placement - 1]) > 0) placement++;
      const elim = placement === 1 ? length : Math.round(length * (0.45 + 0.5 * (8 - placement) / 7));
      const created = t;
      const datetime = created + 60e3 + length * 1000; // ~1 min loading screen
      const level = Math.min(10, 6 + Math.floor((8 - placement) / 2) + (rand() < 0.3 ? 1 : 0));
      const id = `NA1_${5_000_000_000 + matchNo++}`;
      const m = {
        id, created, datetime, length, queue: ranked ? RANKED_QUEUE : pick([1090, 1130]), set: 16, patch: '16.21',
        players: { [p.puuid]: { placement, level, round: Math.round(10 + elim / 70), elim, dmg: Math.round((9 - placement) * between(15, 30)), gold: Math.floor(between(0, 20)), ...board(level) } },
      };
      store.matches.set(id, m);
      if (!ranked && rand() < 0.4) shared.push(m);
      if (ranked) {
        const lpChange = LP_FOR[placement - 1] + Math.round(between(-6, 6));
        // LP updates a few seconds after the player is knocked out.
        p.events.push({ t: datetime - (length - elim) * 1000 + between(5e3, 40e3), lpChange });
      }
      t = datetime - (length - elim) * 1000 + between(2, 6) * 60e3;
    }
  }
}
// A few normal games where two teammates were in the same lobby.
for (const m of shared.slice(0, 12)) {
  const mate = pick(players.filter((x) => !m.players[x.puuid]));
  const taken = new Set(Object.values(m.players).map((x) => x.placement));
  const placement = [1, 2, 3, 4, 5, 6, 7, 8].find((x) => !taken.has(x) && rand() < 0.5) ?? [1, 2, 3, 4, 5, 6, 7, 8].find((x) => !taken.has(x));
  m.players[mate.puuid] = { placement, level: 8, round: 30, elim: Math.round(m.length * 0.8), dmg: 60, gold: 3, ...board(8) };
}

// Simulate the poller: every ~15 min (sometimes late, sometimes skipped).
for (const p of players) {
  p.events.sort((a, b) => a.t - b.t);
  // Rewind the starting state so the last event lands on today's rank.
  let score = p.score, games = p.games;
  for (const e of p.events) if (e.t >= matchStart) { score -= e.lpChange; games--; }
  const snaps = (store.snapshots[p.puuid] = []);
  let ei = 0;
  for (let t = trackStart; t < now; t += 15 * 60e3) {
    if (rand() < 0.05) continue; // a skipped run
    const pollAt = t + between(0, 6) * 60e3;
    while (ei < p.events.length && p.events[ei].t <= pollAt) {
      score = Math.max(0, score + p.events[ei].lpChange);
      games++;
      ei++;
    }
    const state = { t: Math.round(pollAt), ...fromScore(score), wins: Math.round(games * 0.13), losses: games - Math.round(games * 0.13) };
    const last = snaps.at(-1);
    if (!last || ladderScore(last) !== ladderScore(state) || last.wins + last.losses !== games) snaps.push(state);
  }
}

store.save();
writeJson(path.join(DEMO, 'config.json'), {
  teamName: 'UCLA TFT (demo data)', platform: 'na1', timezone: 'America/Los_Angeles', weekStartsOn: 1,
  players: players.map((p) => ({ riotId: `${p.name}#UCLA`, name: p.name })),
}, 3);
execFileSync(process.execPath, [
  path.join(ROOT, 'src', 'build.js'),
  '--config', path.join(DEMO, 'config.json'), '--data', DATA, '--out', path.join(DEMO, 'site-data'),
], { stdio: 'inherit' });
console.log(`demo players: ${players.map((p) => slugify(p.name)).join(', ')}`);
