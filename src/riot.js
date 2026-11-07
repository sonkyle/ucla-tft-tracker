// Minimal Riot API client: rate limiting (app limits read from response
// headers), 429 Retry-After handling, retries on 5xx.

const REGION_FOR_PLATFORM = {
  na1: 'americas', br1: 'americas', la1: 'americas', la2: 'americas',
  euw1: 'europe', eun1: 'europe', tr1: 'europe', ru: 'europe', me1: 'europe',
  kr: 'asia', jp1: 'asia',
  oc1: 'sea', sg2: 'sea', tw2: 'sea', vn2: 'sea',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class RiotClient {
  constructor(apiKey, platform = 'na1') {
    if (!apiKey) throw new Error('Missing RIOT_API_KEY (put it in .env or the environment).');
    this.apiKey = apiKey;
    this.platform = platform.toLowerCase();
    this.region = REGION_FOR_PLATFORM[this.platform];
    if (!this.region) throw new Error(`Unknown platform "${platform}"`);
    // Personal/dev key defaults; replaced by X-App-Rate-Limit once we see it.
    this.windows = [{ limit: 20, ms: 1000 }, { limit: 100, ms: 120_000 }];
    this.sent = [];
    this.requests = 0;
  }

  async #throttle() {
    for (;;) {
      const now = Date.now();
      const longest = Math.max(...this.windows.map((w) => w.ms));
      this.sent = this.sent.filter((t) => now - t < longest);
      let wait = 0;
      for (const { limit, ms } of this.windows) {
        const inWindow = this.sent.filter((t) => now - t < ms);
        // Leave one request of headroom per window.
        if (inWindow.length >= limit - 1) wait = Math.max(wait, inWindow[0] + ms - now + 50);
      }
      if (wait <= 0) break;
      await sleep(wait);
    }
    this.sent.push(Date.now());
  }

  async get(host, path, query = {}) {
    const qs = new URLSearchParams(
      Object.entries(query).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]),
    ).toString();
    const url = `https://${host}.api.riotgames.com${path}${qs ? `?${qs}` : ''}`;
    for (let attempt = 0; ; attempt++) {
      await this.#throttle();
      this.requests++;
      let res;
      try {
        res = await fetch(url, { headers: { 'X-Riot-Token': this.apiKey } });
      } catch (err) {
        if (attempt >= 4) throw err;
        await sleep(2000 * (attempt + 1));
        continue;
      }
      const limits = res.headers.get('x-app-rate-limit');
      if (limits) {
        this.windows = limits.split(',').map((pair) => {
          const [limit, secs] = pair.split(':').map(Number);
          return { limit, ms: secs * 1000 };
        });
      }
      if (res.ok) return res.json();
      if (res.status === 404) return null;
      if (res.status === 401 || res.status === 403) {
        throw new Error(`Riot API rejected the key (${res.status}). Dev keys expire every 24h — regenerate it or use a personal key.`);
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 5) {
        const retryAfter = Number(res.headers.get('retry-after')) || 2 ** attempt;
        await sleep(retryAfter * 1000 + 250);
        continue;
      }
      throw new Error(`Riot API ${res.status} for ${path}: ${await res.text()}`);
    }
  }

  account(gameName, tagLine) {
    return this.get(this.region,
      `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`);
  }

  accountByPuuid(puuid) {
    return this.get(this.region, `/riot/account/v1/accounts/by-puuid/${puuid}`);
  }

  leagueEntries(puuid) {
    return this.get(this.platform, `/tft/league/v1/by-puuid/${puuid}`);
  }

  /** Whole apex league: tier = 'master' | 'grandmaster' | 'challenger'. */
  apexLeague(tier) {
    return this.get(this.platform, `/tft/league/v1/${tier}`, { queue: 'RANKED_TFT' });
  }

  matchIds(puuid, { start = 0, count = 20, startTime } = {}) {
    return this.get(this.region, `/tft/match/v1/matches/by-puuid/${puuid}/ids`, { start, count, startTime });
  }

  match(matchId) {
    return this.get(this.region, `/tft/match/v1/matches/${matchId}`);
  }
}
