// Pure functions: ladder math, week math, LP attribution, weekly roll-ups.
// No I/O here so everything is unit-testable.

export const RANKED_QUEUE = 1100;

export const TIERS = [
  'IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND',
  'MASTER', 'GRANDMASTER', 'CHALLENGER',
];
const DIVISIONS = { IV: 0, III: 1, II: 2, I: 3 };
export const APEX_BASE = 7 * 400; // Master 0 LP on the absolute ladder

/**
 * Convert tier/division/LP into one number so LP changes can be subtracted
 * across promotions/demotions. Iron IV 0 LP = 0, each division = 100,
 * Master/GM/Challenger share one LP scale starting at 2800.
 */
export function ladderScore(s) {
  if (!s || !s.tier) return null;
  const ti = TIERS.indexOf(s.tier);
  if (ti < 0) return null;
  if (ti >= 7) return APEX_BASE + s.lp;
  return ti * 400 + (DIVISIONS[s.rank] ?? 0) * 100 + s.lp;
}

// League entries count wins (top-4 finishes) and losses (5th-8th), so their sum is games played.
export function gamesPlayed(s) {
  return s && s.tier ? s.wins + s.losses : null;
}

// ---------------------------------------------------------------- match times

/** Is game_datetime the end of the game? (True when it sits ~game_length after gameCreation.) */
function datetimeIsEnd(m) {
  return !m.created || Math.abs(m.datetime - m.created - m.length * 1000) < 5 * 60e3;
}

/** Best estimate of when the game ended (ms). */
export function matchTime(m) {
  return datetimeIsEnd(m) ? m.datetime : m.created + m.length * 1000;
}

/** Best estimate of when this participant was knocked out — that's when their LP changes. */
export function elimTime(m, p) {
  const elimMs = (p.elim ?? m.length) * 1000;
  return datetimeIsEnd(m)
    ? m.datetime - (m.length * 1000 - elimMs)
    : m.created + elimMs;
}

// ---------------------------------------------------------------- LP attribution

/**
 * Snapshots are only stored when a player's ranked state changes, and each one
 * records the first poll that saw it. So consecutive snapshots (a, b) bound a
 * window (a.t, b.t] in which every ranked game that moved a→b ended.
 *
 * Each ranked match is dropped into the window containing its elimination time.
 * When a window holds exactly as many matches as the game counter rose by, the
 * LP change is attributed to them (exactly when it's one game, as a combined
 * total when the poller missed a game in between).
 *
 * @param snaps  [{t, tier, rank, lp, wins, losses}] sorted by t (tier null = unranked)
 * @param games  [{id, e}] the player's ranked games, e = elimination time
 * @returns { transitions, lpByMatch: Map<matchId, {delta, games, at?}> }  (at = rank-check time, only when games > 1)
 */
export function attributeLp(snaps, games, toleranceMs = 5 * 60e3) {
  const transitions = [];
  for (let i = 1; i < snaps.length; i++) {
    const a = snaps[i - 1], b = snaps[i];
    const ga = gamesPlayed(a), gb = gamesPlayed(b);
    const sa = ladderScore(a), sb = ladderScore(b);
    const sameSeason = ga != null && gb != null && gb >= ga;
    transitions.push({
      from: a.t,
      to: b.t,
      dGames: sameSeason ? gb - ga : 0,
      dScore: sameSeason && sa != null && sb != null ? sb - sa : null,
      matches: [],
    });
  }
  if (!transitions.length) return { transitions, lpByMatch: new Map() };

  const sorted = [...games].sort((x, y) => x.e - y.e);
  let w = 0;
  for (const g of sorted) {
    if (g.e <= transitions[0].from || g.e > transitions.at(-1).to) continue;
    while (transitions[w].to < g.e) w++;
    transitions[w].matches.push(g);
  }

  // Elimination times are estimates; if a poll landed right around a knockout,
  // a game can fall one window late/early. Fix up neighbouring windows whose
  // counts are off by exactly one in opposite directions.
  for (let i = 0; i + 1 < transitions.length; i++) {
    const A = transitions[i], B = transitions[i + 1];
    if (A.matches.length < A.dGames && B.matches.length > B.dGames &&
        B.matches[0].e - A.to <= toleranceMs) {
      A.matches.push(B.matches.shift());
    } else if (A.matches.length > A.dGames && B.matches.length < B.dGames &&
               A.to - A.matches.at(-1).e <= toleranceMs) {
      B.matches.unshift(A.matches.pop());
    }
  }

  const lpByMatch = new Map();
  for (const tr of transitions) {
    tr.attributed = tr.dGames > 0 && tr.dScore != null && tr.matches.length === tr.dGames;
    if (tr.attributed) {
      // A combined change carries the time of the rank check (`at`) so the site can group those games and show the total once.
      const lp = tr.dGames > 1 ? { delta: tr.dScore, games: tr.dGames, at: tr.to } : { delta: tr.dScore, games: tr.dGames };
      for (const g of tr.matches) lpByMatch.set(g.id, lp);
    }
  }
  return { transitions, lpByMatch };
}

