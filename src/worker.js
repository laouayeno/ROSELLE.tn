/* ============================================================
   ROSELLE — Worker du site de vente (V2.24, limites et frais V2.29)

   Rôle : recevoir les commandes du site (POST /api/commande) et les
   enregistrer dans Firestore EN UNE SEULE OPÉRATION (transaction) :
     1. on relit le stock disponible de chaque article (publicCatalog) ;
     2. s'il en reste assez, on crée le colis ET on retire les pièces
        du stock affiché sur le site ;
     3. sinon on refuse avec la liste des articles épuisés.
   Deux clientes qui cliquent à la même seconde ne peuvent donc plus
   dépasser la limite, même la nuit quand le Stock est fermé.

   Toutes les autres adresses (pages, images, vidéo) ne passent pas par
   ce code : Cloudflare les sert directement depuis le dossier public/
   (voir "run_worker_first" dans wrangler.jsonc).

   V5.7 : le site n'utilise plus reCAPTCHA. Il lit toujours le stock en
   direct dans Firestore (lecture publique), mais il n'y ÉCRIT plus rien :
   commandes (/api/commande, protégées par Turnstile) et statistiques
   (/api/stats) passent toutes par ce Worker. /api/config donne la clé
   publique Turnstile.

   Clés secrètes, rangées dans Cloudflare (jamais dans ce code) :
     - FIREBASE_SA      : « clé de service » Firebase (fichier JSON) ;
     - TURNSTILE_SECRET : clé secrète Turnstile (sans elle, pas de contrôle) ;
     - TURNSTILE_SITE_KEY : clé publique Turnstile (donnée à la page).
   ============================================================ */

