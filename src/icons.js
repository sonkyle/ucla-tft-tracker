// Trait, item, champion and tactician icons (plus in-game names) from Community Dragon (raw.communitydragon.org).
// Icons are saved into site/img/{traits,items,units,tacticians}/<id>.png so the site serves them itself;
// names go into data/icons.json and from there into site.json.
//
// Trait icons are small white glyphs (the site tints them by activation tier); item icons and
// champion portraits (the small square portrait, not the splash crop) are full color.
// Only ids without an icon or name are looked up, so Community Dragon's big data file (~24 MB) is
// downloaded about once per set. Ids it doesn't list are looked up in Riot's Data Dragon instead (see
// ddragonInfo), and anything neither has is retried: every 2 hours for its first 3 days (a new set's
// data can show up a few hours after launch), then daily.
//
//   node src/icons.js      fetch whatever is missing for every trait and item in data/

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const CDRAGON = 'https://raw.communitydragon.org/latest';
const DDRAGON = 'https://ddragon.leagueoflegends.com';
const RETRY_NEW_MS = 2 * 3600e3, RETRY_OLD_MS = 24 * 3600e3, NEW_FOR_MS = 3 * 24 * 3600e3;
const TACTICIAN_PX = 96;
// Largest icon kept, per kind. Bigger downloads are cut to their center square and scaled down to this
// (Data Dragon's champion art can be a 1024x512 splash, and from Set 19 its item art can be 512x512).
const MAX_PX = { traits: 64, items: 128, units: 128, tacticians: TACTICIAN_PX };

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

// ---- shrinking tactician art
// Community Dragon's tactician art is a 512x344 splash (about 260 KB), but the site only shows it as a small circle.
// A 96x96 center crop is about 20 KB. Done here because the project has no image library to lean on.

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }; // by PNG color type
const paeth = (a, b, c) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** { w, h, rgba } for a plain 8-bit PNG, or null for anything else (interlaced, 16-bit, not a PNG). */
export function readPng(buf) {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  let w, h, depth, color, interlace, palette, alphas;
  const idat = [];
  for (let pos = 8; pos + 8 <= buf.length;) {
    const len = buf.readUInt32BE(pos), type = buf.toString('latin1', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; color = data[9]; interlace = data[12]; }
    else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') alphas = data;
    else if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const ch = PNG_CHANNELS[color];
  if (depth !== 8 || interlace || !ch || (color === 3 && !palette)) return null;
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * ch;
  if (raw.length < (stride + 1) * h) return null;

  const px = Buffer.alloc(stride * h);
  for (let y = 0, from = 0, to = 0; y < h; y++) {
    const filter = raw[from++];
    if (filter > 4) return null;
    for (let x = 0; x < stride; x++, from++, to++) {
      const a = x >= ch ? px[to - ch] : 0, b = y ? px[to - stride] : 0, c = x >= ch && y ? px[to - stride - ch] : 0;
      px[to] = raw[from] + [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter];
    }
  }

  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const p = i * ch, o = i * 4;
    if (color === 3) { palette.copy(rgba, o, px[p] * 3, px[p] * 3 + 3); rgba[o + 3] = alphas?.[px[p]] ?? 255; }
    else if (color < 4 && color !== 2) { rgba.fill(px[p], o, o + 3); rgba[o + 3] = 255; }
    else if (color === 4) { rgba.fill(px[p], o, o + 3); rgba[o + 3] = px[p + 1]; }
    else { px.copy(rgba, o, p, p + 3); rgba[o + 3] = color === 6 ? px[p + 3] : 255; }
  }
  return { w, h, rgba };
}

/** The image's center square, averaged down to size x size. */
function squareThumb({ w, h, rgba }, size) {
  const side = Math.min(w, h), left = (w - side) >> 1, top = (h - side) >> 1, out = Buffer.alloc(size * size * 4);
  for (let dy = 0, o = 0; dy < size; dy++) {
    const y0 = top + Math.floor(dy * side / size), y1 = top + Math.ceil((dy + 1) * side / size);
    for (let dx = 0; dx < size; dx++, o += 4) {
      const x0 = left + Math.floor(dx * side / size), x1 = left + Math.ceil((dx + 1) * side / size);
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++, n++) {
          const i = (y * w + x) * 4, alpha = rgba[i + 3];
          r += rgba[i] * alpha; g += rgba[i + 1] * alpha; b += rgba[i + 2] * alpha; a += alpha;
        }
      }
      if (a) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); out[o + 3] = Math.round(a / n); }
    }
  }
  return out;
}

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]), len = Buffer.alloc(4), crc = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([len, body, crc]);
}

