// TFT team tracker front end. Plain ES module, no dependencies.
// Reads data/site.json + data/weeks/<week>.json produced by src/build.js.

const app = document.getElementById('app');
const tip = document.getElementById('tooltip');
const RANKED = 1100;
const APEX = 2800;
const TIERS = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER'];
const DIVS = ['IV', 'III', 'II', 'I'];
const QUEUES = { 1090: 'Normal', 1100: 'Ranked', 1130: 'Hyper Roll', 1150: 'Double Up', 1160: 'Double Up', 1210: "Choncc's Treasure" };

let site;
const weekCache = new Map();
// "?v=<build time>" on data URLs, so each build's files are fetched fresh past GitHub Pages' CDN cache
// (which can keep serving the previous build's copy for a few minutes after a deploy).
let dataVersion = '';
const ui = { sort: { key: 'rank', dir: -1 }, rankedOnly: false };
let redraws = [];
let renderId = 0;

// ---------------------------------------------------------------- helpers

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  setProps(el, props);
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k instanceof Node ? k : String(k));
  return el;
}
function s(tag, props, ...kids) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  setProps(el, props);
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k instanceof Node ? k : String(k));
  return el;
}
function setProps(el, props) {
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.setAttribute('class', v);
    else el.setAttribute(k, v === true ? '' : v);
  }
}

