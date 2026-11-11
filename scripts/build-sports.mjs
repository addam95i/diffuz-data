// Robot Diffuz (version Dev) : autres sports que le foot (basket, MMA et boxe).
// Récupère sur TheSportsDB les événements télévisés des prochains jours, avec les chaînes
// pays par pays, et écrit public/sports-dev.json (lu seulement par l'appli Diffuz Dev).
//
// Lancement : THESPORTSDB_KEY=xxx node scripts/build-sports.mjs
// Test hors ligne : DIFFUZ_TSDB_SAMPLE=dossier node scripts/build-sports.mjs
//   (le dossier contient, pour chaque sport, <Sport>-events.json et <Sport>-tv.json)

import { mkdir, readFile, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const countryMap = JSON.parse(await readFile(new URL('data/countries.json', root), 'utf8')).countries;

// Sports suivis : nom chez TheSportsDB → identifiant dans l'appli.
// « Fighting » regroupe chez TheSportsDB le MMA (UFC, PFL…) et la boxe.
const SPORTS = { Basketball: 'basketball', Fighting: 'fighting' };
// Dans « Fighting », TheSportsDB range aussi le sumo et le catch : on ne garde que MMA et boxe.
const NOT_FIGHTING = /sumo|wwe|aew|wrestl|njpw|tna|impact|ring of honor/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s) => String(s || '').trim().toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const isoDay = (d) => d.toISOString().slice(0, 10);
const now = new Date();
const dates = [-1, 0, 1, 2, 3, 4, 5].map((o) => isoDay(new Date(now.getTime() + o * 86400000)));