function writePng(size, rgba) {
  const opaque = rgba.every((v, i) => i % 4 !== 3 || v === 255), ch = opaque ? 3 : 4, stride = size * ch;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0, to = 0; y < size; y++) {
    raw[to++] = 4; // Paeth filter on every row
    for (let x = 0; x < stride; x++, to++) {
      const at = (col, row) => (col < 0 || row < 0 ? 0 : rgba[(row * size + Math.floor(col / ch)) * 4 + (col % ch)]);
      raw[to] = at(x, y) - paeth(at(x - ch, y), at(x, y - 1), x >= ch && y ? at(x - ch, y - 1) : 0);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = opaque ? 2 : 6;
  return Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', header), pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })), pngChunk('IEND', Buffer.alloc(0))]);
}

/** A size x size version of a larger PNG. Anything it can't read, or that's already small, comes back unchanged. */
export function shrinkPng(buf, size = TACTICIAN_PX) {
  try {
    const img = readPng(buf);
    return img && Math.max(img.w, img.h) > size ? writePng(size, squareThumb(img, size)) : buf;
  } catch {
    return buf;
  }
}

/**
 * Names, gold costs and icon URLs from Riot's Data Dragon: { id -> { name, cost, url } } for champions,
 * traits and items. Used for ids Community Dragon doesn't list, e.g. a new set on its first day.
 *
 * Written for both Data Dragon formats. Today's files are keyed by long paths
 * ("Maps/Shipping/Map22/Sets/TFTSet18/Shop/DA_CrimsonRaptor18") with the id inside each entry; from
 * Set 19.1 (Dec 1, 2026) they're keyed by the id itself ("DA_19_Ahri"). So entries are read by their
 * `id` field, never by key. Also from 19.1 (developer.riotgames.com/docs/tft):
 * - a champion's square icon is image.icon (image.full becomes the splash), both in img/tft-champion/;
 * - image.full can be "" for things with no image, so that means "no icon", not a URL;
 * - sprite sheets and the sprite/x/y/w/h fields are gone; images are img/<image.group>/<file>.
 */
export async function ddragonInfo() {
  const version = (await (await get(`${DDRAGON}/api/versions.json`)).json())[0];
  const info = new Map();
  for (const file of ['tft-champion', 'tft-trait', 'tft-item']) {
    let data;
    try {
      data = (await (await get(`${DDRAGON}/cdn/${version}/data/en_US/${file}.json`)).json()).data ?? {};
    } catch (err) {
      console.warn(`! Data Dragon ${file}.json: ${err.message}`);
      continue;
    }
    for (const v of Object.values(data)) {
      if (!v?.id || info.has(v.id)) continue;
      const img = v.image ?? {}, pic = img.icon || img.full;
      info.set(v.id, {
        name: v.name || null,
        cost: v.cost ?? v.tier,
        url: pic && img.group ? `${DDRAGON}/cdn/${version}/img/${img.group}/${pic}` : null,
      });
    }
  }
  return info;
}

/** All trait, item, unit and tactician ids used in the stored matches, opponents' boards included. */
export function idsInMatches(matches) {
  const traits = new Set(), items = new Set(), units = new Set(), tacticians = new Set();
  for (const m of matches) {
    for (const p of [...Object.values(m.players), ...(m.others ?? [])]) {
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
 * @param state   { names: {id: name}, costs: {unitId: gold cost}, missing: {id: lastCheckedMs},
 *                  missingSince: {id: firstMissingMs} } — updated in place
 * @returns number of icons downloaded
 */
export async function syncIcons(ids, imgDir, state, now = Date.now()) {
  state.names ??= {};
  state.costs ??= {};
  state.missing ??= {};
  state.missingSince ??= {};
  const retryAfter = (id) => (now - (state.missingSince[id] ?? now) < NEW_FOR_MS ? RETRY_NEW_MS : RETRY_OLD_MS);
  const markMissing = (id) => { state.missing[id] = now; state.missingSince[id] ??= now; };
  const found = (id) => { delete state.missing[id]; delete state.missingSince[id]; };
  const kinds = [['traits', ids.traits], ['items', ids.items], ['units', ids.units], ['tacticians', ids.tacticians]];
  const needs = (kind, id) => !fs.existsSync(iconFile(path.join(imgDir, kind), id)) || !state.names[id] ||
    (kind === 'units' && state.costs[id] == null);
  const todo = kinds.flatMap(([kind, set]) => [...(set ?? [])]
    .filter((id) => needs(kind, id) && !(now - (state.missing[id] ?? 0) < retryAfter(id)))
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

  // Anything Community Dragon doesn't list (tacticians come from elsewhere): try Riot's Data Dragon.
  if (todo.some(([kind, id]) => kind !== 'tacticians' && !info.has(id))) {
    try {
      for (const [id, entry] of await ddragonInfo()) if (!info.has(id)) info.set(id, entry);
    } catch (err) {
      console.warn(`! Data Dragon lookup failed: ${err.message}`);
    }
  }

  let saved = 0;
  for (const [kind, id] of todo) {
    const entry = info.get(id);
    if (entry?.name) state.names[id] = entry.name;
    if (kind === 'units' && Number.isFinite(entry?.cost)) state.costs[id] = entry.cost;
    const file = iconFile(path.join(imgDir, kind), id);
    if (fs.existsSync(file)) { found(id); continue; }
    const icon = ICON_OVERRIDES[id] ?? entry?.icon;
    // "ASSETS/Maps/TFT/Icons/Items/Hexcore/TFT_Item_X.TFT_Set13.tex" -> .../game/assets/maps/.../tft_item_x.tft_set13.png
    const url = entry?.url ?? (icon ? `${CDRAGON}/game/${icon.toLowerCase().replace(/\.(tex|dds)$/, '.png')}` : null);
    if (!url) { markMissing(id); continue; }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const bytes = Buffer.from(await (await get(url)).arrayBuffer());
      fs.writeFileSync(file, shrinkPng(bytes, MAX_PX[kind]));
      found(id);
      saved++;
    } catch {
      markMissing(id);
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
