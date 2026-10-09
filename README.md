# ROSELLE — site de vente

Site public : https://rosellestore.roselle-tn.workers.dev

- `public/` : les fichiers du site (`index.html`, `logo.jpg`, `hero.mp4`)
- `wrangler.jsonc` : configuration Cloudflare (nom du Worker : `rosellestore`)

Chaque modification poussée sur la branche `main` est redéployée automatiquement par Cloudflare (Workers Builds).
