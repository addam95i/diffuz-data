# Diffuz – données

Ce dépôt alimente l'appli Diffuz.

- `data/rights.json` : diffuseurs officiels de chaque compétition, pays par pays (saison 2026-27). C'est le fichier à corriger quand une chaîne change.
- `scripts/build.mjs` : le robot. Il récupère les matchs sur football-data.org et écrit `public/matches.json`.
- `.github/workflows/update.yml` : lance le robot automatiquement toutes les 3 heures.
- `public/matches.json` : le fichier que l'appli télécharge.

## Réglage

Ajouter la clé football-data.org dans Settings → Secrets and variables → Actions → New repository secret, avec le nom `FOOTBALL_DATA_KEY`.

## Sources et licence des données

Matchs : football-data.org. Diffuseurs : uefa.com, presse sportive française et internationale, et Wikipédia (« List of Premier League overseas broadcasters », licence CC BY-SA 4.0). Le fichier `data/rights.json` est partagé sous la même licence CC BY-SA 4.0.