/**
 * Combine our own LP attribution with per-game LP from tactics.tools.
 * - Our exact single-game numbers win.
 * - Otherwise a tactics.tools number is used ({..., src: 'tactics.tools'}).
 * - Games of a combined group that tactics.tools doesn't cover share what's left of the
 *   group's total; if only one is left, that remainder is its exact LP.
 *
 * @param ranked     [{id}] the player's ranked games
 * @param lpByMatch  from attributeLp
 * @param ext        { matchId: lpDelta } from tactics.tools
 * @returns Map<matchId, {delta, games, at?, src?}>
 */
export function mergeLp(ranked, lpByMatch, ext) {
  const out = new Map();
  const groups = new Map(); // rank-check time -> games in that combined group
  for (const g of ranked) {
    const own = lpByMatch.get(g.id);
    if (own?.games === 1) out.set(g.id, own);
    else if (Number.isFinite(ext[g.id])) out.set(g.id, { delta: ext[g.id], games: 1, src: 'tactics.tools' });
    if (own && own.games > 1) {
      if (!groups.has(own.at)) groups.set(own.at, { total: own.delta, at: own.at, games: [] });
      groups.get(own.at).games.push(g);
    }
  }
  for (const grp of groups.values()) {
    const open = grp.games.filter((g) => !out.has(g.id));
    if (!open.length) continue;
    const known = grp.games.filter((g) => out.has(g.id)).reduce((s, g) => s + out.get(g.id).delta, 0);
    const rest = grp.total - known;
    const lp = open.length === 1 ? { delta: rest, games: 1 } : { delta: rest, games: open.length, at: grp.at };
    for (const g of open) out.set(g.id, lp);
  }
  return out;
}

/**
 * Rank-over-time points [[t, ladderScore, tier]] for the chart. Where tactics.tools has each game's
 * rank before/after, that's one point per game (so the line matches the weekly LP bars);
 * our own rank checks fill in before and after that stretch. Repeated values are dropped.
 *
 * @param snaps  player's snapshots sorted by t
 * @param games  [{id, time, e}] the player's ranked games (e = elimination time)
 * @param ranks  { matchId: { before: [tier, div, lp], after: [tier, div, lp] } }
 */
export function rankHistory(snaps, games, ranks = {}) {
  // Each point is [t, score, tier]; the tier is kept because Master/Grandmaster/Challenger
  // share one LP scale, so the score alone can't say which of them a point is.
  const point = (t, tier, rank, lp) => [t, ladderScore({ tier, rank, lp }), tier];
  let pts = snaps.filter((s) => s.tier).map((s) => point(s.t, s.tier, s.rank, s.lp));
  const covered = games.filter((g) => ranks[g.id]).sort((a, b) => a.e - b.e);
  if (covered.length) {
    const start = covered[0].time, end = covered.at(-1).e;
    pts = [
      ...pts.filter(([t]) => t < start),
      point(start, ...ranks[covered[0].id].before),
      ...covered.map((g) => point(g.e, ...ranks[g.id].after)),
      ...pts.filter(([t]) => t > end),
    ];
  }
  pts = pts.filter(([, v]) => v != null);
  return pts.filter(([, v, tier], i) => i === 0 || v !== pts[i - 1][1] || tier !== pts[i - 1][2]);
}

