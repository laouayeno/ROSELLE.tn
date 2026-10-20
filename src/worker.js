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

   Clé secrète : la « clé de service » Firebase (fichier JSON) est rangée
   dans Cloudflare sous le nom FIREBASE_SA. Elle n'est JAMAIS dans ce code.
   Sans elle, le Worker répond 503 et le site enregistre la commande
   comme avant (directement dans Firestore).
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
  async fetch(requete, env) {
    const url = new URL(requete.url);
    if (url.pathname === '/api/commande') {
      if (requete.method !== 'POST') return json({ ok: false, erreur: 'methode' }, 405);
      return traiterCommande(requete, env);
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
  return { ref, clientName, phone, address, remark, items, deliveryFee: c.deliveryFee };
}

/* ---------- Frais de livraison (V2.29) ---------- */
// Même règle que fraisLivraison() du site : siteSettings/main > shipping.fee
// s'il s'agit d'un nombre positif ou nul, sinon 8 DT.
function fraisLivraison(reglages) {
  const champs = reglages && reglages.fields ? reglages.fields : {};
  const livraison = depuisFirestore(champs.shipping || null);
  const n = livraison && livraison.fee !== undefined && livraison.fee !== null && livraison.fee !== '' ? Number(livraison.fee) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : FRAIS_PAR_DEFAUT;
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

    // 2. Vérifier qu'il en reste assez, et préparer les nouvelles quantités.
    const manquants = [];
    const ecritures = [];
    for (const [productId, demandes] of parArticle) {
      const fiche = fiches.get(productId);
      const variantes = fiche ? depuisFirestore({ arrayValue: (fiche.fields.variants || {}).arrayValue || {} }) : [];
      for (const [variantId, qte] of demandes) {
        const v = variantes.find(x => x && x.id === variantId);
        const reste = v ? Math.max(0, Number(v.qty) || 0) : 0;
        if (qte > reste) manquants.push({ productId, variantId, reste });
        else v.qty = reste - qte;
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