const title = (t) => t[0] + t.slice(1).toLowerCase();
const isApex = (r) => TIERS.indexOf(r.tier) >= 7;
const scoreOf = (r) => (!r ? null : isApex(r) ? APEX + r.lp : TIERS.indexOf(r.tier) * 400 + DIVS.indexOf(r.rank) * 100 + r.lp);
const rankText = (r) => (!r ? 'Unranked' : isApex(r) ? `${title(r.tier)} ${r.lp} LP` : `${title(r.tier)} ${r.rank} · ${r.lp} LP`);
const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0');
const deltaClass = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');
const ordinal = (n) => n + (['th', 'st', 'nd', 'rd'][n] ?? 'th');
const pct = (x) => (x == null ? '—' : `${Math.round(x)}%`);
const avg = (x) => (x == null ? '—' : x.toFixed(2));
const queueName = (q) => site.queueNames?.[q] ?? QUEUES[q] ?? 'Other mode';
const player = (slug) => site.players.find((p) => p.slug === slug);
// Riot IDs look like TFT16_Ahri, TFT_Item_InfinityEdge, DA_18_Rakan, DA_KogMaw18_AD,
// DA_18_Maokai_UniqueTrait, DA_InfinityEdgeRadiant, DA_18_EmblemCoven, DA_Component_BFSword.
const SPECIAL_NAMES = {
  KhaZix: "Kha'Zix", RekSai: "Rek'Sai", LeBlanc: 'LeBlanc', KogMaw: "Kog'Maw", ChoGath: "Cho'Gath",
  VelKoz: "Vel'Koz", KaiSa: "Kai'Sa", BelVeth: "Bel'Veth", KSante: "K'Sante", DrMundo: 'Dr. Mundo',
};
function cleanName(id = '') {
  let s = id.replace(/^(TFT\d*|Set\d+|DA)_/i, '').replace(/^\d+_/, '')
    .replace(/^(TFT\d*_)?Item_/i, '').replace(/^(Augment|Artifact|Component)_/i, '')
    .replace(/_?UniqueTrait/i, '').replace(/_Base$/i, '')
    .replace(/(?<=[a-z])\d+(?=_|$)/gi, ''); // set number glued to a name: Krug18, Gromp18_AP
  let radiant = false;
  s = s.replace(/_?Radiant$/i, () => { radiant = true; return ''; });
  s = s.replace(/^Emblem(.+)$/, '$1_Emblem');
  s = s.split('_').map((part) => SPECIAL_NAMES[part] ??
    part.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')).join(' ');
  return (radiant ? 'Radiant ' : '') + s.trim();
}
// Champion gold cost (1-5): the real cost from Community Dragon (site.unitCosts), else Riot's
// rarity + 1 (true for current sets; older sets numbered rarity differently).
const unitCost = (u) => site.unitCosts?.[u.id] ?? Math.min(5, Math.max(1, (u.rarity ?? 0) + 1));

function scoreLabel(v, step) {
  if (v >= APEX) return v === APEX ? 'Master' : `${v - APEX} LP`; // apex tiers share one LP scale
  const t = title(TIERS[Math.floor(v / 400)]);
  return step >= 400 ? t : `${t} ${DIVS[Math.floor((v % 400) / 100)]}`;
}

let fmtDateTime;
function initFormats() {
  const tz = site.timezone;
  fmtDateTime = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function weekLabel(key) {
  const [y, m, d] = key.split('-').map(Number);
  const a = new Date(Date.UTC(y, m - 1, d)), b = new Date(Date.UTC(y, m - 1, d + 6));
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
  return `${f.format(a)} – ${a.getUTCMonth() === b.getUTCMonth() ? b.getUTCDate() : f.format(b)}`;
}
// Week numbers (from config weekOne) lead; dates are secondary. Weeks without a number fall back to dates.
const weekNum = (key) => site.weeks.find((w) => w.key === key)?.num ?? null;
const weekName = (key) => (weekNum(key) ? `Week ${weekNum(key)}` : `Week of ${weekLabel(key)}`);
const weekFull = (key) => (weekNum(key) ? `Week ${weekNum(key)} · ${weekLabel(key)}` : `Week of ${weekLabel(key)}`);
const weekShort = (key) => (weekNum(key) ? `Wk ${weekNum(key)}` : weekLabel(key).split(' – ')[0]);
/** "Week 7" in bold with the dates smaller and muted beside it. */
const weekTitle = (key, tag = 'strong') =>
  [h(tag, { class: 'week-num' }, weekName(key)), weekNum(key) ? h('span', { class: 'week-dates' }, weekLabel(key)) : null];
const duration = (sec) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;

async function loadWeek(key) {
  if (!weekCache.has(key)) {
    weekCache.set(key, fetch(`data/weeks/${key}.json${dataVersion}`, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : { key, matches: [] })));
  }
  return weekCache.get(key);
}

// ---------------------------------------------------------------- tooltip

function showTip(lines, x, y) {
  tip.replaceChildren(...lines.map(([cls, text, key]) =>
    h('div', { class: cls }, key ? h('span', { class: 'key', style: typeof key === 'string' ? `background: ${key}` : null }) : null, text)));
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  const left = Math.min(window.innerWidth - r.width - 8, Math.max(8, x + 14));
  const top = y - r.height - 12 < 8 ? y + 16 : y - r.height - 12;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}
const hideTip = () => { tip.hidden = true; };
function tipAtElement(el, lines) {
  const r = el.getBoundingClientRect();
  showTip(lines, r.left + r.width / 2, r.top);
}

// ---------------------------------------------------------------- shared pieces

function tile(label, value, note, cls) {
  return h('div', { class: 'tile' },
    h('div', { class: 'label' }, label),
    h('div', { class: `value ${cls ?? ''}` }, value),
    note ? h('div', { class: 'note' }, note) : null);
}

/**
 * LP for one game. When one rank check covered several games, the total is shown once,
 * on the newest of those games in the list; `seen` tracks which groups were already shown.
 */
function lpBlock(e, m, seen) {
  if (m.queue !== RANKED) return h('div', { class: 'entry-lp' });
  if (!e.lp) {
    return h('div', { class: 'entry-lp', title: 'No LP recorded: game was before tracking began, or the rank check could not be matched to it' },
      h('span', { class: 'lp muted' }, '—'), h('span', { class: 'note' }, 'LP n/a'));
  }
  if (e.lp.games <= 1) {
    return h('div', { class: 'entry-lp', title: e.lp.src ? `LP from ${e.lp.src}` : null }, h('span', { class: `lp ${deltaClass(e.lp.delta)}` }, `${signed(e.lp.delta)} LP`));
  }
  const why = `The rank check ran once for ${e.lp.games} games, so only their combined LP change is known`;
  const group = e.lp.at != null ? `${e.player}|${e.lp.at}` : null;
  if (group && seen.has(group)) {
    return h('div', { class: 'entry-lp', title: `${why}: ${signed(e.lp.delta)} LP, shown on the newest of those games.` },
      h('span', { class: 'note' }, 'counted above'));
  }
  if (group) seen.add(group);
  return h('div', { class: 'entry-lp', title: `${why}.` },
    h('span', { class: `lp ${deltaClass(e.lp.delta)}` }, `${signed(e.lp.delta)} LP`),
    h('span', { class: 'note' }, `total for ${e.lp.games} games`));
}

// Trait activation tiers as Riot reports them (style): 1 bronze, 2 silver, 3 unique (single-champion
// traits), 4 gold, 5 prismatic, 6 special traits like Eclipse (shown like unique). Anything else is neutral.
const TRAIT_TIERS = { 1: 'Bronze', 2: 'Silver', 3: 'Unique', 4: 'Gold', 5: 'Prismatic', 6: 'Unique' };
// Badge order: prismatic, gold, unique, silver, bronze, then anything else.
const traitOrder = (t) => ({ 5: 0, 4: 1, 3: 2, 6: 2, 2: 3, 1: 4 })[t.style] ?? 5;
/**
 * Eclipse (active with 3 Solar and 3+ Lunar at once) goes first, followed by the Solar and Lunar
 * traits it comes from; everything else follows in tier order, more units first.
 */
function sortTraits(traits) {
  const base = (t) => cleanName(t.name);
  const eclipse = traits.some((t) => base(t) === 'Eclipse');
  const lead = (t) => (base(t) === 'Eclipse' ? 0 : eclipse && base(t) === 'Solar' ? 1 : eclipse && base(t) === 'Lunar' ? 2 : 3);
  return [...traits].sort((a, b) => lead(a) - lead(b) || traitOrder(a) - traitOrder(b) || b.units - a.units);
}
let traitIconSet;
/** Hexagon badge in the activation tier's color with the trait's icon on it, plus the unit count. */
function traitBadge(t) {
  traitIconSet ??= new Set(site.traitIcons ?? []);
  const label = `${nameOf(t.name)}${t.units ? ` · ${t.units}` : ''}${TRAIT_TIERS[t.style] ? ` (${TRAIT_TIERS[t.style]})` : ''}`;
  if (!traitIconSet.has(t.name)) return h('span', { class: `trait-text s${t.style}`, title: label }, `${t.units || ''} ${cleanName(t.name)}`.trim());
  const url = `img/traits/${t.name}.png`;
  return h('span', { class: `trait s${t.style}`, title: label, 'aria-label': label, role: 'img' },
    h('span', { class: 'hex' }, h('span', { class: 'glyph', style: `-webkit-mask-image: url(${url}); mask-image: url(${url})` })),
    t.units ? h('span', { class: 'n', 'aria-hidden': 'true' }, t.units) : null);
}

/** In-game name for a trait/item id (from Community Dragon), else a cleaned-up id. */
const nameOf = (id) => site.names?.[id] ?? cleanName(id);
let unitIconSet;
/**
 * Champion tile: stars above (2★+ only), portrait with a cost-colored border, items below.
 * The star and item rows keep their height when empty so tiles in a row line up.
 */
function unitTile(u) {
  unitIconSet ??= new Set(site.unitIcons ?? []);
  const name = cleanName(u.id);
  const label = `${name} ${u.star}★${u.items.length ? ` — ${u.items.map(nameOf).join(', ')}` : ''}`;
  return h('div', { class: `unit-tile c${unitCost(u)}`, title: label, 'aria-label': label, role: 'img' },
    h('div', { class: `stars st${u.star}`, 'aria-hidden': 'true' }, u.star > 1 ? '★'.repeat(u.star) : null),
    unitIconSet.has(u.id)
      ? h('img', { class: 'portrait', src: `img/units/${u.id}.png`, alt: '', loading: 'lazy', width: 42, height: 42 })
      : h('div', { class: 'portrait missing' }, name),
    h('div', { class: 'unit-items' }, u.items.map(itemIcon)));
}
let itemIconSet;
/** Small item icon; a lettered square if the icon is missing. */
function itemIcon(id) {
  itemIconSet ??= new Set(site.itemIcons ?? []);
  const name = nameOf(id);
  if (!itemIconSet.has(id)) return h('span', { class: 'item missing', title: name, 'aria-label': name }, name[0]);
  return h('img', { class: 'item', src: `img/items/${id}.png`, alt: name, title: name, loading: 'lazy', width: 18, height: 18 });
}

let tacticianIconSet;
/** The player's tactician in a circle, with their level when the game ended in the bottom-right corner. */
function tacticianBadge(e) {
  tacticianIconSet ??= new Set(site.tacticianIcons ?? []);
  const file = e.tactician ? e.tactician.replace(/[^A-Za-z0-9_]/g, '_') : null; // matches the saved file name
  const name = e.tactician ? site.names?.[e.tactician] : null;
  const label = `${name ? `${name} · ` : ''}Level ${e.level}`;
  return h('div', { class: 'tactician', title: label, 'aria-label': label, role: 'img' },
    file && tacticianIconSet.has(file)
      ? h('img', { src: `img/tacticians/${file}.png`, alt: '', loading: 'lazy' })
      : h('div', { class: 'blank' }),
    h('span', { class: 'lvl', 'aria-hidden': 'true' }, e.level));
}

function entryRow(e, m, showName, seen) {
  const p = player(e.player);
  const units = [...e.units].sort((a, b) => unitCost(b) - unitCost(a) || b.star - a.star);
  return h('div', { class: 'entry' },
    h('div', { class: 'entry-left' },
      h('div', { class: `place p${e.placement}`, title: `Placed ${ordinal(e.placement)}` }, ordinal(e.placement)),
      tacticianBadge(e)),
    h('div', { class: 'board' },
      showName ? h('a', { class: 'name', href: `#/player/${e.player}` }, p?.name ?? e.player) : null,
      h('div', { class: 'traits' }, sortTraits(e.traits).map(traitBadge)),
      h('div', { class: 'units' }, units.map(unitTile)),
      e.augments ? h('div', { class: 'augments' }, `Augments: ${e.augments.map(nameOf).join(', ')}`) : null),
    lpBlock(e, m, seen));
}

/** One game. With `focus` set, only that player's board is shown (no teammates). */
function matchCard(m, focus, seen) {
  const entries = focus ? m.entries.filter((e) => e.player === focus) : m.entries;
  return h('article', { class: 'match' },
    h('div', { class: 'match-head' },
      h('span', { class: 'queue', title: `Queue ID ${m.queue}` }, queueName(m.queue)),
      h('span', {}, fmtDateTime.format(m.time)),
      h('span', {}, duration(m.length)),
      m.patch ? h('span', {}, `Patch ${m.patch}`) : null),
    entries.map((e) => entryRow(e, m, !focus, seen)));
}

// How many games the newest list is showing (it grows with "Show more"), so a live refresh can keep them open.
let shownCount = 0, keepShown = 0;
function matchList(matches, focus, pageSize = 25) {
  const box = h('div', { class: 'matches' });
  let shown = 0;
  const target = keepShown;
  keepShown = 0;
  const seen = new Set(); // combined-LP groups already shown (matches are newest first)
  const more = h('button', { class: 'btn more', onclick: () => next() }, 'Show more');
  function next() {
    more.remove();
    for (const m of matches.slice(shown, shown + pageSize)) box.append(matchCard(m, focus, seen));
    shown += pageSize;
    shownCount = shown;
    if (shown < matches.length) box.append(more);
  }
  shownCount = 0;
  if (!matches.length) box.append(h('p', { class: 'muted' }, 'No games.'));
  else do next(); while (shown < target && shown < matches.length);
  return box;
}

/**
 * Table sorted by sortState. Columns with `sort` can be sorted by; only those that are also
 * `clickable` get a header button (others, like the default rank order, sort but can't be picked).
 */
function sortableTable(columns, rows, sortState, onSort) {
  const col = columns.find((c) => c.key === sortState.key && c.sort) ?? columns.find((c) => c.sort);
  const sorted = [...rows].sort((a, b) => {
    const va = col.sort(a), vb = col.sort(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return (va < vb ? -1 : va > vb ? 1 : 0) * sortState.dir;
  });
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, columns.map((c) =>
      h('th', { class: c.right ? 'r' : null, 'aria-sort': c.key === sortState.key ? (sortState.dir > 0 ? 'ascending' : 'descending') : null },
        c.sort && c.clickable ? h('button', { onclick: () => onSort(c) }, c.label) : c.label)))),
    h('tbody', {}, sorted.map((r) => h('tr', {}, columns.map((c) => h('td', { class: c.right ? 'r' : null }, c.cell(r))))))));
}