/**
 * Estimated LP cutoff between two apex tiers, from the LP of everyone in each.
 * Riot re-sorts Master/Grandmaster/Challenger about once a day, so the lists overlap;
 * this picks the LP that misplaces the fewest players.
 */
export function apexCutoff(lowerLps, upperLps) {
  if (!lowerLps.length || !upperLps.length) return null;
  const lower = [...lowerLps].sort((a, b) => a - b), upper = [...upperLps].sort((a, b) => a - b);
  const countBelow = (arr, c) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < c) lo = m + 1; else hi = m; } return lo; };
  let bestErr = Infinity, tieLo = null, tieHi = null;
  for (const c of new Set([...upper, ...lower.map((x) => x + 1)])) {
    const err = (lower.length - countBelow(lower, c)) + countBelow(upper, c);
    if (err < bestErr) { bestErr = err; tieLo = tieHi = c; }
    else if (err === bestErr) { tieLo = Math.min(tieLo, c); tieHi = Math.max(tieHi, c); }
  }
  return Math.round((tieLo + tieHi) / 2); // middle of the equally good range
}

/**
 * Every known rank for a player, oldest first: our rank checks plus tactics.tools' rank after each
 * ranked game (at the game's end time). Used for "rank at end of week".
 *
 * @param snaps  player's snapshots
 * @param games  [{id, e}] the player's ranked games (e = elimination time)
 * @param ranks  { matchId: { after: [tier, div, lp] } } from tactics.tools
 */
export function rankPoints(snaps, games, ranks = {}) {
  const pts = snaps.filter((s) => s.tier).map((s) => ({ t: s.t, tier: s.tier, rank: s.rank, lp: s.lp }));
  for (const g of games) {
    const a = ranks[g.id]?.after;
    if (a) pts.push({ t: g.e, tier: a[0], rank: a[1], lp: a[2] });
  }
  return pts.sort((x, y) => x.t - y.t);
}

const TIER_ABBR = { I: 'IRON', B: 'BRONZE', S: 'SILVER', G: 'GOLD', P: 'PLATINUM', E: 'EMERALD', D: 'DIAMOND', M: 'MASTER', GM: 'GRANDMASTER', C: 'CHALLENGER' };
const DIV_NAMES = { 1: 'I', 2: 'II', 3: 'III', 4: 'IV', I: 'I', II: 'II', III: 'III', IV: 'IV' };

/**
 * Parse a hand-written rank like "D3 26", "Diamond III 26 LP", "GM 512" or "Master 0".
 * @returns {tier, rank, lp} or null if it doesn't look like a rank
 */
export function parseRank(text) {
  const m = /^\s*([a-z]+?)\s*(iv|iii|ii|i|[1-4])?\s+(\d+)\s*(lp)?\s*$/i.exec(String(text ?? ''));
  if (!m) return null;
  const word = m[1].toUpperCase();
  const tier = TIER_ABBR[word] ?? (TIERS.includes(word) ? word : null);
  if (!tier) return null;
  const apex = TIERS.indexOf(tier) >= 7;
  const rank = apex ? 'I' : DIV_NAMES[(m[2] ?? '').toUpperCase()];
  if (!rank) return null;
  return { tier, rank, lp: Number(m[3]) };
}

// ---------------------------------------------------------------- week math

const fmtCache = new Map();
function zonedParts(t, tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    fmtCache.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(t).map((x) => [x.type, x.value]));
  return {
    y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second,
    wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday),
  };
}

