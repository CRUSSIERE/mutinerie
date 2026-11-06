'use strict';
// Mutinerie — serveur de jeu en ligne. Zéro dépendance : Node >= 18.
// Le serveur détient toute la partie ; chaque joueur ne reçoit que sa propre main.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- Moteur ----------
// Les effets sont fixes ; un thème ne fait que nommer les 10 rôles. Dans txt, {k} = nom du rôle k dans le thème.
const ROLES = {
  0: { n: 2, txt: "Aucun effet. En fin de manche, si tu es le seul joueur encore en lice à avoir joué ou défaussé une carte {0}, tu gagnes un doublon." },
  1: { n: 6, txt: "Accuse un autre joueur : nomme un rôle (sauf {1}). S'il l'a en main, il quitte la manche." },
  2: { n: 2, txt: "Regarde en secret la carte d'un autre joueur." },
  3: { n: 2, txt: "Duel avec un autre joueur : comparez vos cartes en secret. La plus faible quitte la manche. Égalité : rien." },
  4: { n: 2, txt: "Personne ne peut te cibler jusqu'à ton prochain tour." },
  5: { n: 2, txt: "Un joueur (toi compris) défausse sa carte sans effet et en pioche une nouvelle." },
  6: { n: 2, txt: "Pioche 2 cartes, garde-en une parmi les 3 et glisse les 2 autres sous la pioche dans l'ordre de ton choix." },
  7: { n: 1, txt: "Échange ta carte avec celle d'un autre joueur." },
  8: { n: 1, txt: "Aucun effet. Si tu l'as en main avec la carte {7} ou {5}, tu dois la jouer." },
  9: { n: 1, txt: "Si tu défausses cette carte, pour quelque raison que ce soit, tu quittes la manche." },
};
const TOTAL_CARDS = Object.values(ROLES).reduce((s, r) => s + r.n, 0);
const GUESSABLE = [0, 2, 3, 4, 5, 6, 7, 8, 9];
const TARGETED = [1, 2, 3, 5, 7];
const MAX_PLAYERS = 6;
// La carte 8 est obligatoire si elle accompagne la 7 ou une 5.
const mustPlaySirene = hand => hand.includes(8) && (hand.includes(5) || hand.includes(7));

// ---------- Thèmes ----------
const DEFAULT_ID = 'pirate';
const defaultTheme = () => ({ id: DEFAULT_ID, label: 'Pirates', imgs: Array(10).fill(null),
  names: ['Rat de cale', 'Moussaillon', 'Vigie', 'Bretteur', 'Cuistot', 'Canonnier', 'Cartographe', 'Second', 'Sirène', 'Trésor'] });
// Thèmes et illustrations : Supabase si SUPABASE_URL et SUPABASE_SECRET_KEY sont définis, sinon fichiers locaux.
const THEMES_FILE = process.env.THEMES_FILE || path.join(__dirname, 'themes.json');
const IMG_DIR = path.join(path.dirname(THEMES_FILE), 'illustrations');
const MAX_THEMES = 50, MAX_IMG = 400 * 1024;
const IMG_TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
let themes = [defaultTheme()];