// ---------------------------------------------------------------- charts

function niceTicks(lo, hi, count = 4) {
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((x) => x >= raw);
  const ticks = [];
  // Round both ends outward so the axis always contains the data (no bar past the top/bottom line).
  const end = Math.ceil(hi / step - 1e-9) * step;
  for (let v = Math.floor(lo / step + 1e-9) * step; v <= end + 1e-9; v += step) ticks.push(v);
  return ticks;
}

function chartBox(draw) {
  const box = h('div', { class: 'chart' });
  const run = () => draw(box, box.clientWidth || 600);
  redraws.push(run);
  requestAnimationFrame(run);
  return box;
}

/**
 * SVG path through [[x, y]] as a smooth curve that never overshoots the points
 * (monotone cubic, like d3's curveMonotoneX), so it can't poke past the highest/lowest value.
 */
function smoothPath(P) {
  const n = P.length;
  if (n < 3) return P.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join('');
  const dx = [], sl = [];
  for (let i = 0; i < n - 1; i++) { dx[i] = P[i + 1][0] - P[i][0]; sl[i] = (P[i + 1][1] - P[i][1]) / dx[i]; }
  const tan = [sl[0]];
  for (let i = 1; i < n - 1; i++) {
    tan[i] = sl[i - 1] * sl[i] <= 0 ? 0
      : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / sl[i - 1] + (dx[i] + 2 * dx[i - 1]) / sl[i]);
  }
  tan[n - 1] = sl[n - 2];
  let d = `M${P[0][0]},${P[0][1]}`;
  for (let i = 0; i < n - 1; i++) {
    const h3 = dx[i] / 3;
    d += `C${P[i][0] + h3},${P[i][1] + tan[i] * h3} ${P[i + 1][0] - h3},${P[i + 1][1] - tan[i + 1] * h3} ${P[i + 1][0]},${P[i + 1][1]}`;
  }
  return d;
}

