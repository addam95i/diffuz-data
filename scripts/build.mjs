// Robot Diffuz : récupère les matchs des prochains jours sur football-data.org,
// y associe les diffuseurs de data/rights.json et écrit public/matches.json,
// le fichier que l'appli télécharge à chaque ouverture.
//
// Lancement : FOOTBALL_DATA_KEY=xxx node scripts/build.mjs
// Test hors ligne : DIFFUZ_SAMPLE=chemin/vers/reponse.json node scripts/build.mjs

import { mkdir, readFile, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const rights = JSON.parse(await readFile(new URL('data/rights.json', root), 'utf8'));
const codes = Object.keys(rights.competitions);

const isoDay = (d) => d.toISOString().slice(0, 10);
const now = new Date();
const from = new Date(now.getTime() - 1 * 86400000);
const to = new Date(now.getTime() + 5 * 86400000);

let data;
if (process.env.DIFFUZ_SAMPLE) {
  data = JSON.parse(await readFile(process.env.DIFFUZ_SAMPLE, 'utf8'));
} else {
  const key = process.env.FOOTBALL_DATA_KEY;
  if (!key) {
    console.error('Clé FOOTBALL_DATA_KEY manquante (à ajouter dans les secrets GitHub).');
    process.exit(1);
  }
  const url = `https://api.football-data.org/v4/matches?competitions=${codes.join(',')}&dateFrom=${isoDay(from)}&dateTo=${isoDay(to)}`;
  const res = await fetch(url, { headers: { 'X-Auth-Token': key } });
  if (!res.ok) {
    console.error(`football-data.org a répondu ${res.status} : ${await res.text()}`);
    process.exit(1);
  }
  data = await res.json();
}

const teamName = (t) => (t && (t.shortName || t.name)) || 'À déterminer';
const matches = (data.matches || [])
  .filter((m) => m.competition && rights.competitions[m.competition.code] && m.utcDate)
  .map((m) => ({
    id: m.id,
    utc: m.utcDate,
    status: m.status,
    comp: m.competition.code,
    home: teamName(m.homeTeam),
    away: teamName(m.awayTeam),
  }))
  .sort((a, b) => a.utc.localeCompare(b.utc));

const competitions = {};
for (const [code, c] of Object.entries(rights.competitions)) {
  competitions[code] = { name: c.name, area: c.area, channels: c.channels };
}

const out = {
  updatedAt: new Date().toISOString(),
  season: rights.season,
  credits: 'Matchs : football-data.org. Diffuseurs officiels par pays : data/rights.json (sources citées dans le fichier).',
  order: ['CL', 'FL1', 'PL', 'PD', 'SA', 'BL1'],
  competitions,
  matches,
};

await mkdir(new URL('public/', root), { recursive: true });
await writeFile(new URL('public/matches.json', root), JSON.stringify(out));
console.log(`${matches.length} matchs écrits dans public/matches.json`);
