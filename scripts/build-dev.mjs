// Robot Diffuz (version Dev) : récupère sur TheSportsDB tous les matchs de foot
// télévisés des prochains jours, avec les chaînes match par match et pays par pays,
// et écrit public/matches-dev.json (lu seulement par l'appli Diffuz Dev).
//
// Lancement : THESPORTSDB_KEY=xxx node scripts/build-dev.mjs
// Test hors ligne : DIFFUZ_TSDB_SAMPLE=dossier node scripts/build-dev.mjs
//   (le dossier contient events.json et tv.json, au format des réponses TheSportsDB)

import { mkdir, readFile, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const rights = JSON.parse(await readFile(new URL('data/rights.json', root), 'utf8'));
const countryMap = JSON.parse(await readFile(new URL('data/countries.json', root), 'utf8')).countries;

// Les 6 compétitions historiques gardent leur code, leur nom et leurs diffuseurs de secours.
const BIG = { 4480: 'CL', 4334: 'FL1', 4328: 'PL', 4335: 'PD', 4332: 'SA', 4331: 'BL1' };
const BIG_ORDER = ['CL', 'FL1', 'PL', 'PD', 'SA', 'BL1'];
const TV_LIMIT = 1500; // nombre maximal de lignes renvoyées par eventstv.php (abonnement)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s) => String(s || '').trim().toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const isoDay = (d) => d.toISOString().slice(0, 10);
const now = new Date();
const dates = [-1, 0, 1, 2, 3, 4, 5].map((o) => isoDay(new Date(now.getTime() + o * 86400000)));

async function get(path) {
  const key = process.env.THESPORTSDB_KEY;
  const url = `https://www.thesportsdb.com/api/v1/json/${key}/${path}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url);
    if (res.status === 429) { console.log("Trop de requêtes, pause d'une minute..."); await sleep(61000); continue; }
    if (!res.ok) throw new Error(`TheSportsDB a répondu ${res.status} pour ${path.split('?')[0]}`);
    const text = await res.text();
    try { return JSON.parse(text); } catch (e) { throw new Error(`Réponse illisible pour ${path.split('?')[0]} : ${text.slice(0, 120)}`); }
  }
  throw new Error('TheSportsDB refuse les requêtes (limite atteinte).');
}

let events = [];
let tv = [];
if (process.env.DIFFUZ_TSDB_SAMPLE) {
  const dir = process.env.DIFFUZ_TSDB_SAMPLE.replace(/\/?$/, '/');
  events = JSON.parse(await readFile(dir + 'events.json', 'utf8'));
  tv = JSON.parse(await readFile(dir + 'tv.json', 'utf8'));
} else {
  if (!process.env.THESPORTSDB_KEY) {
    console.error('Clé THESPORTSDB_KEY manquante (à ajouter dans les secrets GitHub).');
    process.exit(1);
  }
  for (const d of dates) {
    const ev = (await get(`eventsday.php?d=${d}&s=Soccer`)).events || [];
    await sleep(800);
    const t = (await get(`eventstv.php?d=${d}&s=Soccer`)).tvevents || [];
    await sleep(800);
    console.log(`${d} : ${ev.length} matchs, ${t.length} diffusions`);
    if (t.length >= TV_LIMIT) console.warn(`ATTENTION ${d} : limite de ${TV_LIMIT} diffusions atteinte, certaines chaînes peuvent manquer.`);
    events.push(...ev);
    tv.push(...t);
  }
}

// Chaînes par match : { idEvent: { pays: [chaînes] } }
const unknownCountries = new Set();
const usedCountries = {};
const channelsByEvent = {};
const tvInfo = {};
for (const row of tv) {
  if (row.strSport && row.strSport !== 'Soccer') continue;
  const id = String(row.idEvent || '');
  const name = String(row.strChannel || '').trim();
  if (!id || !name) continue;
  const s = slug(row.strCountry) || 'international';
  let c = countryMap[s];
  if (!c) { unknownCountries.add(row.strCountry); c = countryMap.international; }
  usedCountries[c.code] = { fr: c.fr, en: c.en, region: c.region };
  const byC = (channelsByEvent[id] = channelsByEvent[id] || {});
  const list = (byC[c.code] = byC[c.code] || []);
  if (!list.includes(name)) list.push(name);
  if (!tvInfo[id]) tvInfo[id] = row;
}

const STATUS = {
  NS: 'TIMED', TBD: 'TIMED', FT: 'FINISHED', AET: 'FINISHED', PEN: 'FINISHED', AP: 'FINISHED',
  '1H': 'IN_PLAY', '2H': 'IN_PLAY', ET: 'IN_PLAY', P: 'IN_PLAY', BT: 'PAUSED', HT: 'PAUSED', LIVE: 'IN_PLAY',
  PST: 'POSTPONED', CANC: 'CANCELLED', ABD: 'CANCELLED', SUSP: 'SUSPENDED', INT: 'SUSPENDED', AWD: 'FINISHED', WO: 'FINISHED',
};
const utcOf = (ts, date, time) => {
  let raw = ts || (date && `${date}T${time || '00:00:00'}`);
  if (!raw) return null;
  raw = String(raw).trim().replace(' ', 'T');
  const d = new Date(/Z|[+-]\d\d:?\d\d$/.test(raw) ? raw : raw + 'Z');
  return isNaN(d) ? null : d.toISOString().replace('.000Z', 'Z');
};
const splitEvent = (s) => {
  const p = String(s || '').split(/\s+vs\.?\s+/i);
  return p.length === 2 ? p : [String(s || 'À déterminer'), ''];
};
const areaOf = (country) => {
  const c = countryMap[slug(country)];
  return c ? c : null;
};

// Compétitions internationales, reconnues à leur nom.
const INTL = [
  { re: /\buefa\b|\beuro\b|europa|conference league/i, fr: 'Europe', en: 'Europe', flag: 'EU' },
  { re: /conmebol|libertadores|sudamericana|copa am[eé]rica/i, fr: 'Amérique du Sud', en: 'South America', flag: 'INT' },
  { re: /concacaf|gold cup/i, fr: 'Amérique du Nord', en: 'North America', flag: 'INT' },
  { re: /\bcaf\b|africa cup|afcon|coupe d'afrique/i, fr: 'Afrique', en: 'Africa', flag: 'INT' },
  { re: /\bafc\b|asian/i, fr: 'Asie', en: 'Asia', flag: 'INT' },
  { re: /\bfifa\b|international|friendl|world cup|nations|olympic|qualif/i, fr: 'International', en: 'International', flag: 'INT' },
];

const competitions = {};
const matches = [];
const seen = new Set();

function addMatch(id, e) {
  if (seen.has(id)) return;
  const row = tvInfo[id];
  const idLeague = e && e.idLeague ? String(e.idLeague) : '';
  const big = BIG[idLeague];
  const tsdbCh = channelsByEvent[id] || {};
  if (!big && !Object.keys(tsdbCh).length) return; // petit championnat sans chaîne connue : on ne l'affiche pas
  const utc = e ? utcOf(e.strTimestamp, e.dateEvent, e.strTime) : utcOf(row && row.strTimeStamp, row && row.dateEvent, row && row.strTime);
  if (!utc) return;

  let comp = big;
  if (!comp) {
    comp = idLeague ? `L${idLeague}` : 'OTHER';
    if (!competitions[comp]) {
      const name = (e && e.strLeague) || 'Autres matchs';
      // Compétitions internationales : TheSportsDB y met le pays du premier match (ex. Turquie
      // pour la Ligue des nations), on affiche donc le drapeau européen ou le globe à la place.
      const intl = INTL.find((x) => x.re.test(name));
      const land = e ? e.strCountry : '';
      const a = !intl && land ? areaOf(land) : null;
      competitions[comp] = {
        name,
        area: intl ? intl.fr : a ? a.fr : land || '',
        areaEn: intl ? intl.en : a ? a.en : land || '',
        flag: intl ? intl.flag : a && a.code.length === 2 ? a.code : '',
        channels: {},
      };
    }
  }

  // Chaînes exactes du match ; pour les 6 grandes compétitions, on complète avec nos diffuseurs officiels.
  const channels = {};
  for (const [code, list] of Object.entries(tsdbCh)) channels[code] = [...list];
  if (big) {
    for (const [code, list] of Object.entries(rights.competitions[big].channels)) {
      if (!channels[code]) channels[code] = [...list];
    }
  }

  const [h, a] = e ? [e.strHomeTeam, e.strAwayTeam] : splitEvent(row && row.strEvent);
  matches.push({
    id: Number(id),
    utc,
    status: STATUS[String((e && e.strStatus) || 'NS').toUpperCase()] || 'TIMED',
    comp,
    home: h || 'À déterminer',
    away: a || 'À déterminer',
    channels,
  });
  seen.add(id);
}

for (const e of events) {
  if (e.strSport && e.strSport !== 'Soccer') continue;
  addMatch(String(e.idEvent), e);
}
for (const id of Object.keys(channelsByEvent)) addMatch(id, null); // diffusés mais absents de la liste du jour

// Ajouts manuels (data/manual.json) : chaînes par défaut d'une compétition, chaînes d'un match précis,
// et matchs absents de TheSportsDB (ex. éliminatoires CAN), saisis à la main.
let manual = {};
try { manual = JSON.parse(await readFile(new URL('data/manual.json', root), 'utf8')); } catch (e) { manual = {}; }
const pairKey = (h, a) => `${slug(h)}|${slug(a)}`;
for (const m of matches) {
  const lid = m.comp.startsWith('L') ? m.comp.slice(1) : '';
  const def = (manual.leagueChannels || {})[lid];
  if (def) for (const [code, list] of Object.entries(def)) if (!m.channels[code]) m.channels[code] = [...list];
  const ov = (manual.matchChannels || {})[pairKey(m.home, m.away)];
  if (ov) for (const [code, list] of Object.entries(ov)) m.channels[code] = [...list];
}
const nowMs = Date.now();
for (const x of manual.matches || []) {
  const t = Date.parse(x.utc);
  if (!(t > nowMs - 2 * 86400000 && t < nowMs + 7 * 86400000)) continue;
  if (matches.some((m) => pairKey(m.home, m.away) === pairKey(x.home, x.away) && Math.abs(Date.parse(m.utc) - t) < 6 * 3600000)) continue;
  if (!competitions[x.comp]) {
    const c = (manual.competitions || {})[x.comp];
    if (!c) continue;
    competitions[x.comp] = { name: c.name, area: c.area || '', areaEn: c.areaEn || c.area || '', flag: c.flag || '', channels: {} };
  }
  const status = nowMs > t + 2 * 3600000 ? 'FINISHED' : nowMs >= t ? 'IN_PLAY' : 'TIMED';
  matches.push({ id: Number(x.id), utc: x.utc, status, comp: x.comp, home: x.home, away: x.away, channels: x.channels });
}
for (const m of matches) {
  for (const code of Object.keys(m.channels)) {
    if (!usedCountries[code]) {
      const c = Object.values(countryMap).find((y) => y.code === code);
      if (c) usedCountries[code] = { fr: c.fr, en: c.en, region: c.region };
    }
  }
}

matches.sort((x, y) => x.utc.localeCompare(y.utc));

if (!matches.length) {
  console.error("Aucun match récupéré : public/matches-dev.json n'est pas modifié.");
  process.exit(1);
}

for (const code of BIG_ORDER) {
  const c = rights.competitions[code];
  competitions[code] = { name: c.name, area: c.area, channels: c.channels };
}
for (const c of Object.values(rights.competitions)) {
  for (const code of Object.keys(c.channels)) {
    if (!usedCountries[code]) {
      const m = Object.values(countryMap).find((x) => x.code === code);
      if (m) usedCountries[code] = { fr: m.fr, en: m.en, region: m.region };
    }
  }
}

const count = {};
matches.forEach((m) => { count[m.comp] = (count[m.comp] || 0) + 1; });
const others = Object.keys(competitions).filter((c) => !BIG_ORDER.includes(c) && count[c])
  .sort((x, y) => (x === 'OTHER') - (y === 'OTHER') || count[y] - count[x] || competitions[x].name.localeCompare(competitions[y].name));
for (const c of Object.keys(competitions)) if (!BIG_ORDER.includes(c) && !count[c]) delete competitions[c];

const out = {
  updatedAt: new Date().toISOString(),
  season: rights.season,
  credits: 'Matchs et chaînes : TheSportsDB.com. Diffuseurs officiels des grandes compétitions : data/rights.json.',
  order: [...BIG_ORDER, ...others],
  countries: usedCountries,
  competitions,
  matches,
};

await mkdir(new URL('public/', root), { recursive: true });
await writeFile(new URL('public/matches-dev.json', root), JSON.stringify(out));
const nbCh = matches.reduce((n, m) => n + Object.values(m.channels).reduce((k, l) => k + l.length, 0), 0);
console.log(`${matches.length} matchs, ${Object.keys(competitions).length} compétitions, ${nbCh} diffusions, ${Object.keys(usedCountries).length} pays -> public/matches-dev.json`);
if (unknownCountries.size) console.log('Pays à ajouter dans data/countries.json :', [...unknownCountries].join(', '));