/** Rank over time: one point per game, evenly spaced, smooth line with a soft fill. */
function rankChart(p) {
  const pts = p.history.filter(([, v]) => v != null);
  if (pts.length < 2) {
    return h('div', { class: 'empty-chart' }, 'The rank line appears once the tracker has seen this player’s rank change.');
  }
  return chartBox((box, W) => {
    const H = 260, m = { l: 84, r: 112, t: 12, b: 28 };
    const vals = pts.map(([, v]) => v);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const step = hi - lo > 700 ? 400 : 100; // label tiers when the range is wide, divisions when narrow
    lo = Math.floor((lo - 20) / step) * step;
    hi = Math.ceil((hi + 20) / step) * step;
    if (hi - lo < 2 * step) hi = lo + 2 * step;
    // Games are spaced evenly (not by clock time), so busy days don't turn into spikes.
    const X = (i) => m.l + (i / (pts.length - 1)) * (W - m.l - m.r);
    const Y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);

    const P = pts.map(([, v], i) => [X(i), Y(v)]);
    // The line is colored by tier: a left-to-right gradient with one stop per game, so the
    // color is solid within a tier and blends over the one game where the rank changes.
    const gid = `rank-color-${p.slug}`;
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', tabindex: 0,
      'aria-label': `${p.name}'s rank over time, from ${scoreLabel(pts[0][1], 100)} to ${rankText(p.current)}. Use left and right arrow keys to step through games.` },
      s('defs', {},
        s('linearGradient', { id: gid, gradientUnits: 'userSpaceOnUse', x1: m.l, y1: 0, x2: W - m.r, y2: 0 },
          pts.map(([, , tier], i) => s('stop', { offset: i / (pts.length - 1), style: `stop-color: ${tierColor(tier)}` })))));
    // Background: a faint band per tier, so tier breaks show behind the line.
    for (const [from, to, tier] of tierBands()) {
      const y1 = Y(Math.min(hi, to)), y2 = Y(Math.max(lo, from));
      if (y2 - y1 <= 0) continue;
      svg.append(s('rect', { class: 'band', x: m.l, y: y1, width: W - m.l - m.r, height: y2 - y1, style: `fill: ${tierColor(tier)}` }));
    }
    for (let v = lo; v <= hi; v += step) {
      svg.append(s('line', { class: 'gridline', x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v) }),
        s('text', { class: 'tick', x: m.l - 8, y: Y(v) + 4, 'text-anchor': 'end' }, scoreLabel(v, step)));
    }
    // A faint line marks where each week starts; its label is centered under that week's stretch.
    const spans = [...site.weeks].reverse()
      .map((w) => ({ w, i: pts.findIndex(([t]) => t >= w.start && t < w.end) }))
      .filter((x) => x.i >= 0);
    let lastX = -Infinity;
    spans.forEach(({ w, i }, k) => {
      const x1 = i === 0 ? m.l : X(i), x2 = k + 1 < spans.length ? X(spans[k + 1].i) : W - m.r;
      if (i > 0) svg.append(s('line', { class: 'weekline', x1, x2: x1, y1: m.t, y2: H - m.b }));
      const x = (x1 + x2) / 2;
      if (x - lastX < 60) return;
      svg.append(s('text', { class: 'tick', x, y: H - 8, 'text-anchor': 'middle' }, weekName(w.key)));
      lastX = x;
    });
    svg.append(s('line', { class: 'baseline', x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b }));
    // Tier breaks: a stronger line wherever one tier's band meets the next (drawn over the gridlines).
    for (const [from] of tierBands()) {
      if (from > lo && from < hi) svg.append(s('line', { class: 'tierline', x1: m.l, x2: W - m.r, y1: Y(from), y2: Y(from) }));
    }

    const line = smoothPath(P);
    const [, lastV, lastTier] = pts.at(-1), endX = X(pts.length - 1);
    svg.append(
      s('path', { class: 'series smooth', d: line, style: `stroke: url(#${gid})` }),
      s('circle', { class: 'dot', cx: endX, cy: Y(lastV), r: 4, style: `fill: ${tierColor(lastTier)}` }),
      s('text', { class: 'endlabel', x: endX + 10, y: Y(lastV) + 4 }, p.current ? rankText(p.current).replace(' · ', ' ') : scoreLabel(lastV, 100)));

    const cross = s('line', { class: 'crosshair', y1: m.t, y2: H - m.b, visibility: 'hidden' });
    const hoverDot = s('circle', { class: 'dot', r: 5, visibility: 'hidden' });
    svg.append(cross, hoverDot);
    let idx = pts.length - 1;
    const show = (i, cx, cy) => {
      idx = i;
      const [t, v, tier] = pts[i];
      const prev = i > 0 ? pts[i - 1][1] : null;
      hoverDot.style.fill = tierColor(tier);
      cross.setAttribute('x1', X(i)); cross.setAttribute('x2', X(i)); cross.setAttribute('visibility', 'visible');
      hoverDot.setAttribute('cx', X(i)); hoverDot.setAttribute('cy', Y(v)); hoverDot.setAttribute('visibility', 'visible');
      const rect = svg.getBoundingClientRect();
      showTip([
        ['tv', isApexScore(v) ? `${tier ? title(tier) : 'Master+'} ${v - APEX} LP` : `${scoreLabel(v, 100)} · ${v % 100} LP`, tierColor(tier)],
        ['tl', prev == null ? 'Starting rank' : `${signed(v - prev)} LP`],
        ['tl', fmtDateTime.format(t)],
      ], cx ?? rect.left + (X(i) / W) * rect.width, cy ?? rect.top + (Y(v) / H) * rect.height);
    };
    const hide = () => { cross.setAttribute('visibility', 'hidden'); hoverDot.setAttribute('visibility', 'hidden'); hideTip(); };
    const hit = s('rect', { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: 'transparent' });
    hit.addEventListener('pointermove', (ev) => {
      const rect = svg.getBoundingClientRect();
      const px = ((ev.clientX - rect.left) / rect.width) * W;
      const i = Math.round(((px - m.l) / (W - m.l - m.r)) * (pts.length - 1));
      show(Math.max(0, Math.min(pts.length - 1, i)), ev.clientX, ev.clientY);
    });
    hit.addEventListener('pointerleave', hide);
    svg.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowLeft') { show(Math.max(0, idx - 1)); ev.preventDefault(); }
      if (ev.key === 'ArrowRight') { show(Math.min(pts.length - 1, idx + 1)); ev.preventDefault(); }
    });
    svg.addEventListener('focus', () => show(idx));
    svg.addEventListener('blur', hide);
    svg.append(hit);
    box.replaceChildren(svg);
  });
}
const isApexScore = (v) => v >= APEX;
/**
 * [fromScore, toScore, tier] for every tier on the ladder score scale. Iron-Diamond are fixed
 * 400-point tiers; Grandmaster/Challenger start at today's estimated LP cutoffs (site.apexCutoffs).
 */
