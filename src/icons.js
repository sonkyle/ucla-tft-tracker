// Trait, item, champion and tactician icons (plus in-game names) from Community Dragon (raw.communitydragon.org).
// Icons are saved into site/img/{traits,items,units,tacticians}/<id>.png so the site serves them itself;
// names go into data/icons.json and from there into site.json.
//
// Trait icons are small white glyphs (the site tints them by activation tier); item icons and
// champion portraits (the small square portrait, not the splash crop) are full color.
// Only ids without an icon or name are looked up, so Community Dragon's big data file (~24 MB) is
// downloaded about once per set. Ids it doesn't list are retried after a day.
//
//   node src/icons.js      fetch whatever is missing for every trait and item in data/

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CDRAGON = 'https://raw.communitydragon.org/latest';
const RETRY_MISSING_MS = 24 * 3600e3;

// Community Dragon occasionally lists the wrong artwork; these win over its listing.
// Add a line (id -> icon path) and delete the id's file in site/img/... to re-download it.
export const ICON_OVERRIDES = {
  DA_18_Invoker: 'assets/ux/traiticons/trait_icon_16_invoker.tex', // listed icon is a cup; in-game it's the teardrop with two rings
};

export const iconFile = (dir, id) => path.join(dir, `${id.replace(/[^A-Za-z0-9_]/g, '_')}.png`);

async function get(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'tft-team-tracker/1.0' }, signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res;
}

/** All trait, item, unit and tactician ids used in the stored matches. */
export function idsInMatches(matches) {
  const traits = new Set(), items = new Set(), units = new Set(), tacticians = new Set();
  for (const m of matches) {
    for (const p of Object.values(m.players)) {
      for (const t of p.traits ?? []) traits.add(t.name);
      for (const u of p.units ?? []) { units.add(u.id); for (const i of u.items ?? []) items.add(i); }
      if (p.tactician) tacticians.add(p.tactician);
    }
  }
  return { traits, items, units, tacticians };
}

/**
 * @param ids     { traits, items, units, tacticians } — Sets of ids
 * @param imgDir  site/img (icons go in traits/, items/, units/ and tacticians/ under it)
 * @param state   { names: {id: name}, costs: {unitId: gold cost}, missing: {id: lastCheckedMs} } — updated in place
 * @returns number of icons downloaded
 */
export async function syncIcons(ids, imgDir, state, now = Date.now()) {
  state.names ??= {};
  state.costs ??= {};
  state.missing ??= {};
  const kinds = [['traits', ids.traits], ['items', ids.items], ['units', ids.units], ['tacticians', ids.tacticians]];
  const needs = (kind, id) => !fs.existsSync(iconFile(path.join(imgDir, kind), id)) || !state.names[id] ||
    (kind === 'units' && state.costs[id] == null);
  const todo = kinds.flatMap(([kind, set]) => [...(set ?? [])]
    .filter((id) => needs(kind, id) && !(now - (state.missing[id] ?? 0) < RETRY_MISSING_MS))
    .map((id) => [kind, id]));
  if (!todo.length) return 0;

  // id -> { name, icon (game asset path), url (full url), cost }; each source is fetched only if needed
  const info = new Map();
  if (todo.some(([kind]) => kind !== 'tacticians')) {
    const data = await (await get(`${CDRAGON}/cdragon/tft/en_us.json`)).json();
    for (const it of data.items ?? []) if (it.apiName) info.set(it.apiName, it);
    for (const set of [...(data.setData ?? []), ...Object.values(data.sets ?? {})]) {
      for (const t of set.traits ?? []) if (t.apiName && !info.has(t.apiName)) info.set(t.apiName, t);
      // champions: tileIcon is the small square portrait (squareIcon is a bigger splash-art crop)
      for (const c of set.champions ?? []) if (c.apiName && !info.has(c.apiName)) info.set(c.apiName, { name: c.name, cost: c.cost, icon: c.tileIcon ?? c.squareIcon ?? c.icon });
    }
  }
  if (todo.some(([kind]) => kind === 'tacticians')) {
    // Tacticians (Little Legends), keyed by the match data's companion content_ID. Their only icon is a
    // splash image ("/lol-game-data/assets/ASSETS/Loadouts/Companions/X.png"); the site crops it to a circle.
    const base = `${CDRAGON}/plugins/rcp-be-lol-game-data/global/default`;
    for (const c of await (await get(`${base}/v1/companions.json`)).json()) {
      if (!c.contentId || info.has(c.contentId)) continue;
      const rel = (c.loadoutsIcon ?? '').replace(/^\/lol-game-data\/assets\//i, '').toLowerCase();
      info.set(c.contentId, { name: c.name, url: rel ? `${base}/${rel}` : null });
    }
  }

  let saved = 0;
  for (const [kind, id] of todo) {
    const entry = info.get(id);
    if (entry?.name) state.names[id] = entry.name;
    if (kind === 'units' && Number.isFinite(entry?.cost)) state.costs[id] = entry.cost;
    const file = iconFile(path.join(imgDir, kind), id);
    if (fs.existsSync(file)) { delete state.missing[id]; continue; }
    const icon = ICON_OVERRIDES[id] ?? entry?.icon;
    // "ASSETS/Maps/TFT/Icons/Items/Hexcore/TFT_Item_X.TFT_Set13.tex" -> .../game/assets/maps/.../tft_item_x.tft_set13.png
    const url = entry?.url ?? (icon ? `${CDRAGON}/game/${icon.toLowerCase().replace(/\.(tex|dds)$/, '.png')}` : null);
    if (!url) { state.missing[id] = now; continue; }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(await (await get(url)).arrayBuffer()));
      delete state.missing[id];
      saved++;
    } catch {
      state.missing[id] = now;
    }
  }
  return saved;
}

/** Ids that have an icon file, for site.json. */
export function listIcons(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4)).sort() : [];
}

// ---- run directly
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { ROOT, DataStore } = await import('./store.js');
  const store = new DataStore(path.join(ROOT, 'data'));
  const n = await syncIcons(idsInMatches(store.matches.values()), path.join(ROOT, 'site', 'img'), store.icons);
  store.save();
  console.log(`icons: ${n} downloaded, ${Object.keys(store.icons.names).length} names, ${Object.keys(store.icons.missing).length} not on Community Dragon`);
}
