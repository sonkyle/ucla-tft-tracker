// Per-game LP from tactics.tools.
//
// Riot's API has no LP per game (see README). tactics.tools records it for players it tracks
// and embeds it in each player's public profile page, keyed by Riot match ID, so it lines up
// exactly with the matches this tracker stores. We read that page once per player, at most
// every few minutes, and only when that player has recent ranked games with no exact LP.

const PLATFORM_TO_REGION = {
  na1: 'na', euw1: 'euw', eun1: 'eune', kr: 'kr', oc1: 'oce', br1: 'br', la1: 'lan', la2: 'las',
  jp1: 'jp', tr1: 'tr', ru: 'ru', ph2: 'ph', sg2: 'sg', th2: 'th', tw2: 'tw', vn2: 'vn',
};

export function profileUrl(gameName, tagLine, platform) {
  const region = PLATFORM_TO_REGION[platform] ?? platform.replace(/\d+$/, '');
  return `https://tactics.tools/player/${region}/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`;
}

// ["MASTER I", 38] -> ["MASTER", "I", 38]
function parseRank(r) {
  if (!Array.isArray(r) || typeof r[0] !== 'string' || !Number.isFinite(r[1])) return null;
  const [tier, div = 'I'] = r[0].trim().split(/\s+/);
  return [tier.toUpperCase(), div, r[1]];
}

/**
 * Pull per-game LP out of a tactics.tools profile page:
 *   { games: { matchId: lpDelta }, ranks: { matchId: { before: [tier, div, lp], after: [...] } } }
 * The page is a Next.js app; its data is the JSON in <script id="__NEXT_DATA__">.
 * Returns null when the page doesn't look like a profile (layout changed, player unknown).
 */
export function parseProfile(html) {
  const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) return null;
  let data;
  try { data = JSON.parse(m[1]); } catch { return null; }
  const matches = data?.props?.pageProps?.initialData?.matches;
  if (!Array.isArray(matches)) return null;
  const games = {}, ranks = {};
  for (const x of matches) {
    if (typeof x?.id !== 'string' || !Number.isFinite(x.lpDiff)) continue;
    games[x.id] = x.lpDiff;
    const before = parseRank(x.rankBefore), after = parseRank(x.rankAfter);
    if (before && after) ranks[x.id] = { before, after };
  }
  return { games, ranks };
}

export async function fetchProfileLp(gameName, tagLine, platform) {
  const res = await fetch(profileUrl(gameName, tagLine, platform), {
    headers: { 'user-agent': 'tft-team-tracker/1.0 (weekly LP tracker for a college team)' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const parsed = parseProfile(await res.text());
  if (!parsed) throw new Error('page had no match data (layout may have changed)');
  return parsed;
}