function tzOffset(t, tz) {
  const p = zonedParts(t, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(t / 1000) * 1000;
}

/** UTC ms of local midnight on y-m-d in tz (DST-safe). */
export function zonedMidnight(y, m, d, tz) {
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - tzOffset(guess, tz);
  return guess - tzOffset(first, tz);
}

/** Week containing instant t. key = local date of the week's first day, e.g. "2026-11-02". */
export function weekOf(t, tz, weekStartsOn = 1) {
  const p = zonedParts(t, tz);
  const back = (p.wd - weekStartsOn + 7) % 7;
  const day = new Date(Date.UTC(p.y, p.m - 1, p.d - back));
  return weekFromKey(day.toISOString().slice(0, 10), tz);
}

export function weekFromKey(key, tz) {
  const [y, m, d] = key.split('-').map(Number);
  return { key, start: zonedMidnight(y, m, d, tz), end: zonedMidnight(y, m, d + 7, tz) };
}

/** Every week from the one containing `from` to the one containing `to`, newest first. */
export function weekRange(from, to, tz, weekStartsOn = 1) {
  const weeks = [];
  let w = weekOf(to, tz, weekStartsOn);
  const first = weekOf(from, tz, weekStartsOn).key;
  while (true) {
    weeks.push(w);
    if (w.key <= first) break;
    w = weekOf(w.start - 1, tz, weekStartsOn);
  }
  return weeks;
}

// ---------------------------------------------------------------- weekly roll-up

function placementStats(list) {
  if (!list.length) return { games: 0, avg: null, top4: null, firsts: 0 };
  const sum = list.reduce((s, p) => s + p, 0);
  return {
    games: list.length,
    avg: Math.round((sum / list.length) * 100) / 100,
    top4: Math.round((list.filter((p) => p <= 4).length / list.length) * 1000) / 10,
    firsts: list.filter((p) => p === 1).length,
  };
}

function rankAt(snaps, t) {
  let found = null;
  for (const s of snaps) {
    if (s.t > t) break;
    found = s;
  }
  return found && found.tier ? { tier: found.tier, rank: found.rank, lp: found.lp } : null;
}

/**
 * @param snaps        player's snapshots sorted by t
 * @param transitions  from attributeLp
 * @param games        [{time, queue, placement}] all of the player's games
 * @param weeks        [{key, start, end}]
 * @param now          ms; caps "end of week" for the in-progress week
 * @param gameLp       Map<matchId, {delta, games}> from mergeLp. Weeks the rank checks don't
 *                     fully cover use the sum of per-game LP when every ranked game has one.
 * @param rankPoints   [{t, tier, rank, lp}] sorted by t: every known rank (rank checks + rank after each
 *                     game from tactics.tools); end-of-week rank is the latest one before the week ends.
 */
export function weeklySummary({ snaps, transitions, games, weeks, now, gameLp = new Map(), rankPoints = snaps }) {
  const trackedSince = snaps.length ? snaps[0].t : null;
  const out = {};
  for (const w of weeks) {
    const inWeek = (t) => t >= w.start && t < w.end;
    const ranked = games.filter((g) => g.queue === RANKED_QUEUE && inWeek(g.time));
    const other = games.filter((g) => g.queue !== RANKED_QUEUE && inWeek(g.time));

    let lp = null;
    const tracked = trackedSince != null && trackedSince < w.end;
    if (tracked) {
      lp = 0;
      for (const tr of transitions) {
        if (tr.dScore == null) continue;
        // Bucket by when the game ended if we know which game it was, else by poll time.
        const when = tr.attributed ? tr.matches.at(-1).time : tr.to;
        if (inWeek(when)) lp += tr.dScore;
      }
    }
    // Rank checks include decay, so they're preferred; per-game LP fills weeks they miss.
    let partial = tracked && trackedSince > w.start;
    let fromGames = false;
    if ((!tracked || partial) && ranked.length && ranked.every((g) => gameLp.get(g.id)?.games === 1)) {
      lp = ranked.reduce((sum, g) => sum + gameLp.get(g.id).delta, 0);
      partial = false;
      fromGames = true;
    }
    out[w.key] = {
      lp,
      partial,
      fromGames,
      ranked: placementStats(ranked.map((g) => g.placement)),
      otherGames: other.length,
      endRank: rankAt(rankPoints, Math.min(w.end - 1, now)),
    };
  }
  return out;
}
