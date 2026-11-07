// Cloudflare Worker behind the site's "Check for new games" button.
//
// Starting an update means starting the GitHub workflow, which needs a GitHub token. The site is public, so the
// token can't live in the page; it lives here, as a Cloudflare secret. The worker does exactly one thing: start the
// "Update data & deploy site" workflow, and only when no update is running and none started in the last
// COOLDOWN_SECONDS. So anyone who finds the URL can at most cause an update every couple of minutes.
//
// Setup (README → "Check for new games button"):
//   1. Cloudflare dashboard → Workers & Pages → Create → Worker → Deploy, then Edit code: paste this file, Deploy.
//   2. Worker → Settings → Variables and Secrets → Add → type Secret, name GITHUB_TOKEN, value: a fine-grained
//      token for this repo only with "Actions: Read and write".
//   3. Put the worker's URL in config.json as "updateUrl" and push.
//
// Replies (JSON): { status: "started" } | { status: "running" } | { status: "recent", retryIn: <seconds> } | { error }

const REPO = 'sonkyle/ucla-tft-tracker'; // owner/repo
const WORKFLOW = 'update.yml'; // file name in .github/workflows
const SITE_ORIGINS = ['https://sonkyle.github.io']; // pages allowed to call this from a browser
const COOLDOWN_SECONDS = 120;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('origin') ?? '';
    // localhost too, for trying the button with `npm run serve`
    const allowed = SITE_ORIGINS.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    const cors = {
      'access-control-allow-origin': allowed ? origin : SITE_ORIGINS[0],
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-max-age': '86400',
      vary: 'origin',
    };
    const reply = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' } });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return reply({ error: 'Use POST' }, 405);
    if (!allowed) return reply({ error: 'Not allowed from this site' }, 403);
    if (!env.GITHUB_TOKEN) return reply({ error: 'GITHUB_TOKEN secret is not set on the worker' }, 500);

    const github = (path, init = {}) =>
      fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${env.GITHUB_TOKEN}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'tft-tracker-update-button',
          ...init.headers,
        },
      });

    // Already updating, or an update started moments ago? Then don't start another.
    const list = await github('/runs?per_page=10');
    if (!list.ok) return reply({ error: `GitHub said ${list.status} listing runs` }, 502);
    const runs = (await list.json()).workflow_runs ?? [];
    if (runs.some((r) => r.status !== 'completed' && r.event !== 'push')) return reply({ status: 'running' });
    const lastCheck = runs.find((r) => r.event !== 'push'); // push runs only redeploy code; they don't check Riot
    const age = lastCheck ? (Date.now() - Date.parse(lastCheck.created_at)) / 1000 : Infinity;
    if (age < COOLDOWN_SECONDS) return reply({ status: 'recent', retryIn: Math.ceil(COOLDOWN_SECONDS - age) });

    const start = await github('/dispatches', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ref: 'main' }),
    });
    if (start.status !== 204) return reply({ error: `GitHub said ${start.status} starting the update` }, 502);
    return reply({ status: 'started' }, 202);
  },
};