function tierBands() {
  const bands = TIERS.slice(0, 7).map((t, i) => [i * 400, i * 400 + 400, t]);
  const c = site.apexCutoffs;
  if (!c) return [...bands, [APEX, Infinity, 'MASTER']];
  return [...bands, [APEX, APEX + c.grandmaster, 'MASTER'],
    [APEX + c.grandmaster, APEX + c.challenger, 'GRANDMASTER'], [APEX + c.challenger, Infinity, 'CHALLENGER']];
}
const tierColor = (tier) => (tier && TIERS.includes(tier) ? `var(--t-${tier.toLowerCase()})` : 'var(--pos)');

/** Net LP per week: diverging columns from a zero baseline. */
function weeklyChart(p, selKey) {
  const weeks = site.weeks.filter((w) => p.weeks[w.key]?.lp != null).reverse();
  if (!weeks.length) return h('div', { class: 'empty-chart' }, 'No tracked weeks yet.');
  return chartBox((box, W) => {
    const H = 240, m = { l: 48, r: 12, t: 12, b: 28 };
    const vals = weeks.map((w) => p.weeks[w.key].lp);
    const ticks = niceTicks(Math.min(0, ...vals), Math.max(0, ...vals, 10));
    const lo = ticks[0], hi = ticks.at(-1);
    const Y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
    const band = (W - m.l - m.r) / weeks.length;
    const bw = Math.min(24, band * 0.6);
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': `${p.name}'s net LP by week. Values are in the table below.` });
    for (const v of ticks) {
      svg.append(s('line', { class: v === 0 ? 'baseline' : 'gridline', x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v) }),
        s('text', { class: 'tick', x: m.l - 8, y: Y(v) + 4, 'text-anchor': 'end' }, v > 0 ? `+${v}` : v < 0 ? `−${-v}` : '0'));
    }
    const every = Math.ceil(weeks.length / Math.max(1, Math.floor((W - m.l - m.r) / 56)));
    weeks.forEach((w, i) => {
      const wk = p.weeks[w.key];
      const cx = m.l + band * (i + 0.5);
      const y0 = Y(0), y1 = Y(wk.lp);
      const hgt = Math.abs(y1 - y0), r = Math.min(4, hgt, bw / 2), x = cx - bw / 2;
      const up = wk.lp >= 0;
      const d = hgt < 0.5 ? '' : up
        ? `M${x},${y0}V${y1 + r}Q${x},${y1} ${x + r},${y1}H${x + bw - r}Q${x + bw},${y1} ${x + bw},${y1 + r}V${y0}Z`
        : `M${x},${y0}V${y1 - r}Q${x},${y1} ${x + r},${y1}H${x + bw - r}Q${x + bw},${y1} ${x + bw},${y1 - r}V${y0}Z`;
      const lines = [
        ['tv', `${signed(wk.lp)} LP${wk.partial ? ' (partial week)' : ''}`],
        ['tl', `${wk.ranked.games} ranked game${wk.ranked.games === 1 ? '' : 's'}${wk.ranked.avg != null ? ` · avg ${avg(wk.ranked.avg)}` : ''}`],
        ['tl', weekFull(w.key)],
      ];
      const hit = s('rect', { class: `hit ${w.key === selKey ? 'sel' : ''}`, x: cx - band / 2, y: m.t, width: band, height: H - m.t - m.b, tabindex: 0,
        'aria-label': `${weekFull(w.key)}: ${signed(wk.lp)} LP`, 'aria-current': w.key === selKey ? 'true' : null });
      hit.addEventListener('pointermove', (ev) => showTip(lines, ev.clientX, ev.clientY));
      hit.addEventListener('pointerleave', hideTip);
      hit.addEventListener('focus', () => tipAtElement(hit, lines));
      hit.addEventListener('blur', hideTip);
      hit.addEventListener('click', () => { location.hash = `#/player/${p.slug}/${w.key}`; });
      svg.append(hit, s('path', { class: `bar ${up ? 'pos' : 'neg'}`, d, 'pointer-events': 'none' }));
      if (i % every === 0) svg.append(s('text', { class: 'tick', x: cx, y: H - 8, 'text-anchor': 'middle' }, weekShort(w.key)));
    });
    box.replaceChildren(svg);
  });
}

// ---------------------------------------------------------------- week helpers

/** Index into site.weeks (newest first) for a week key; unknown/missing -> current week (0). */
const weekIndex = (key) => Math.max(0, site.weeks.findIndex((w) => w.key === key));
/** Week part of a URL: omitted for the current week so links stay short. */
const weekPath = (key) => (key && key !== site.weeks[0].key ? `/${key}` : '');
const teamHref = (key) => (weekPath(key) ? `#/week/${key}` : '#/');
const playerHref = (slug, key) => `#/player/${slug}${weekPath(key)}`;

// Drawn chevrons for the ‹ › buttons: text glyphs sit low in the line, these center exactly.
const chevron = (dir) => s('svg', { class: 'chev', viewBox: '0 0 16 16', 'aria-hidden': 'true' },
  s('path', { d: dir < 0 ? 'M10 3.5 5.5 8l4.5 4.5' : 'M6 3.5 10.5 8 6 12.5' }));