const PROJET = 'roselle-stock';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJET}/databases/(default)/documents`;
const NOM_DOC = (chemin) => `projects/${PROJET}/databases/(default)/documents/${chemin}`;

// Limites de bon sens, pour refuser les envois trafiqués ou démesurés.
const MAX_LIGNES = 30;
const MAX_QTE_PAR_LIGNE = 20;
const MAX_TEXTE = 500;
const ESSAIS_TRANSACTION = 5;
// V2.29 : frais de livraison si la page Apparence n'en indique pas (comme le site).
const FRAIS_PAR_DEFAUT = 8;

export default {
  async fetch(requete, env, ctx) {
    const url = new URL(requete.url);
    // V6.3 : photos des articles, servies depuis la mémoire de Cloudflare
    if (url.pathname.startsWith('/img/')) return servirPhoto(requete, url, ctx);
    if (url.pathname === '/api/commande') {
      if (requete.method !== 'POST') return json({ ok: false, erreur: 'methode' }, 405);
      return traiterCommande(requete, env);
    }
    // V5.7 : statistiques de visite (le site n'écrit plus directement dans Firestore).
    if (url.pathname === '/api/stats') {
      if (requete.method !== 'POST') return json({ ok: false, erreur: 'methode' }, 405);
      return traiterStats(requete, env);
    }
    // V5.7 : réglages publics utiles au site (clé PUBLIQUE Turnstile).
    if (url.pathname === '/api/config') {
      return json({ ok: true, turnstile: env.TURNSTILE_SITE_KEY || null });
    }
    // Toute autre adresse : le site lui-même (sécurité si la config change).
    if (env.ASSETS) return env.ASSETS.fetch(requete);
    return new Response('Introuvable', { status: 404 });
  }
};

/* ---------- Réception et vérification de la commande ---------- */
async function traiterCommande(requete, env) {
  if (!env.FIREBASE_SA) return json({ ok: false, erreur: 'non-configure' }, 503);

  // V2.29 : limite anti-robots, par connexion (adresse IP). Beaucoup de
  // clientes peuvent partager la même adresse chez un opérateur mobile :
  // la limite reste donc large (voir "ratelimits" dans wrangler.jsonc).
  // Sans la limite (configuration absente), on continue comme avant.
  if (env.LIMITE_COMMANDES) {
    const ip = requete.headers.get('CF-Connecting-IP') || 'inconnue';
    const { success } = await env.LIMITE_COMMANDES.limit({ key: 'ip:' + ip });
    if (!success) return json({ ok: false, erreur: 'trop-de-commandes' }, 429);
  }

  let corps;
  try {
    corps = await requete.json();
  } catch (e) {
    return json({ ok: false, erreur: 'invalide' }, 400);
  }
  const commande = verifierCommande(corps);
  if (!commande) return json({ ok: false, erreur: 'invalide' }, 400);

  // V2.29 : même numéro de téléphone = au plus quelques commandes par minute.
  if (env.LIMITE_TELEPHONE) {
    const { success } = await env.LIMITE_TELEPHONE.limit({ key: 'tel:' + commande.phone });
    if (!success) return json({ ok: false, erreur: 'trop-de-commandes' }, 429);
  }

  // V5.7 : Turnstile (anti-robot gratuit de Cloudflare). Tant que la clé
  // secrète TURNSTILE_SECRET n'est pas installée, on ne vérifie pas.
  if (env.TURNSTILE_SECRET) {
    const humain = await verifierTurnstile(corps.turnstile, env.TURNSTILE_SECRET, requete.headers.get('CF-Connecting-IP'));
    if (!humain) return json({ ok: false, erreur: 'turnstile' }, 403);
  }

  let compte;
  try {
    compte = JSON.parse(env.FIREBASE_SA);
  } catch (e) {
    console.error('FIREBASE_SA illisible');
    return json({ ok: false, erreur: 'non-configure' }, 503);
  }

  // Si la clé est refusée par Google (supprimée, désactivée, mauvais rôle),
  // on répond 503 : le site enregistre alors la commande comme avant,
  // au lieu de bloquer les ventes.
  let jeton;
  try {
    jeton = await jetonGoogle(compte);
  } catch (e) {
    console.error('Clé Google refusée :', e && e.message);
    return json({ ok: false, erreur: 'non-configure' }, 503);
  }
  try {
    const resultat = await enregistrerAvecTransaction(jeton, commande);
    if (!resultat.ok) return json(resultat, 409);
    return json({ ok: true, ref: commande.ref });
  } catch (e) {
    console.error('Erreur commande :', e && e.message);
    // Droits insuffisants sur Firestore (401/403) : même repli que sans clé.
    if (e && (e.code === 401 || e.code === 403)) return json({ ok: false, erreur: 'non-configure' }, 503);
    return json({ ok: false, erreur: 'serveur' }, 500);
  }
}

// Même format que celui exigé par les règles Firestore pour un colis du site,
// avec en plus des limites de taille. Renvoie la commande propre, ou null.
function verifierCommande(c) {
  if (!c || typeof c !== 'object') return null;
  const texte = (v, obligatoire) => {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    if (obligatoire && !t) return null;
    if (t.length > MAX_TEXTE) return null;
    return t;
  };
  const ref = texte(c.ref, true);
  const clientName = texte(c.clientName, true);
  const phone = texte(c.phone, true);
  const address = texte(c.address, true);
  const remark = texte(c.remark || '', false);
  if (ref === null || clientName === null || phone === null || address === null || remark === null) return null;
  if (!/^[0-9]{8}$/.test(phone)) return null;
  if (!/^WEB-[0-9]{6,20}$/.test(ref)) return null;
  if (typeof c.deliveryFee !== 'number' || !isFinite(c.deliveryFee) || c.deliveryFee < 0 || c.deliveryFee > 1000) return null;
  if (!Array.isArray(c.items) || c.items.length === 0 || c.items.length > MAX_LIGNES) return null;

  const items = [];
  for (const it of c.items) {
    if (!it || typeof it.productId !== 'string' || typeof it.variantId !== 'string') return null;
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(it.productId) || it.variantId.length === 0 || it.variantId.length > 100) return null;
    if (!Number.isInteger(it.qty) || it.qty < 1 || it.qty > MAX_QTE_PAR_LIGNE) return null;
    items.push({ productId: it.productId, variantId: it.variantId, qty: it.qty });
  }
  // V2.35 : gouvernorat choisi par la cliente (code de la société de livraison Bestway).
  // Facultatif : une page ouverte avant la mise à jour n'en envoie pas ; un code inconnu est ignoré.
  const gouvernorat = CODES_GOUVERNORAT.includes(c.gouvernorat) ? c.gouvernorat : '';
  return { ref, clientName, phone, address, remark, items, deliveryFee: c.deliveryFee, gouvernorat };
}

// Les 24 gouvernorats (mêmes codes que dans le Stock et sur le site).
const CODES_GOUVERNORAT = ['2080', '9000', '2013', '7000', '6000', '2100', '8100', '3100', '1200', '4200', '2010', '7100',
  '5100', '4100', '5000', '8000', '3000', '9100', '6100', '4000', '3200', '2200', '1000', '1100'];

/* ---------- Frais de livraison (V2.29) ---------- */
// Même règle que fraisLivraison() du site : siteSettings/main > shipping.fee
// s'il s'agit d'un nombre positif ou nul, sinon 8 DT.
function fraisLivraison(reglages) {
  const champs = reglages && reglages.fields ? reglages.fields : {};
  const livraison = depuisFirestore(champs.shipping || null);
  const n = livraison && livraison.fee !== undefined && livraison.fee !== null && livraison.fee !== '' ? Number(livraison.fee) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : FRAIS_PAR_DEFAUT;
}

/* ---------- Turnstile (V5.7) ---------- */
// Demande à Cloudflare si le jeton envoyé par la page est valable
// (une vraie personne, pas un robot). Chaque jeton ne sert qu'une fois.
async function verifierTurnstile(jetonPage, secret, ip) {
  if (typeof jetonPage !== 'string' || !jetonPage || jetonPage.length > 2048) return false;
  try {
    const corps = new FormData();
    corps.append('secret', secret);
    corps.append('response', jetonPage);
    if (ip) corps.append('remoteip', ip);
    const reponse = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: corps });
    const resultat = await reponse.json();
    return resultat && resultat.success === true;
  } catch (e) {
    console.error('Turnstile injoignable :', e && e.message);
    return false;
  }
}

/* ---------- Statistiques de visite (V5.7) ----------
   Avant, chaque visiteuse écrivait elle-même ses compteurs dans
   siteStats (il fallait donc App Check / reCAPTCHA). Maintenant la page
   envoie un petit « événement » ici, et c'est le Worker qui ajoute +1
   dans le bon tiroir du jour (même format qu'avant : le tableau de bord
   du Stock ne change pas). Les compteurs ne peuvent qu'augmenter de 1. */
const SOURCES = ['instagram', 'facebook', 'tiktok', 'google', 'whatsapp', 'direct', 'autre'];
const NB_TIROIRS = 50;

async function traiterStats(requete, env) {
  if (!env.FIREBASE_SA) return json({ ok: false, erreur: 'non-configure' }, 503);
  if (env.LIMITE_STATS) {
    const ip = requete.headers.get('CF-Connecting-IP') || 'inconnue';
    const { success } = await env.LIMITE_STATS.limit({ key: 'stats:' + ip });
    if (!success) return json({ ok: false, erreur: 'trop' }, 429);
  }
  let corps;
  try {
    corps = JSON.parse(await requete.text());
  } catch (e) {
    return json({ ok: false, erreur: 'invalide' }, 400);
  }
  const champs = champsStats(corps);
  if (!champs) return json({ ok: false, erreur: 'invalide' }, 400);
  const tiroir = Number.isInteger(corps.tiroir) && corps.tiroir >= 0 && corps.tiroir < NB_TIROIRS ? corps.tiroir : 0;
  const docId = jourTunisie() + '_' + String(tiroir).padStart(2, '0');
  try {
    const jeton = await jetonGoogle(JSON.parse(env.FIREBASE_SA));
    await appelFirestore(jeton, ':commit', {
      writes: [{
        update: { name: NOM_DOC('siteStats/' + docId), fields: {} },
        updateMask: { fieldPaths: [] },
        updateTransforms: champs.map(chemin => ({ fieldPath: chemin, increment: { integerValue: '1' } }))
      }]
    });
    return json({ ok: true });
  } catch (e) {
    console.error('Erreur stats :', e && e.message);
    return json({ ok: false, erreur: 'serveur' }, 500);
  }
}

// Transforme un événement envoyé par la page en liste de compteurs à
// augmenter. Tout ce qui ne correspond pas exactement est refusé (null).
function champsStats(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const idValide = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);
  const cle = id => '`' + id + '`'; // nom de champ « libre » (chiffres, tirets…)
  switch (ev.e) {
    case 'visite': {
      if (typeof ev.heure !== 'string' || !/^([01][0-9]|2[0-3])$/.test(ev.heure)) return null;
      const champs = ['sessions', 'hours.' + cle(ev.heure)];
      if (ev.nouveauJour === true) {
        champs.push('visitors');
        if (ev.nouvelleVisiteuse === true) champs.push('newVisitors');
        champs.push(ev.appareil === 'mobile' ? 'mobile' : 'desktop');
        champs.push('src.' + cle(SOURCES.includes(ev.source) ? ev.source : 'autre'));
      }
      return champs;
    }
    case 'vue': return idValide(ev.id) ? ['productViews.' + cle(ev.id)] : null;
    case 'panier': return idValide(ev.id) ? ['cartAdds.' + cle(ev.id)] : null;
    case 'panierSession': return ['cartSessions'];
    case 'commande': return ['checkouts'];
    default: return null;
  }
}

// Date du jour en Tunisie (AAAA-MM-JJ), comme le faisait le site.
function jourTunisie() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

/* ---------- V6.6 : commandes en cours d'un numéro de téléphone ----------
   Renvoie une Map « productId|variantId » -> pièces déjà commandées par ce
   numéro, dans les colis pas encore confirmés et pas annulés / retournés /
   en dépôt (mêmes règles que les réservations du Stock). Lu dans la
   transaction, pour que deux envois au même instant soient bien comptés. */
async function dejaCommandeParTelephone(jeton, transaction, telephone) {
  const resultat = new Map();
  if (!telephone) return resultat;
  const reponses = await appelFirestore(jeton, ':runQuery', {
    structuredQuery: {
      from: [{ collectionId: 'shipments' }],
      where: { fieldFilter: { field: { fieldPath: 'phone' }, op: 'EQUAL', value: { stringValue: telephone } } },
      limit: 100
    },
    transaction
  });
  for (const r of (Array.isArray(reponses) ? reponses : [])) {
    if (!r.document) continue;
    const colis = depuisFirestore({ mapValue: { fields: r.document.fields || {} } }) || {};
    if (colis.confirmed) continue;
    if (colis.status === 'returned' || colis.status === 'depot' || colis.status === 'cancelled') continue;
    for (const it of (Array.isArray(colis.items) ? colis.items : [])) {
      if (!it) continue;
      const cle = it.productId + '|' + it.variantId;
      resultat.set(cle, (resultat.get(cle) || 0) + (Number(it.qty) || 0));
    }
  }
  return resultat;
}

/* ---------- Transaction Firestore ---------- */
async function enregistrerAvecTransaction(jeton, commande) {
  // Quantités demandées, regroupées par article puis par variante.
  const parArticle = new Map();
  for (const it of commande.items) {
    if (!parArticle.has(it.productId)) parArticle.set(it.productId, new Map());
    const variantes = parArticle.get(it.productId);
    variantes.set(it.variantId, (variantes.get(it.variantId) || 0) + it.qty);
  }

  for (let essai = 1; essai <= ESSAIS_TRANSACTION; essai++) {
    const { transaction } = await appelFirestore(jeton, ':beginTransaction', {});

    // 1. Relire le stock affiché de chaque article, dans la transaction,
    //    ainsi que les réglages du site (frais de livraison, V2.29).
    const lecture = await appelFirestore(jeton, ':batchGet', {
      documents: [...parArticle.keys()].map(id => NOM_DOC('publicCatalog/' + id)).concat(NOM_DOC('siteSettings/main')),
      transaction
    });
    const fiches = new Map();
    let reglages = null;
    for (const r of lecture) {
      if (!r.found) continue;
      if (r.found.name === NOM_DOC('siteSettings/main')) reglages = r.found;
      else fiches.set(r.found.name.split('/').pop(), r.found);
    }

    // 1 bis (V6.6). Ce que CE numéro de téléphone a déjà commandé et qui
    //    n'est pas encore confirmé (ni annulé, retourné ou en dépôt) : la
    //    même cliente ne peut pas dépasser le stock réel en plusieurs fois.
    const dejaCommande = await dejaCommandeParTelephone(jeton, transaction, commande.phone);

    // 2. Vérifier qu'il en reste assez, et préparer les nouvelles quantités.
    const manquants = [];
    const ecritures = [];
    for (const [productId, demandes] of parArticle) {
      const fiche = fiches.get(productId);
      const variantes = fiche ? depuisFirestore({ arrayValue: (fiche.fields.variants || {}).arrayValue || {} }) : [];
      for (const [variantId, qte] of demandes) {
        const v = variantes.find(x => x && x.id === variantId);
        // V6.3 : « dispo » = disponible du site (avec la marge −1) ;
        // « reste » = ce qu'UNE commande peut prendre, jamais plus que le
        // stock réel (maxCommande, envoyé par le Stock V5.6).
        const dispo = v ? Math.max(0, Number(v.qty) || 0) : 0;
        const max = v ? Number(v.maxCommande) : NaN;
        const deja = dejaCommande.get(productId + '|' + variantId) || 0; // V6.6
        const reste = Number.isFinite(max) ? Math.min(dispo, Math.max(0, max - deja)) : dispo;
        if (qte > reste) manquants.push({ productId, variantId, reste });
        else v.qty = dispo - qte;
      }
      if (fiche) {
        ecritures.push({
          update: { name: fiche.name, fields: { variants: versFirestore(variantes) } },
          updateMask: { fieldPaths: ['variants'] },
          currentDocument: { exists: true }
        });
      }
    }
    if (manquants.length) {
      await appelFirestore(jeton, ':rollback', { transaction }).catch(() => {});
      return { ok: false, erreur: 'stock', manquants };
    }

    // 3. Créer le colis (même format qu'avant) dans la même transaction.
    const colis = {
      ref: commande.ref,
      courier: '',
      clientName: commande.clientName,
      phone: commande.phone,
      address: commande.address,
      remark: commande.remark,
      status: 'transit',
      confirmed: false,
      items: commande.items,
      // V2.29 : les frais viennent des réglages du site, pas du navigateur
      // de la cliente (qui pourrait envoyer 0).
      deliveryFee: fraisLivraison(reglages),
      date: new Date().toISOString()
    };
    if (commande.gouvernorat) colis.gouvernorat = commande.gouvernorat; // V2.35
    ecritures.push({
      update: { name: NOM_DOC('shipments/' + idAuto()), fields: versFirestore(colis).mapValue.fields },
      currentDocument: { exists: false }
    });

    try {
      await appelFirestore(jeton, ':commit', { writes: ecritures, transaction });
      return { ok: true };
    } catch (e) {
      // ABORTED = quelqu'un a modifié le même article au même moment : on recommence.
      if (e.code === 409 || e.code === 'ABORTED') {
        await attendre(50 * essai + Math.random() * 100);
        continue;
      }
      throw e;
    }
  }
  throw new Error('Transaction impossible après plusieurs essais');
}

async function appelFirestore(jeton, action, corps) {
  const reponse = await fetch(BASE + action, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + jeton, 'Content-Type': 'application/json' },
    body: JSON.stringify(corps)
  });
  const donnees = await reponse.json().catch(() => ({}));
  if (!reponse.ok) {
    const erreur = new Error('Firestore ' + action + ' : ' + reponse.status + ' ' + ((donnees.error && donnees.error.message) || ''));
    erreur.code = reponse.status;
    throw erreur;
  }
  return donnees;
}

/* ---------- Conversion JavaScript <-> format Firestore ---------- */
function versFirestore(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(versFirestore) } };
  const fields = {};
  for (const k of Object.keys(v)) fields[k] = versFirestore(v[k]);
  return { mapValue: { fields } };
}

function depuisFirestore(v) {
  if (!v) return null;
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(depuisFirestore);
  if ('mapValue' in v) {
    const objet = {};
    const champs = v.mapValue.fields || {};
    for (const k of Object.keys(champs)) objet[k] = depuisFirestore(champs[k]);
    return objet;
  }
  return null;
}

/* ---------- Connexion à Google avec la clé de service ---------- */
// Le jeton est valable 1 h : on le garde en mémoire ~50 min pour ne pas
// le redemander à chaque commande.
let jetonEnCache = null;

async function jetonGoogle(compte) {
  const maintenant = Math.floor(Date.now() / 1000);
  if (jetonEnCache && jetonEnCache.expire > maintenant + 60 && jetonEnCache.email === compte.client_email) {
    return jetonEnCache.valeur;
  }
  const entete = { alg: 'RS256', typ: 'JWT' };
  const contenu = {
    iss: compte.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: maintenant,
    exp: maintenant + 3600
  };
  const aSigner = base64url(JSON.stringify(entete)) + '.' + base64url(JSON.stringify(contenu));
  const cle = await crypto.subtle.importKey(
    'pkcs8',
    pemVersOctets(compte.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cle, new TextEncoder().encode(aSigner));
  const jwt = aSigner + '.' + base64url(new Uint8Array(signature));

  const reponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + jwt
  });
  const donnees = await reponse.json();
  if (!reponse.ok || !donnees.access_token) throw new Error('Connexion Google refusée : ' + reponse.status);
  jetonEnCache = { valeur: donnees.access_token, expire: maintenant + (donnees.expires_in || 3600) - 600, email: compte.client_email };
  return jetonEnCache.valeur;
}

function pemVersOctets(pem) {
  const b64 = String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const binaire = atob(b64);
  const octets = new Uint8Array(binaire.length);
  for (let i = 0; i < binaire.length; i++) octets[i] = binaire.charCodeAt(i);
  return octets.buffer;
}

function base64url(donnee) {
  const octets = typeof donnee === 'string' ? new TextEncoder().encode(donnee) : donnee;
  let binaire = '';
  for (const o of octets) binaire += String.fromCharCode(o);
  return btoa(binaire).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* ---------- Petits outils ---------- */
function idAuto() {
  const lettres = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const octets = crypto.getRandomValues(new Uint8Array(20));
  return Array.from(octets, o => lettres[o % lettres.length]).join('');
}

function attendre(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function json(objet, statut = 200) {
  return new Response(JSON.stringify(objet), {
    status: statut,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

/* ---------- V6.3 : relais des photos Cloudinary ----------
   Le site demande ses photos à /img/<réglage>/<fichier> au lieu de
   res.cloudinary.com. Ce Worker :
     1. vérifie que le réglage fait partie de ceux du site (personne ne peut
        s'en servir pour fabriquer des milliers de copies chez Cloudinary) ;
     2. cherche la photo dans la mémoire (cache) de Cloudflare ;
     3. sinon la demande UNE fois à Cloudinary et la garde 1 an.
   Résultat : Cloudinary n'envoie chaque photo qu'une fois par centre
   Cloudflare, au lieu d'une fois par visiteuse (trafic Cloudinary ≈ 0). */
const CLOUD_PHOTOS = 'vmmsu4z6';
// Exactement les réglages fabriqués par photoOptimisee() dans public/index.html
const REGLAGE_PHOTO_PERMIS = /^f_auto,q_auto:(good|best),(c_limit|c_lfill,ar_1:2\.8,g_center),w_(\d{3,4})$/;
// Fichier : numéro de version facultatif puis nom, sans « .. » ni caractères bizarres
const FICHIER_PHOTO_PERMIS = /^(v\d+\/)?[A-Za-z0-9_\-]+(\/[A-Za-z0-9_\-]+)*(\.(jpe?g|png|webp|gif|avif|heic))?$/i;

async function servirPhoto(requete, url, ctx) {
  if (requete.method !== 'GET' && requete.method !== 'HEAD') {
    return new Response('Méthode refusée', { status: 405 });
  }
  const reste = url.pathname.slice('/img/'.length);
  const coupure = reste.indexOf('/');
  const reglage = coupure > 0 ? reste.slice(0, coupure) : '';
  const fichier = coupure > 0 ? reste.slice(coupure + 1) : '';
  const verif = reglage.match(REGLAGE_PHOTO_PERMIS);
  const largeur = verif ? Number(verif[3]) : 0;
  // Largeurs du site : paliers de 200 px, de 200 à 2400
  if (!verif || largeur < 200 || largeur > 2400 || largeur % 200 !== 0 || !FICHIER_PHOTO_PERMIS.test(fichier)) {
    return new Response('Photo introuvable', { status: 404 });
  }

  // Format choisi selon le navigateur (comme f_auto) : AVIF, sinon WebP, sinon JPEG.
  // Le format fait partie de l'adresse gardée en mémoire : un vieux téléphone
  // ne reçoit jamais une photo AVIF qu'il ne sait pas lire.
  const accepte = requete.headers.get('Accept') || '';
  const format = accepte.includes('image/avif') ? 'f_avif' : accepte.includes('image/webp') ? 'f_webp' : 'f_jpg';
  const reglageFinal = reglage.replace('f_auto', format);
  const cle = new Request(`${url.origin}/img/${reglageFinal}/${fichier}`, { method: 'GET' });

  const cache = caches.default;
  const enMemoire = await cache.match(cle);
  if (enMemoire) return enMemoire;

  const origine = await fetch(`https://res.cloudinary.com/${CLOUD_PHOTOS}/image/upload/${reglageFinal}/${fichier}`);
  if (!origine.ok) {
    // Erreur Cloudinary : rien n'est gardé, le site rechargera la photo directement
    return new Response('Photo indisponible', { status: origine.status === 404 ? 404 : 502, headers: { 'Cache-Control': 'no-store' } });
  }
  const reponse = new Response(origine.body, {
    status: 200,
    headers: {
      'Content-Type': origine.headers.get('Content-Type') || 'image/jpeg',
      // Une adresse Cloudinary ne change jamais de contenu : 1 an dans le téléphone aussi
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Vary': 'Accept',
      'X-Content-Type-Options': 'nosniff'
    }
  });
  ctx.waitUntil(cache.put(cle, reponse.clone()));
  return reponse;
}
