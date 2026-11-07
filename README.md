# TFT Team Tracker

A website showing each player's ranked TFT match history and **net LP week by week**.
It runs free on GitHub: a scheduled GitHub Action checks the Riot API every ~15 minutes and
publishes a static site on GitHub Pages.

- **Team page:** team totals for the week and a leaderboard.
- **Player pages** (one tab per player in the header): that player's net LP and games for the selected week, plus their
  current and peak rank, a rank-over-time chart, net LP per week, and a week-by-week table. Only that player's results are shown.
  The week you're looking at carries over when you switch between the team page and player pages.

Want to see it before setting anything up? Run `npm run demo` and open the URL it prints (11 fake players).
It uses port 8080, or the next free port if 8080 is taken. Pick one with `node src/serve.js --demo --port 3000`.

## How LP is tracked (read this)

Riot's match API gives placements, comps and levels, but **no LP**. The only LP source is a player's
*current* rank. So the tracker saves a snapshot every time a player's rank or game count changes,
and matches each change to the game that caused it:

- The game count goes up by 1 between two checks and exactly one ranked game ended in that window → that game gets the exact LP change.
- Two games finish between checks (e.g. a delayed run) → the combined change is shown once, on the newer game.
- Weekly net LP = sum of all rank changes that week. Decay and other non-game changes are included.

**Per-game LP from tactics.tools.** [tactics.tools](https://tactics.tools) records LP for each game and lists it,
by Riot match ID, on each player's public profile. Each poll reads that page for players who have recent ranked
games with no exact LP (at most once per player every 20 minutes) and saves the numbers to `data/external-lp.json`.
The build uses them for:
- games inside a combined change (any game it doesn't cover gets what's left of the total, which is exact when only one is left);
- weeks the rank checks don't fully cover (before tracking started), when every ranked game that week has a number.
  These weeks don't include decay.

tactics.tools only lists about a player's last 50 games, so LP for older games still shows "—".
Set `"tacticsTools": false` in `config.json` to turn this off.

**Filling a gap by hand.** If no source knows a player's rank at the end of some week, add it to that player in
`config.json`, keyed by the week's start date: `"endRanks": { "2026-10-21": "D3 26" }`. Short (`D3 26`, `GM 512`)
and long (`Diamond III 26 LP`) forms both work, and a hand-entered rank wins over computed ones.

**Trait, item and champion icons.** Each poll downloads icons (and in-game names) for any trait, item or champion
that doesn't have one yet from [Community Dragon](https://communitydragon.org) into `site/img/traits/`, `items/` and `units/`
(about once per set), so the site serves them itself. Run `node src/icons.js` to fetch them by hand.
Weeks run Monday 12am to Sunday 11:59pm Pacific time. You can change this in `config.json`.

## Setup

Requires Node 22+. There are no npm dependencies.

### 1. Riot API key
- **Testing:** the development key from https://developer.riotgames.com works but **expires every 24 hours**.
- **For the live site:** register a product on the developer portal and request a **Personal API Key**.
  It doesn't expire and has the same rate limits as a dev key, which is plenty for 11 players.
  Approval can take a few days.

### 2. Add the players
Edit `config.json`:

```json
{
  "teamName": "UCLA TFT",
  "platform": "na1",
  "timezone": "America/Los_Angeles",
  "weekStartsOn": 1,
  "trackFrom": "2026-09-01",
  "weekOne": "2026-09-23",
  "players": [
    { "riotId": "SomeName#NA1", "name": "Display Name" }
  ]
}
```

`riotId` is the in-game `Name#TAG`. `trackFrom` sets how far back match history is backfilled
(use the current set's launch date). `weekOne` is the first day of "Week 1"; the site labels weeks by number from there (Week 1, Week 2, …), with the dates shown smaller. Leave it out to label weeks by date only. Change it when a new set starts. `weekStartsOn`: 0 = Sunday, 1 = Monday.

### 3. Run locally
```sh
cp .env.example .env          # then paste your key into .env
npm run update                # poll Riot + build the site data
npm run serve                 # prints the local URL (8080, or the next free port)
```
The first run backfills match history, which can take a while: about 100 matches per 2 minutes at
personal-key rate limits. Each run fetches at most 400 matches, so a large backfill finishes over
several runs. Use `node src/poll.js --max-matches 5000` to do it all at once.

### 4. Put it online (GitHub Pages)
1. Create a GitHub repo for this folder and push it.
2. Repo **Settings → Secrets and variables → Actions → New repository secret**: name `RIOT_API_KEY`, value = your key.
3. Repo **Settings → Pages → Source: GitHub Actions**.
4. **Actions → "Update data & deploy site" → Run workflow** once. After that it's meant to run every 15 minutes on its own.

The site will be at `https://<user-or-org>.github.io/<repo>/`. The workflow commits only when the data changed, but
redeploys after every check so the site's "Last updated X minutes ago" stays current.

**If the scheduled runs never start.** GitHub's built-in schedule is best-effort, and for some repos it never fires. The fix
is a free outside timer that starts the workflow through GitHub's API every 15 minutes. This repo uses
[cron-job.org](https://cron-job.org):
- Make a fine-grained token (GitHub **Settings → Developer settings → Fine-grained tokens**) for this repo only, with
  **Actions: Read and write**.
- Create a cron job: `POST https://api.github.com/repos/<owner>/<repo>/actions/workflows/update.yml/dispatches` every
  15 minutes, with headers `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`,
  `Content-Type: application/json` and body `{"ref":"main"}`. A test run should return 204.
- When the token expires (GitHub emails you first), regenerate it and paste the new one into the cron job.

Notes:
- If the key expires or is wrong, the workflow fails and GitHub emails you. Update the secret and it recovers.
  LP for games played while it was down will show as combined totals or "LP n/a".
- GitHub turns off scheduled workflows after 60 days with no repo activity, e.g. a long break between sets.
  Re-enable it from the Actions tab.

## Project layout
```
config.json          players + settings
src/poll.js          one polling pass: rank snapshots + new matches -> data/
src/build.js         data/ -> site/data/ (LP attribution, weekly roll-ups)
src/stats.js         ladder math, week math, LP attribution (unit-tested)
src/riot.js          Riot API client (rate limits, retries)
src/tactics.js       per-game LP from tactics.tools profiles
src/icons.js         trait/item/champion icons + names from Community Dragon -> site/img/
data/                stored snapshots and trimmed match data (committed)
site/                the static website (index.html, app.js, style.css, data/)
test/                npm test
```

Removing a player from `config.json` hides them from the site but keeps their data. Adding a player backfills their history on the next run.

---
This site isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot Games or anyone officially involved in
producing or managing Riot Games properties. Riot Games and all associated properties are trademarks or registered
trademarks of Riot Games, Inc.