function weekNav(idx, hrefFor) {
  const weeks = site.weeks;
  const older = idx < weeks.length - 1, newer = idx > 0;
  return h('div', { class: 'week-nav' },
    h('a', { class: 'btn', href: older ? hrefFor(weeks[idx + 1].key) : null, 'aria-disabled': older ? null : 'true', 'aria-label': 'Previous week' }, chevron(-1)),
    h('div', { class: 'week-label' }, weekTitle(weeks[idx].key), idx === 0 ? h('span', { class: 'pill' }, 'This week') : null),
    h('a', { class: 'btn', href: newer ? hrefFor(weeks[idx - 1].key) : null, 'aria-disabled': newer ? null : 'true', 'aria-label': 'Next week' }, chevron(1)));
}

// ---------------------------------------------------------------- team overview

function teamTotals(key) {
  let games = 0, placeSum = 0, top4 = 0, lp = 0, tracked = 0;
  for (const p of site.players) {
    const w = p.weeks[key];
    if (!w) continue;
    games += w.ranked.games;
    placeSum += (w.ranked.avg ?? 0) * w.ranked.games;
    top4 += ((w.ranked.top4 ?? 0) / 100) * w.ranked.games;
    if (w.lp != null) { lp += w.lp; tracked++; }
  }
  return { games, avg: games ? placeSum / games : null, top4: games ? (top4 / games) * 100 : null, lp: tracked ? lp : null, tracked };
}

function renderOverview(key) {
  const idx = weekIndex(key);
  const week = site.weeks[idx];
  const T = teamTotals(week.key);

  const tiles = h('div', { class: 'tiles' },
    tile('Team net LP', T.lp == null ? '—' : signed(T.lp), T.tracked < site.players.length ? `${T.tracked} of ${site.players.length} players (LP unknown for the rest)` : 'all players combined', T.lp != null ? deltaClass(T.lp) : ''),
    tile('Ranked games', String(T.games), 'all players combined'),
    tile('Average placement', avg(T.avg), 'ranked games'),
    tile('Top 4 rate', pct(T.top4), 'ranked games'));

  const isCurrent = idx === 0;
  const columns = [
    { key: 'name', label: 'Player', cell: (r) => h('span', { class: 'player-cell' }, h('a', { href: playerHref(r.p.slug, week.key) }, r.p.name), h('span', { class: 'muted' }, r.p.riotId)) },
    { key: 'rank', label: isCurrent ? 'Rank' : 'Rank at end of week', sort: (r) => scoreOf(r.rank), cell: (r) => (r.rank || isCurrent ? rankText(r.rank) : h('span', { class: 'muted', title: 'Rank was not being tracked yet' }, '—')) },
    { key: 'lp', label: 'Net LP', right: true, clickable: true, sort: (r) => r.w?.lp, cell: (r) => (r.w?.lp == null ? h('span', { class: 'muted', title: 'Not tracked yet' }, '—') : h('span', { class: deltaClass(r.w.lp) }, signed(r.w.lp) + (r.w.partial ? '*' : ''))) },
    { key: 'games', label: 'Games', right: true, clickable: true, sort: (r) => r.w?.ranked.games ?? 0, cell: (r) => r.w?.ranked.games ?? 0 },
    { key: 'avg', label: 'Avg place', right: true, clickable: true, sort: (r) => r.w?.ranked.avg, cell: (r) => avg(r.w?.ranked.avg) },
    { key: 'top4', label: 'Top 4', right: true, clickable: true, sort: (r) => r.w?.ranked.top4, cell: (r) => pct(r.w?.ranked.top4) },
    { key: 'firsts', label: '1sts', right: true, clickable: true, sort: (r) => r.w?.ranked.firsts ?? 0, cell: (r) => r.w?.ranked.firsts ?? 0 },
  ];
  const rows = site.players.map((p) => ({ p, w: p.weeks[week.key], rank: isCurrent ? p.current : p.weeks[week.key]?.endRank }));
  // Clicking a column cycles: its natural order (best first) -> reversed -> back to rank.
  const board = sortableTable(columns, rows, ui.sort, (c) => {
    const first = c.key === 'avg' ? 1 : -1; // lower average placement is better
    if (ui.sort.key !== c.key) ui.sort = { key: c.key, dir: first };
    else if (ui.sort.dir === first) ui.sort = { key: c.key, dir: -first };
    else ui.sort = { key: 'rank', dir: -1 };
    render();
  });

  app.replaceChildren(
    h('div', { class: 'filters' }, weekNav(idx, teamHref)),
    tiles,
    h('section', { class: 'card' }, h('h2', {}, 'Leaderboard'),
      h('p', { class: 'sub' }, 'Ranked games only. Click a column to sort, or a player to see their games this week.'), board));
}

// ---------------------------------------------------------------- player page