const fileStore = {
  async loadAll() {
    try { return JSON.parse(fs.readFileSync(THEMES_FILE, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') console.error(`Thèmes illisibles (${THEMES_FILE}) :`, e.message); return []; }
  },
  async save(t, next) { fileStore.write(next); },
  async remove(id, next) { fileStore.write(next); },
  write(list) {
    const tmp = THEMES_FILE + '.tmp';     // écriture puis renommage : jamais de fichier à moitié écrit
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
    fs.renameSync(tmp, THEMES_FILE);
  },
  file: (id, v, img) => path.join(IMG_DIR, `${id}-${v}.${img.split(':')[0]}`),
  async putImg(id, v, img, buf) { fs.mkdirSync(IMG_DIR, { recursive: true }); fs.writeFileSync(fileStore.file(id, v, img), buf); },
  async delImg(id, v, img) { try { fs.unlinkSync(fileStore.file(id, v, img)); } catch (e) { if (e.code !== 'ENOENT') throw e; } },
  url: (id, v, img) => `/img/${id}/${v}?v=${img.split(':')[1]}`,
};

// Table public.mutinerie_themes (RLS active, aucune policy : seule la clé secrète du serveur y accède)
// et bucket public "mutinerie". Zéro dépendance : appels REST directs.
const SUPA = (process.env.SUPABASE_URL || '').replace(/\/+$/, ''), SUPA_KEY = process.env.SUPABASE_SECRET_KEY || '';
const supaStore = {
  async call(p, opt = {}) {
    const headers = { apikey: SUPA_KEY, ...opt.headers };
    if (SUPA_KEY.startsWith('eyJ')) headers.Authorization = `Bearer ${SUPA_KEY}`;   // ancienne clé service_role (JWT)
    let r;
    try { r = await fetch(SUPA + p, { ...opt, headers }); }
    catch (e) { console.error('Supabase injoignable :', e.message); throw 'Stockage indisponible, réessaie dans un instant.'; }
    if (!r.ok) {
      console.error(`Supabase ${opt.method || 'GET'} ${p} → ${r.status}`, await r.text().catch(() => ''));
      throw "Le stockage a refusé l'opération.";
    }
    return r;
  },
  async loadAll() { return (await supaStore.call('/rest/v1/mutinerie_themes?select=id,label,names,imgs&order=created_at')).json(); },
  async save(t) {
    await supaStore.call('/rest/v1/mutinerie_themes', { method: 'POST',
      body: JSON.stringify([{ id: t.id, label: t.label, names: t.names, imgs: t.imgs }]),
      headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' } });
  },
  async remove(id) { await supaStore.call(`/rest/v1/mutinerie_themes?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' }); },
  // Un chemin par version : jamais d'ancienne image servie depuis un cache.
  obj: (id, v, img) => { const [ext, ver] = img.split(':'); return `mutinerie/${id}/${v}-${ver}.${ext}`; },
  async putImg(id, v, img, buf) {
    await supaStore.call(`/storage/v1/object/${supaStore.obj(id, v, img)}`, { method: 'POST', body: buf,
      headers: { 'Content-Type': IMG_TYPES[img.split(':')[0]], 'x-upsert': 'true', 'cache-control': '31536000' } });
  },
  async delImg(id, v, img) {
    try { await supaStore.call(`/storage/v1/object/${supaStore.obj(id, v, img)}`, { method: 'DELETE' }); }
    catch (e) { console.error('Image orpheline laissée dans le bucket :', supaStore.obj(id, v, img)); }   // pas bloquant : le thème reste cohérent
  },
  url: (id, v, img) => `${SUPA}/storage/v1/object/public/${supaStore.obj(id, v, img)}`,
};
const store = SUPA && SUPA_KEY ? supaStore : fileStore;

// Vérifie un thème venu de l'admin ou du stockage ; renvoie { label, names } propres, ou lève un message.
function cleanTheme(t) {
  const label = String(t?.label ?? '').replace(/\s+/g, ' ').trim();
  if (!label || label.length > 30) throw 'Le nom du thème doit faire de 1 à 30 caractères.';
  if (!Array.isArray(t.names) || t.names.length !== 10) throw 'Il faut exactement 10 noms de personnages.';
  const names = t.names.map(n => String(n ?? '').replace(/\s+/g, ' ').trim());
  if (names.some(n => !n || n.length > 24)) throw 'Chaque personnage doit avoir un nom de 1 à 24 caractères.';
  if (new Set(names.map(n => n.toLowerCase())).size !== 10) throw 'Deux personnages ne peuvent pas porter le même nom.';
  return { label, names };
}
// imgs[v] = "ext:version" (ex. "webp:1731000000000") ou null.
const cleanImgs = a => Array.from({ length: 10 }, (_, v) => {
  const x = Array.isArray(a) ? a[v] : null;
  return typeof x === 'string' && /^(png|jpg|webp):\d{1,15}$/.test(x) ? x : null;
});
async function loadThemes() {
  let saved = [];
  try { saved = await store.loadAll(); } catch (e) { console.error('Thèmes non chargés, thème de base seulement :', e); }
  themes = [];
  for (const t of Array.isArray(saved) ? saved : []) {
    try {
      if (/^[a-z0-9-]{1,40}$/.test(t.id) && !themes.some(x => x.id === t.id))
        themes.push({ id: t.id, ...cleanTheme(t), imgs: cleanImgs(t.imgs) });
    } catch (e) { console.error(`Thème ignoré (${t && t.id}) :`, e); }
  }
  if (!themes.some(t => t.id === DEFAULT_ID)) themes.unshift(defaultTheme());
}
function findTheme(id) {
  const t = themes.find(x => x.id === id);
  if (!t) throw 'Thème introuvable.';
  return t;
}
// La mémoire ne change qu'après une sauvegarde réussie : jamais de thème affiché mais perdu.
async function commit(t) {
  const next = themes.some(x => x.id === t.id) ? themes.map(x => x.id === t.id ? t : x) : [...themes, t];
  await store.save(t, next);
  themes = next;
}
// Sans id : crée un thème. Avec id : renomme les personnages d'un thème existant.
async function upsertTheme(input) {
  const clean = cleanTheme(input);
  if (input.id) { const t = findTheme(input.id); await commit({ ...t, ...clean }); return t.id; }
  if (themes.length >= MAX_THEMES) throw `Pas plus de ${MAX_THEMES} thèmes.`;
  const base = clean.label.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'theme';
  let id = base, k = 2;
  while (themes.some(x => x.id === id)) id = `${base}-${k++}`;
  await commit({ id, ...clean, imgs: Array(10).fill(null) });
  return id;
}
async function deleteTheme(id) {
  const t = findTheme(id);
  if (t.id === DEFAULT_ID) throw 'Le thème de base ne se supprime pas.';
  const next = themes.filter(x => x !== t);
  await store.remove(id, next);
  themes = next;
  for (let v = 0; v < 10; v++) if (t.imgs[v]) await store.delImg(t.id, v, t.imgs[v]);
}
// dataUrl null = retirer l'illustration. Le type est vérifié sur les octets, pas sur ce que dit le navigateur.
async function setImage(id, v, dataUrl) {
  const t = findTheme(id);
  if (!Number.isInteger(v) || v < 0 || v > 9) throw 'Carte inconnue.';
  const old = t.imgs[v], imgs = [...t.imgs];
  if (dataUrl == null) imgs[v] = null;
  else {
    const m = /^data:image\/[a-z+]+;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
    if (!m) throw 'Image illisible.';
    const buf = Buffer.from(m[1], 'base64');
    if (buf.length > MAX_IMG) throw `Image trop lourde (max ${MAX_IMG / 1024} Ko).`;
    const ext = buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG' ? 'png'
      : buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff ? 'jpg'
      : buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP' ? 'webp' : null;
    if (!ext) throw 'Formats acceptés : PNG, JPEG ou WebP.';
    imgs[v] = `${ext}:${Date.now()}`;
    // En local, un fichier par carte et par format : retirer l'ancien s'il a une autre extension.
    if (old && store === fileStore && old.split(':')[0] !== ext) await store.delImg(t.id, v, old);
    await store.putImg(t.id, v, imgs[v], buf);
  }
  await commit({ ...t, imgs });
  // Supabase : un objet par version, l'ancien n'est plus référencé. Local : fichier retiré si plus d'image.
  if (old && (store === supaStore || dataUrl == null)) await store.delImg(t.id, v, old);
}
function themeOf(G) { return themes.find(t => t.id === G.theme) || themes.find(t => t.id === DEFAULT_ID); }
function rolesOf(theme) {
  return Object.keys(ROLES).map(v => ({ n: ROLES[v].n, name: theme.names[v],
    txt: ROLES[v].txt.replace(/\{(\d)\}/g, (_, k) => theme.names[k]),
    img: theme.imgs[v] ? store.url(theme.id, +v, theme.imgs[v]) : null }));
}
const themeList = () => themes.map(t => ({ id: t.id, label: t.label, roles: rolesOf(t) }));
const N = (G, v) => themeOf(G).names[v];
const R = (G, v) => `${N(G, v)} (${v})`;

function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function buildDeck() { const d = []; for (const v in ROLES) for (let i = 0; i < ROLES[v].n; i++) d.push(+v); return shuffle(d); }
function log(G, t, k = '') { G.log.unshift({ t, k }); G.log.length = Math.min(G.log.length, 80); }
function whisper(p, t) { p.inbox.unshift(t); p.inbox.length = Math.min(p.inbox.length, 6); }
function alive(G) { return G.players.filter(p => !p.out); }

function newGame() { return { theme: DEFAULT_ID, players: [], phase: 'lobby', goal: 0, starter: 0, round: 0, log: [], cur: 0 }; }
function addPlayer(G, name) {
  const p = { name, token: crypto.randomUUID(), tokens: 0, hand: [], discard: [], out: false, prot: false, inbox: [] };
  G.players.push(p);
  return p;
}
function startGame(G) {
  const n = G.players.length;
  G.goal = n === 2 ? 6 : n === 3 ? 5 : n === 4 ? 4 : 3;
  G.players.forEach(p => { p.tokens = 0; });
  G.round = 0; G.starter = 0; G.log = [];
  newRound(G);
}
function newRound(G) {
  G.round++;
  G.deck = buildDeck();                      // dessus de la pioche = dernier élément
  G.aside = G.deck.pop();
  G.faceUp = G.players.length === 2 ? [G.deck.pop(), G.deck.pop(), G.deck.pop()] : [];
  for (const p of G.players) { p.hand = [G.deck.pop()]; p.discard = []; p.out = false; p.prot = false; p.inbox = []; }
  G.cur = G.starter; G.result = null;
  log(G, `Manche ${G.round}`, 'round');
  startTurn(G);
}
function startTurn(G) {
  const p = G.players[G.cur];
  p.prot = false;
  p.hand.push(G.deck.pop());
  G.phase = 'play';
}
// Seule la carte 5 peut te cibler toi-même.
function validTargets(G, v) {
  return G.players.map((_, i) => i).filter(i => {
    const q = G.players[i];
    if (q.out) return false;
    if (i === G.cur) return v === 5;
    return !q.prot;
  });
}
function targetsNeeded(G, v) {
  return TARGETED.includes(v) && validTargets(G, v).length ? 1 : 0;
}
function eliminate(G, p, why) {
  if (p.out) return;
  p.out = true;
  while (p.hand.length) p.discard.push(p.hand.pop());
  log(G, `${p.name} quitte la manche (${why}).`, 'out');
}
function refill(G, p) {
  if (G.deck.length) p.hand.push(G.deck.pop());
  else if (G.aside != null) { p.hand.push(G.aside); G.aside = null; }
}
function play(G, idx, a = {}) {
  const p = G.players[G.cur], v = p.hand.splice(idx, 1)[0];
  p.discard.push(v);
  const T = i => G.players[i], head = `${p.name} joue ${R(G, v)}`;
  let carto = false;
  if (TARGETED.includes(v) && a.t1 == null) {
    log(G, `${head}, sans effet.`);
  } else switch (v) {
    case 0: case 8:
      log(G, `${head}.`);
      break;
    case 1: { const t = T(a.t1);
      log(G, `${head} et accuse ${t.name} d'être ${R(G, a.guess)}.`);
      if (t.hand[0] === a.guess) eliminate(G, t, 'accusation juste'); else log(G, 'Accusation fausse.');
      break; }
    case 2: { const t = T(a.t1);
      log(G, `${head} et observe ${t.name}.`);
      whisper(p, `${N(G, 2)} : ${t.name} a ${R(G, t.hand[0])}.`);
      whisper(t, `${p.name} a regardé ta carte (${N(G, 2)}).`);
      break; }
    case 3: { const t = T(a.t1), mine = p.hand[0], his = t.hand[0];
      log(G, `${head} et provoque ${t.name} en duel.`);
      whisper(p, `Duel — toi : ${R(G, mine)} · ${t.name} : ${R(G, his)}.`);
      whisper(t, `Duel lancé par ${p.name}, qui avait ${R(G, mine)}.`);
      if (mine < his) eliminate(G, p, 'duel perdu');
      else if (his < mine) eliminate(G, t, 'duel perdu');
      else log(G, 'Égalité, personne ne tombe.');
      break; }
    case 4:
      p.prot = true;
      log(G, `${head} : ${p.name} est à l'abri jusqu'à son prochain tour.`);
      break;
    case 5: { const t = T(a.t1);
      log(G, `${head} et vise ${t.name}.`);
      const d = t.hand.pop(); t.discard.push(d);
      log(G, `${t.name} défausse ${R(G, d)}.`);
      if (d === 9) eliminate(G, t, `carte ${N(G, 9)} défaussée`);
      else { refill(G, t); if (t !== p) whisper(t, `${p.name} t'a fait défausser et repiocher (${N(G, 5)}).`); }
      break; }
    case 6: {
      const k = Math.min(2, G.deck.length);
      if (!k) { log(G, `${head}, sans effet (pioche vide).`); break; }
      for (let j = 0; j < k; j++) p.hand.push(G.deck.pop());
      log(G, `${head} et pioche ${k} carte${k > 1 ? 's' : ''}.`);
      carto = true;
      break; }
    case 7: { const t = T(a.t1);
      [p.hand, t.hand] = [t.hand, p.hand];
      log(G, `${head} et échange sa carte avec ${t.name}.`);
      whisper(t, `${p.name} a échangé sa carte avec la tienne (${N(G, 7)}).`);
      break; }
    case 9:
      log(G, `${head}.`);
      eliminate(G, p, `carte ${N(G, 9)} défaussée`);
      break;
  }
  if (carto) G.phase = 'carto'; else endTurn(G);
}
// Cartographe : garde la carte n° keep ; les autres vont sous la pioche, la première listée au-dessus de la seconde.
function cartoChoice(G, keep, flip) {
  const p = G.players[G.cur], rest = p.hand.filter((_, i) => i !== keep);
  if (flip) rest.reverse();
  p.hand = [p.hand[keep]];
  G.deck.unshift(...[...rest].reverse());   // deck[0] = fond de la pioche
  log(G, `${p.name} glisse ${rest.length} carte${rest.length > 1 ? 's' : ''} sous la pioche.`);
  endTurn(G);
}
function endTurn(G) {
  const al = alive(G);
  if (al.length === 1) return endRound(G, al, `Plus personne face à ${al[0].name}.`);
  if (!G.deck.length) {
    const best = Math.max(...al.map(p => p.hand[0]));
    const w = al.filter(p => p.hand[0] === best);
    return endRound(G, w, `Pioche vide : la carte la plus forte est ${R(G, best)}.`);
  }
  do G.cur = (G.cur + 1) % G.players.length; while (G.players[G.cur].out);
  startTurn(G);
}
function endRound(G, winners, why) {
  winners.forEach(p => p.tokens++);
  G.starter = G.players.indexOf(winners[crypto.randomInt(winners.length)]);
  const rats = alive(G).filter(p => p.discard.includes(0)), rat = rats.length === 1 ? rats[0] : null;
  if (rat) rat.tokens++;
  G.result = { why, winners: winners.map(p => p.name), aside: G.aside, rat: rat && rat.name,
    hands: G.players.map(p => ({ name: p.name, card: p.out ? null : p.hand[0] })) };
  log(G, `${winners.map(p => p.name).join(' et ')} : +1 doublon.`);
  if (rat) log(G, `${rat.name} : +1 doublon (seul joueur en lice avec une carte ${N(G, 0)}).`);
  G.phase = G.players.some(p => p.tokens >= G.goal) ? 'over' : 'roundEnd';
}

// Validation de toute action venant d'un téléphone : on ne fait confiance à rien.
function act(G, i, msg) {
  const p = G.players[i];
  switch (msg.type) {
    case 'start':
      if (G.phase !== 'lobby') throw 'La partie a déjà commencé.';
      if (i !== 0) throw "Seul le créateur du salon peut lancer la partie.";
      if (G.players.length < 2) throw 'Il faut au moins deux joueurs.';
      return startGame(G);
    case 'theme':
      if (G.phase !== 'lobby') throw 'La partie a déjà commencé.';
      if (i !== 0) throw 'Seul le créateur du salon choisit le thème.';
      G.theme = findTheme(msg.id).id;
      return;
    case 'play': {
      if (G.phase !== 'play' || i !== G.cur) throw "Ce n'est pas ton tour.";
      const idx = msg.idx;
      if (idx !== 0 && idx !== 1) throw 'Carte inconnue.';
      const v = p.hand[idx], tg = validTargets(G, v), need = targetsNeeded(G, v);
      if (v !== 8 && mustPlaySirene(p.hand)) throw `Tu dois jouer la carte ${N(G, 8)}.`;
      const t = Array.isArray(msg.targets) ? msg.targets : [];
      if (t.length !== need || new Set(t).size !== t.length || !t.every(x => tg.includes(x))) throw 'Cible invalide.';
      if (v === 1 && need && !GUESSABLE.includes(msg.guess)) throw 'Rôle accusé invalide.';
      return play(G, idx, { t1: t[0], guess: msg.guess });
    }
    case 'carto':
      if (G.phase !== 'carto' || i !== G.cur) throw "Ce n'est pas ton tour.";
      if (!Number.isInteger(msg.keep) || msg.keep < 0 || msg.keep >= p.hand.length) throw 'Carte inconnue.';
      return cartoChoice(G, msg.keep, msg.flip === true);
    case 'next':
      if (G.phase !== 'roundEnd') throw 'La manche est en cours.';
      return newRound(G);
    case 'again':
      if (G.phase !== 'over') throw 'La partie est en cours.';
      return startGame(G);
    default:
      throw 'Action inconnue.';
  }
}

// Ce que voit le joueur i : jamais la main des autres.
function view(room, i) {
  const G = room.G, me = G.players[i], myTurn = G.phase === 'play' && i === G.cur;
  return {
    code: room.code, phase: G.phase, you: i, goal: G.goal, round: G.round, cur: G.cur,
    deck: G.deck ? G.deck.length : 0, faceUp: G.faceUp || [], asideHidden: G.aside != null,
    players: G.players.map((p, j) => ({ name: p.name, tokens: p.tokens, discard: p.discard, out: p.out, prot: p.prot,
      online: [...room.clients].some(c => c.i === j) })),
    theme: themeOf(G).id, roles: rolesOf(themeOf(G)),
    themes: G.phase === 'lobby' ? themes.map(t => ({ id: t.id, label: t.label })) : null,
    hand: me.hand, inbox: me.inbox,
    options: myTurn ? me.hand.map(v => ({ targets: validTargets(G, v), need: targetsNeeded(G, v),
      locked: v !== 8 && mustPlaySirene(me.hand) })) : null,
    log: G.log.slice(0, 40), result: G.result || null,
  };
}

// ---------- Serveur HTTP ----------
const rooms = new Map();
const PAGE = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
const ADMIN_PAGE = fs.readFileSync(path.join(__dirname, 'public', 'admin.html'));
const HTML_HEADERS = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache',
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
// Mot de passe admin : variable d'environnement ADMIN_PASSWORD. Sans elle, l'admin est en lecture seule.
let adminFails = [];
function checkAdmin(pw) {
  const secret = process.env.ADMIN_PASSWORD;
  if (!secret) throw "Admin désactivé : définis la variable d'environnement ADMIN_PASSWORD sur le serveur.";
  const now = Date.now();
  adminFails = adminFails.filter(t => now - t < 15 * 60e3);
  if (adminFails.length >= 10) throw 'Trop de tentatives. Réessaie dans 15 minutes.';
  const h = x => crypto.createHash('sha256').update(String(x ?? '')).digest();
  if (!crypto.timingSafeEqual(h(pw), h(secret))) { adminFails.push(now); throw 'Mot de passe incorrect.'; }
}

function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do c = Array.from({ length: 4 }, () => A[crypto.randomInt(A.length)]).join(''); while (rooms.has(c));
  return c;
}
function cleanName(n) { return String(n ?? '').replace(/\s+/g, ' ').trim().slice(0, 20); }
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
function readBody(req, max = 4096) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', d => { s += d; if (s.length > max) { reject('Requête trop longue.'); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { reject('Requête illisible.'); } });
  });
}
function broadcast(room) {
  room.touched = Date.now();
  for (const c of room.clients) c.res.write(`data: ${JSON.stringify(view(room, c.i))}\n\n`);
}
function seat(room, token) { return typeof token === 'string' ? room.G.players.findIndex(p => p.token === token) : -1; }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, HTML_HEADERS); return res.end(PAGE); }
    if (req.method === 'GET' && url.pathname === '/admin') { res.writeHead(200, HTML_HEADERS); return res.end(ADMIN_PAGE); }
    if (req.method === 'GET' && url.pathname === '/api/themes') return json(res, 200, { themes: themeList() });
    const im = req.method === 'GET' && /^\/img\/([a-z0-9-]{1,40})\/(\d)$/.exec(url.pathname);
    if (im) {
      const t = themes.find(x => x.id === im[1]), img = t && t.imgs[+im[2]];
      if (!img) return json(res, 404, { error: 'Introuvable.' });
      res.writeHead(200, { 'Content-Type': IMG_TYPES[img.split(':')[0]], 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
      return fs.createReadStream(fileStore.file(t.id, +im[2], img)).on('error', () => res.end()).pipe(res);
    }
    if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true });

    if (req.method === 'GET' && url.pathname === '/api/events') {
      const room = rooms.get(String(url.searchParams.get('code') || '').toUpperCase());
      const i = room ? seat(room, url.searchParams.get('token')) : -1;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
      if (i < 0) { res.write('event: gone\ndata: {}\n\n'); return res.end(); }
      const client = { res, i };
      room.clients.add(client);
      req.on('close', () => { room.clients.delete(client); broadcast(room); });
      return broadcast(room);
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      const isAdmin = url.pathname.startsWith('/api/admin/');
      const body = await readBody(req, url.pathname === '/api/admin/image' ? 700 * 1024 : 4096);
      if (isAdmin) {
        checkAdmin(body.password);
        if (url.pathname === '/api/admin/login') return json(res, 200, { ok: true });
        if (url.pathname === '/api/admin/theme') await upsertTheme(body.theme || {});
        else if (url.pathname === '/api/admin/delete') await deleteTheme(body.id);
        else if (url.pathname === '/api/admin/image') await setImage(body.id, body.v, body.data);
        else return json(res, 404, { error: 'Introuvable.' });
        return json(res, 200, { themes: themeList() });
      }
      if (url.pathname === '/api/create') {
        const name = cleanName(body.name);
        if (!name) return json(res, 400, { error: 'Choisis un nom.' });
        if (rooms.size >= 500) return json(res, 503, { error: 'Trop de salons ouverts, réessaie plus tard.' });
        const room = { code: newCode(), G: newGame(), clients: new Set(), touched: Date.now() };
        rooms.set(room.code, room);
        const p = addPlayer(room.G, name);
        return json(res, 200, { code: room.code, token: p.token });
      }
      const room = rooms.get(String(body.code || '').toUpperCase().trim());
      if (!room) return json(res, 404, { error: "Ce salon n'existe pas (ou plus)." });
      if (url.pathname === '/api/join') {
        const name = cleanName(body.name);
        if (!name) return json(res, 400, { error: 'Choisis un nom.' });
        if (room.G.phase !== 'lobby') return json(res, 409, { error: 'La partie a déjà commencé dans ce salon.' });
        if (room.G.players.length >= MAX_PLAYERS) return json(res, 409, { error: `Le salon est complet (${MAX_PLAYERS} joueurs).` });
        if (room.G.players.some(p => p.name.toLowerCase() === name.toLowerCase())) return json(res, 409, { error: 'Ce nom est déjà pris dans le salon.' });
        const p = addPlayer(room.G, name);
        broadcast(room);
        return json(res, 200, { code: room.code, token: p.token });
      }
      if (url.pathname === '/api/act') {
        const i = seat(room, body.token);
        if (i < 0) return json(res, 403, { error: "Tu ne fais pas partie de ce salon." });
        try { act(room.G, i, body); } catch (e) { if (typeof e === 'string') return json(res, 400, { error: e }); throw e; }
        broadcast(room);
        return json(res, 200, { ok: true });
      }
    }
    json(res, 404, { error: 'Introuvable.' });
  } catch (e) {
    if (typeof e === 'string') return json(res, 400, { error: e });
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: 'Erreur du serveur.' });
  }
});

if (require.main === module) {
  // Garde les flux ouverts derrière les proxys, et oublie les salons abandonnés depuis 6 h.
  setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
      for (const c of room.clients) c.res.write(': ping\n\n');
      if (!room.clients.size && now - room.touched > 6 * 3600e3) rooms.delete(code);
    }
  }, 20000);
  const port = Number(process.env.PORT) || 3000;
  loadThemes().then(() => server.listen(port, () =>
    console.log(`Mutinerie sur http://localhost:${port} (thèmes : ${store === supaStore ? 'Supabase' : THEMES_FILE})`)));
}

module.exports = { themeList, upsertTheme, deleteTheme, setImage, loadThemes, ROLES, TOTAL_CARDS, GUESSABLE, MAX_PLAYERS, mustPlaySirene, newGame, addPlayer, startGame, newRound, play, cartoChoice, validTargets, targetsNeeded, act, view };