async function get(path) {
  const url = `https://www.thesportsdb.com/api/v1/json/${process.env.THESPORTSDB_KEY}/${path}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url);
    if (res.status === 429) { console.log("Trop de requêtes, pause d'une minute..."); await sleep(61000); continue; }
    if (!res.ok) throw new Error(`TheSportsDB a répondu ${res.status} pour ${path.split('?')[0]}`);
    const text = await res.text();
    try { return JSON.parse(text); } catch (e) { throw new Error(`Réponse illisible pour ${path.split('?')[0]} : ${text.slice(0, 120)}`); }
  }
  throw new Error('TheSportsDB refuse les requêtes (limite atteinte).');
}

async function fetchSport(name) {
  if (process.env.DIFFUZ_TSDB_SAMPLE) {
    const dir = process.env.DIFFUZ_TSDB_SAMPLE.replace(/\/?$/, '/');
    const read = async (f) => { try { return JSON.parse(await readFile(dir + f, 'utf8')); } catch (e) { return []; } };
    return { events: await read(`${name}-events.json`), tv: await read(`${name}-tv.json`) };
  }
  const events = [];
  const tv = [];
  const q = encodeURIComponent(name);
  for (const d of dates) {
    const ev = (await get(`eventsday.php?d=${d}&s=${q}`)).events || [];
    await sleep(800);
    const t = (await get(`eventstv.php?d=${d}&s=${q}`)).tvevents || [];
    await sleep(800);
    console.log(`${name} ${d} : ${ev.length} événements, ${t.length} diffusions`);
    events.push(...ev);
    tv.push(...t);
  }
  return { events, tv };
}

if (!process.env.DIFFUZ_TSDB_SAMPLE && !process.env.THESPORTSDB_KEY) {
  console.error('Clé THESPORTSDB_KEY manquante (à ajouter dans les secrets GitHub).');
  process.exit(1);
}

const STATUS = {
  NS: 'TIMED', TBD: 'TIMED', FT: 'FINISHED', AOT: 'FINISHED', AET: 'FINISHED', 'MATCH FINISHED': 'FINISHED',
  Q1: 'IN_PLAY', Q2: 'IN_PLAY', Q3: 'IN_PLAY', Q4: 'IN_PLAY', OT: 'IN_PLAY', HT: 'PAUSED', BT: 'PAUSED', LIVE: 'IN_PLAY',
  PST: 'POSTPONED', CANC: 'CANCELLED', ABD: 'CANCELLED', SUSP: 'SUSPENDED',
};
const utcOf = (ts, date, time) => {
  let raw = ts || (date && `${date}T${time || '00:00:00'}`);
  if (!raw) return null;
  raw = String(raw).trim().replace(' ', 'T');
  const d = new Date(/Z|[+-]\d\d:?\d\d$/.test(raw) ? raw : raw + 'Z');
  return isNaN(d) ? null : d.toISOString().replace('.000Z', 'Z');
};
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

const unknownCountries = new Set();
const usedCountries = {};
const competitions = {};
const matches = [];
const seen = new Set();

for (const [name, sport] of Object.entries(SPORTS)) {
  let got;
  try { got = await fetchSport(name); } catch (e) { console.error(`${name} : ${e.message}`); continue; }
  const { events, tv } = got;

  // Chaînes par événement : { idEvent: { pays: [chaînes] } }
  const channelsByEvent = {};
  const tvInfo = {};
  for (const row of tv) {
    if (row.strSport && row.strSport !== name) continue;
    const id = String(row.idEvent || '');
    const ch = clean(row.strChannel);
    if (!id || !ch) continue;
    let c = countryMap[slug(row.strCountry) || 'international'];
    if (!c) { unknownCountries.add(row.strCountry); c = countryMap.international; }
    usedCountries[c.code] = { fr: c.fr, en: c.en, region: c.region };
    const byC = (channelsByEvent[id] = channelsByEvent[id] || {});
    const list = (byC[c.code] = byC[c.code] || []);
    if (!list.includes(ch)) list.push(ch);
    if (!tvInfo[id]) tvInfo[id] = row;
  }

  const byId = {};
  for (const e of events) if (!e.strSport || e.strSport === name) byId[String(e.idEvent)] = e;

  // On ne garde que les événements qui ont au moins une chaîne connue.
  for (const id of Object.keys(channelsByEvent)) {
    if (seen.has(id)) continue;
    const e = byId[id];
    const row = tvInfo[id];
    const utc = e ? utcOf(e.strTimestamp, e.dateEvent, e.strTime) : utcOf(row.strTimeStamp, row.dateEvent, row.strTime);
    if (!utc) continue;

    const idLeague = String((e && e.idLeague) || (row && row.idLeague) || '');
    const leagueName = clean((e && e.strLeague) || (row && row.strLeague));
    if (sport === 'fighting' && NOT_FIGHTING.test(leagueName)) continue;
    const comp = idLeague ? `${sport === 'basketball' ? 'B' : 'F'}${idLeague}` : `${sport}-other`;
    if (!competitions[comp]) {
      const land = e ? e.strCountry : '';
      const a = land ? countryMap[slug(land)] : null;
      competitions[comp] = {
        name: clean((e && e.strLeague) || (row && row.strLeague)) || (sport === 'basketball' ? 'Basket' : 'Combats'),
        area: a ? a.fr : land || '',
        areaEn: a ? a.en : land || '',
        flag: a && a.code.length === 2 ? a.code : '',
        sport,
        channels: {},
      };
    }

    const title = clean((e && e.strEvent) || (row && row.strEvent));
    let home = clean(e && e.strHomeTeam);
    let away = clean(e && e.strAwayTeam);
    if (!home && !away && sport === 'basketball') {
      const p = title.split(/\s+vs\.?\s+/i);
      if (p.length === 2) [home, away] = p;
    }
    const m = {
      id: Number(id),
      sport,
      utc,
      status: STATUS[String((e && e.strStatus) || 'NS').toUpperCase()] || 'TIMED',
      comp,
      home: home || title || 'À déterminer',
      away: home ? away : '',
      channels: channelsByEvent[id],
    };
    // Combats : le nom de la soirée (« UFC 322 : X vs Y ») sert de titre.
    if (sport === 'fighting' && title) m.title = title;
    matches.push(m);
    seen.add(id);
  }
}

matches.sort((x, y) => x.utc.localeCompare(y.utc));

if (!matches.length) {
  console.error('Aucun événement récupéré : public/sports-dev.json n\'est pas modifié.');
  process.exit(1);
}

const count = {};
matches.forEach((m) => { count[m.comp] = (count[m.comp] || 0) + 1; });
// Les grandes ligues d'abord (NBA, EuroLigue, UFC), puis les autres par nombre d'événements.
const PRIORITY = ['B4387', 'B4546', 'F4443'];
const rank = (c) => (PRIORITY.includes(c) ? PRIORITY.indexOf(c) : 99);
const order = Object.keys(competitions).filter((c) => count[c])
  .sort((x, y) => rank(x) - rank(y) || count[y] - count[x] || competitions[x].name.localeCompare(competitions[y].name));

const out = {
  updatedAt: new Date().toISOString(),
  credits: 'Événements et chaînes : TheSportsDB.com.',
  sports: Object.values(SPORTS),
  order,
  countries: usedCountries,
  competitions,
  matches,
};

await mkdir(new URL('public/', root), { recursive: true });
await writeFile(new URL('public/sports-dev.json', root), JSON.stringify(out));
const per = {};
matches.forEach((m) => { per[m.sport] = (per[m.sport] || 0) + 1; });
const nbCh = matches.reduce((n, m) => n + Object.values(m.channels).reduce((k, l) => k + l.length, 0), 0);
console.log(`${Object.entries(per).map(([k, v]) => `${k} ${v}`).join(', ')} | ${order.length} compétitions, ${nbCh} diffusions, ${Object.keys(usedCountries).length} pays -> public/sports-dev.json`);
if (unknownCountries.size) console.log('Pays à ajouter dans data/countries.json :', [...unknownCountries].join(', '));