async function renderPlayer(slug, weekKey, myId) {
  const p = player(slug);
  if (!p) {
    app.replaceChildren(h('p', { class: 'notice' }, 'Player not found. ', h('a', { href: '#/' }, 'Back to the team page')));
    return;
  }
  const idx = weekIndex(weekKey);
  const week = site.weeks[idx];
  const w = p.weeks[week.key];
  const isCurrent = idx === 0;

  const head = h('section', { class: 'card' },
    h('div', { class: 'player-head' },
      h('div', {},
        h('h1', {}, p.name, ' ', h('span', { class: 'muted', style: 'font-weight:400;font-size:15px' }, p.riotId)),
        h('div', { class: 'hero' }, rankText(p.current)))));

  const nav = h('div', { class: 'filters' }, weekNav(idx, (k) => playerHref(slug, k)));

  const lpNote = w?.lp == null ? 'rank not tracked this week'
    : w.partial ? '* tracking started mid-week'
    : w.fromGames ? 'sum of each game’s LP'
    : w.fromRanks ? `${w.endRank ? rankText(w.endRank) : ''} at week’s end`
    : isCurrent ? 'so far this week' : `ended at ${rankText(w.endRank)}`;
  const tiles = h('div', { class: 'tiles' },
    tile('Net LP', w?.lp == null ? '—' : signed(w.lp) + (w.partial ? '*' : ''), lpNote, w?.lp != null ? deltaClass(w.lp) : ''),
    tile('Ranked games', String(w?.ranked.games ?? 0), w?.otherGames ? `+ ${w.otherGames} other` : null),
    tile('Avg placement', avg(w?.ranked.avg), 'ranked games'),
    tile('Top 4 rate', pct(w?.ranked.top4), w?.ranked.firsts ? `${w.ranked.firsts} first${w.ranked.firsts > 1 ? 's' : ''}` : 'ranked games'));

  // The games list header: title on the left, the ranked-only filter on the right.
  const gamesTitle = () => h('div', { class: 'card-head' },
    h('h2', { class: 'week-title' }, `${weekName(week.key)} games`, weekNum(week.key) ? h('span', { class: 'week-dates' }, weekLabel(week.key)) : null),
    h('label', { class: 'toggle' },
      h('input', { type: 'checkbox', checked: ui.rankedOnly, onchange: (e) => { ui.rankedOnly = e.target.checked; render(); } }),
      'Ranked games only'));
  const games = h('section', { class: 'card' }, gamesTitle(), h('p', { class: 'sub' }, 'Loading…'));

  const charts = h('div', { class: 'grid-2' },
    h('section', { class: 'card' }, h('h2', {}, 'Net LP by week'), h('p', { class: 'sub' }, 'Click a bar to see that week’s games.'), weeklyChart(p, week.key)),
    h('section', { class: 'card' }, h('h2', {}, 'Rank over time'), h('p', { class: 'sub' }, 'Rank after each game, oldest to newest. Hover for details.'), rankChart(p)));

  const weekRows = site.weeks.filter((x) => p.weeks[x.key] && (p.weeks[x.key].ranked.games || p.weeks[x.key].lp || p.weeks[x.key].otherGames));
  const weekTable = h('section', { class: 'card' }, h('h2', {}, 'Week by week'), h('p', { class: 'sub' }, 'Click a week to see its games.'),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Week', 'Net LP', 'Ranked games', 'Avg place', 'Top 4', '1sts', 'Other games', 'Rank at end'].map((c, i) => h('th', { class: i && i < 7 ? 'r' : null }, c)))),
      h('tbody', {}, weekRows.map((x) => {
        const wk = p.weeks[x.key];
        return h('tr', { class: `link ${x.key === week.key ? 'selected' : ''}`, tabindex: 0,
          onclick: () => { location.hash = playerHref(slug, x.key); },
          onkeydown: (e) => { if (e.key === 'Enter') e.currentTarget.click(); } },
          h('td', { class: 'week-cell' }, weekTitle(x.key, 'span')),
          h('td', { class: 'r' }, wk.lp == null ? h('span', { class: 'muted' }, '—') : h('span', { class: deltaClass(wk.lp) }, signed(wk.lp) + (wk.partial ? '*' : ''))),
          h('td', { class: 'r' }, wk.ranked.games),
          h('td', { class: 'r' }, avg(wk.ranked.avg)),
          h('td', { class: 'r' }, pct(wk.ranked.top4)),
          h('td', { class: 'r' }, wk.ranked.firsts),
          h('td', { class: 'r' }, wk.otherGames),
          h('td', {}, wk.endRank ? rankText(wk.endRank) : h('span', { class: 'muted' }, 'not tracked')));
      })))));

  app.replaceChildren(head, nav, tiles, charts, games, weekTable);

  const data = await loadWeek(week.key);
  if (myId !== renderId) return;
  const mine = data.matches.filter((m) => m.entries.some((e) => e.player === slug) && (!ui.rankedOnly || m.queue === RANKED));
  games.replaceChildren(
    gamesTitle(),
    h('p', { class: 'sub' }, `${mine.length} ${ui.rankedOnly ? 'ranked ' : ''}game${mine.length === 1 ? '' : 's'}, newest first.`),
    matchList(mine, slug, 20));
}

// ---------------------------------------------------------------- boot + routing

/** Header tabs: Team, Recent games, then one per player. Links keep the week you're looking at. */
function renderPages(route, slug, weekKey) {
  const nav = document.getElementById('pages');
  const players = [...site.players].sort((x, y) => x.name.localeCompare(y.name));
  nav.replaceChildren(
    h('a', { href: teamHref(weekKey), 'aria-current': route !== 'player' && route !== 'recent' ? 'page' : null }, 'Team'),
    h('a', { href: '#/recent', 'aria-current': route === 'recent' ? 'page' : null }, 'Recent games'),
    h('span', { class: 'sep', 'aria-hidden': 'true' }),
    ...players.map((p) => h('a', { href: playerHref(p.slug, weekKey), 'aria-current': route === 'player' && slug === p.slug ? 'page' : null }, p.name)));
  nav.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// ---------------------------------------------------------------- recent games page

async function renderRecent(myId) {
  const head = () => [h('h2', { class: 'section-title' }, 'Most recent games')];
  const recent = h('section', { class: 'card' }, head(), h('p', { class: 'muted' }, 'Loading…'));
  app.replaceChildren(recent);

  const weeks = await Promise.all(site.weeks.slice(0, 2).map((w) => loadWeek(w.key)));
  if (myId !== renderId) return;
  const matches = weeks.flatMap((w) => w.matches).sort((x, y) => y.time - x.time);
  recent.replaceChildren(...head(), matchList(matches, null, 10));
}

async function render() {
  const myId = ++renderId;
  redraws = [];
  hideTip();
  app.classList.add('loading');
  const [route, a, b] = location.hash.replace(/^#\/?/, '').split('/');
  const weekKey = site.weeks[weekIndex(route === 'player' ? b : route === 'week' ? a : null)].key;
  renderPages(route, a, weekKey);
  try {
    if (route === 'player') await renderPlayer(a, weekKey, myId);
    else if (route === 'recent') await renderRecent(myId);
    else renderOverview(weekKey);
  } finally {
    if (myId === renderId) app.classList.remove('loading');
  }
}

// Light/dark toggle. The theme itself is picked in index.html before first paint;
// this flips it and remembers the choice (storage can be blocked, so that's best effort).
function setupThemeToggle() {
  const btn = document.getElementById('theme-toggle');
  const root = document.documentElement;
  const label = () => {
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    btn.setAttribute('aria-label', `Switch to ${next} mode`);
    btn.title = `Switch to ${next} mode`;
  };
  btn.addEventListener('click', () => {
    root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('theme', root.dataset.theme); } catch {}
    label();
  });
  // Follow the system setting until the person picks one.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    let saved = null;
    try { saved = localStorage.getItem('theme'); } catch {}
    if (!saved) { root.dataset.theme = e.matches ? 'dark' : 'light'; label(); }
  });
  label();
}

// ---------------------------------------------------------------- live refresh
// The data is rebuilt about every 15 minutes, and each build stamps data/status.json with its time.
// An open page shows "Last updated X minutes ago" from that stamp (re-counted every 30 seconds on the
// viewer's clock), checks the stamp every 2 minutes and whenever the tab comes back into view, and when
// there's a newer build it reloads the data and redraws in place: same page, week, scroll position and filters.

const CHECK_EVERY_MS = 2 * 60e3;
let updatedAt = null; // build time of the data on screen
let lastCheck = 0;
let checking = false;
let headerNote = null; // replaces "Last updated …" while the button is working

/** data/status.json: { updatedAt, live }, or null if it can't be read. */
async function fetchStatus() {
  try {
    // a new query string every time, so neither the browser nor the CDN answers from a cached copy
    const res = await fetch(`data/status.json?t=${Date.now()}`, { cache: 'no-store' });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

function agoText(t) {
  const min = Math.floor((Date.now() - t) / 60e3);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  const d = Math.floor(hr / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

function showUpdated() {
  const el = document.getElementById('updated');
  if (headerNote) el.replaceChildren(headerNote);
  else if (updatedAt) el.replaceChildren(h('span', { class: 'wide-only' }, 'Last updated'), h('span', { class: 'narrow-only' }, 'Updated'), ` ${agoText(updatedAt)}`);
  else el.replaceChildren();
  el.title = updatedAt ? fmtDateTime.format(updatedAt) : '';
}

/** Returns once the check is done (or right away if another check is already running). */
async function checkForUpdate({ force = false } = {}) {
  if (checking || (document.hidden && !force)) return;
  checking = true;
  lastCheck = Date.now();
  try {
    const status = await fetchStatus();
    const t = status?.updatedAt;
    if (!t || t <= (updatedAt ?? 0)) return;
    const version = `?v=${t}`;
    const res = await fetch(`data/site.json${version}`, { cache: 'no-cache' });
    if (!res.ok) return; // try again next time
    const next = await res.json();
    if (!next.players?.length || !next.weeks?.length) return;
    site = next;
    dataVersion = version;
    weekCache.clear();
    traitIconSet = unitIconSet = itemIconSet = tacticianIconSet = undefined;
    // Load the week on screen before redrawing, so the games list doesn't flash "Loading…" and the page keeps its height.
    const [route, a, b] = location.hash.replace(/^#\/?/, '').split('/');
    await loadWeek(site.weeks[weekIndex(route === 'player' ? b : route === 'week' ? a : null)].key).catch(() => {});
    const y = window.scrollY;
    keepShown = shownCount; // keep any "Show more" pages that were open
    await render();
    keepShown = 0; // only for this redraw (unused if the page has no games list)
    window.scrollTo(0, y);
    updatedAt = t;
    showUpdated();
  } catch {
    // network hiccup: the next check retries
  } finally {
    checking = false;
  }
}

// ---------------------------------------------------------------- "Check for new games" button
// Asks the worker in site.updateUrl (worker/update-button.js) to start an update, then watches data/status.json
// until the new build is live (usually under a minute) and redraws in place. Hidden when updateUrl isn't set.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setupCheckButton() {
  const btn = document.getElementById('check-btn');
  if (!site.updateUrl) return;
  btn.hidden = false;
  btn.addEventListener('click', () => requestUpdate(btn));
}

async function requestUpdate(btn) {
  const note = async (text, ms) => { headerNote = text; showUpdated(); if (ms) { await sleep(ms); headerNote = null; showUpdated(); } };
  btn.disabled = true;
  btn.classList.add('busy');
  try {
    let reply = {};
    try {
      const res = await fetch(site.updateUrl, { method: 'POST' });
      reply = await res.json().catch(() => ({ error: res.status }));
    } catch {
      reply = { error: 'offline' };
    }
    if (reply.status === 'recent') {
      // a check started moments ago: show its result if it's out, and say when another can start
      await checkForUpdate({ force: true });
      btn.classList.remove('busy');
      await note(`Just checked · try again in ${reply.retryIn}s`, 5000);
      return;
    }
    if (reply.status !== 'started' && reply.status !== 'running') {
      btn.classList.remove('busy');
      await note('Couldn’t start an update', 5000);
      return;
    }
    await note('Checking for new games…');
    const before = updatedAt ?? 0;
    const deadline = Date.now() + 4 * 60e3; // updates normally finish in about a minute
    let done = false;
    while (!done && Date.now() < deadline) {
      await sleep(2500);
      const t = (await fetchStatus())?.updatedAt;
      if (t && t > before) {
        while (checking) await sleep(250); // a background check may be redrawing already
        await checkForUpdate({ force: true });
        done = (updatedAt ?? 0) > before;
      }
    }
    btn.classList.remove('busy');
    headerNote = null;
    if (!done) await note('Still updating · check back in a minute', 6000);
    else showUpdated();
  } finally {
    btn.classList.remove('busy');
    btn.disabled = false;
  }
}

async function boot() {
  setupThemeToggle();
  try {
    // status first: if a deploy lands in between, the page just refreshes once more at the next check
    const status = await fetchStatus();
    updatedAt = status?.updatedAt ?? null;
    dataVersion = updatedAt ? `?v=${updatedAt}` : '';
    const res = await fetch(`data/site.json${dataVersion}`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status);
    site = await res.json();
  } catch {
    app.replaceChildren(h('div', { class: 'notice' }, 'No data yet. Run ', h('code', {}, 'npm run update'), ' (see the README), then reload.'));
    return;
  }
  initFormats();
  document.title = `${site.teamName} · TFT Tracker`;
  document.getElementById('brand').textContent = site.teamName;
  showUpdated();
  setInterval(showUpdated, 30e3);
  setupCheckButton();
  if (!site.players.length || !site.weeks?.length) {
    app.replaceChildren(h('div', { class: 'notice' }, 'No players found. Add Riot IDs to ', h('code', {}, 'config.json'), ' and run ', h('code', {}, 'npm run update'), '.'));
    return;
  }
  window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
  let t;
  window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => redraws.forEach((f) => f()), 150); });
  render();
  setInterval(checkForUpdate, CHECK_EVERY_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - lastCheck > 30e3) checkForUpdate();
  });
}

boot();
