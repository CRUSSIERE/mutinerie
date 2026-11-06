'use strict';
// Mutinerie — serveur de jeu en ligne. Zéro dépendance : Node >= 18.
// Le serveur détient toute la partie ; chaque joueur ne reçoit que sa propre main.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- Moteur ----------
const ROLES = {
  0: { name: 'Rat de cale', n: 1, txt: "Regarde en secret la carte écartée face cachée." },
  1: { name: 'Moussaillon', n: 5, txt: "Accuse un autre joueur : nomme un rôle (sauf Moussaillon). S'il l'a en main, il quitte la manche." },
  2: { name: 'Vigie', n: 2, txt: "Regarde en secret la carte d'un autre joueur." },
  3: { name: 'Bretteur', n: 2, txt: "Duel avec un autre joueur : comparez vos cartes en secret. La plus faible quitte la manche. Égalité : rien." },
  4: { name: 'Cuistot', n: 2, txt: "Personne ne peut te cibler jusqu'à ton prochain tour." },
  5: { name: 'Cartographe', n: 2, txt: "Regarde la carte du dessus de la pioche, puis laisse-la ou glisse-la sous la pioche." },
  6: { name: 'Canonnier', n: 1, txt: "Un joueur (toi compris) défausse sa carte sans effet et en pioche une nouvelle." },
  7: { name: 'Second', n: 1, txt: "Choisis deux joueurs (toi compris) : ils échangent leurs cartes." },
  8: { name: 'Sirène', n: 1, txt: "Chaque joueur non protégé passe sa carte au joueur non protégé suivant." },
  9: { name: 'Trésor', n: 1, txt: "Si tu défausses le Trésor, pour quelque raison que ce soit, tu quittes la manche." },
};
const TOTAL_CARDS = Object.values(ROLES).reduce((s, r) => s + r.n, 0);
const GUESSABLE = [0, 2, 3, 4, 5, 6, 7, 8, 9];
const TARGETED = [1, 2, 3, 6, 7];
const R = v => `${ROLES[v].name} (${v})`;

function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function buildDeck() { const d = []; for (let v = 0; v <= 9; v++) for (let i = 0; i < ROLES[v].n; i++) d.push(v); return shuffle(d); }
function log(G, t, k = '') { G.log.unshift({ t, k }); G.log.length = Math.min(G.log.length, 80); }
function whisper(p, t) { p.inbox.unshift(t); p.inbox.length = Math.min(p.inbox.length, 6); }
function alive(G) { return G.players.filter(p => !p.out); }

function newGame() { return { players: [], phase: 'lobby', goal: 0, starter: 0, round: 0, log: [], cur: 0 }; }
function addPlayer(G, name) {
  const p = { name, token: crypto.randomUUID(), tokens: 0, hand: [], discard: [], out: false, prot: false, inbox: [] };
  G.players.push(p);
  return p;
}
function startGame(G) {
  const n = G.players.length;
  G.goal = n === 2 ? 5 : n === 3 ? 4 : 3;
  G.players.forEach(p => { p.tokens = 0; });
  G.round = 0; G.starter = 0; G.log = [];
  newRound(G);
}
function newRound(G) {
  G.round++;
  G.deck = buildDeck();                      // dessus de la pioche = dernier élément
  G.aside = G.deck.pop();
  G.faceUp = G.players.length === 2 ? [G.deck.pop(), G.deck.pop()] : [];
  for (const p of G.players) { p.hand = [G.deck.pop()]; p.discard = []; p.out = false; p.prot = false; p.inbox = []; }
  G.cur = G.starter; G.result = null; G.peek = null;
  log(G, `Manche ${G.round}`, 'round');
  startTurn(G);
}
function startTurn(G) {
  const p = G.players[G.cur];
  p.prot = false;
  p.hand.push(G.deck.pop());
  G.phase = 'play';
}
// Seuls le Canonnier et le Second peuvent te cibler toi-même.
function validTargets(G, v) {
  return G.players.map((_, i) => i).filter(i => {
    const q = G.players[i];
    if (q.out) return false;
    if (i === G.cur) return v === 6 || v === 7;
    return !q.prot;
  });
}
function targetsNeeded(G, v) {
  const tg = validTargets(G, v);
  if (v === 7) return tg.length >= 2 ? 2 : 0;
  return TARGETED.includes(v) && tg.length ? 1 : 0;
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
  const T = i => G.players[i], head = `${p.name} joue ${R(v)}`;
  if (TARGETED.includes(v) && a.t1 == null || v === 7 && a.t2 == null) {
    log(G, `${head}, sans effet.`);
  } else switch (v) {
    case 0:
      log(G, `${head} et fouille la cale.`);
      whisper(p, G.aside != null ? `Carte écartée face cachée : ${R(G.aside)}.` : 'La carte écartée a déjà été piochée.');
      break;
    case 1: { const t = T(a.t1);
      log(G, `${head} et accuse ${t.name} d'être ${R(a.guess)}.`);
      if (t.hand[0] === a.guess) eliminate(G, t, 'accusation juste'); else log(G, 'Accusation fausse.');
      break; }
    case 2: { const t = T(a.t1);
      log(G, `${head} et observe ${t.name}.`);
      whisper(p, `Vigie : ${t.name} a ${R(t.hand[0])}.`);
      whisper(t, `${p.name} a regardé ta carte avec la Vigie.`);
      break; }
    case 3: { const t = T(a.t1), mine = p.hand[0], his = t.hand[0];
      log(G, `${head} et provoque ${t.name} en duel.`);
      whisper(p, `Duel — toi : ${R(mine)} · ${t.name} : ${R(his)}.`);
      whisper(t, `Duel lancé par ${p.name}, qui avait ${R(mine)}.`);
      if (mine < his) eliminate(G, p, 'duel perdu');
      else if (his < mine) eliminate(G, t, 'duel perdu');
      else log(G, 'Égalité, personne ne tombe.');
      break; }
    case 4:
      p.prot = true;
      log(G, `${head} : ${p.name} est à l'abri jusqu'à son prochain tour.`);
      break;
    case 5:
      log(G, `${head} et consulte la pioche.`);
      if (G.deck.length) G.peek = G.deck[G.deck.length - 1];
      break;
    case 6: { const t = T(a.t1);
      log(G, `${head} et vise ${t.name}.`);
      const d = t.hand.pop(); t.discard.push(d);
      log(G, `${t.name} défausse ${R(d)}.`);
      if (d === 9) eliminate(G, t, 'Trésor défaussé');
      else { refill(G, t); if (t !== p) whisper(t, `Le Canonnier de ${p.name} t'a fait défausser et repiocher.`); }
      break; }
    case 7: { const x = T(a.t1), y = T(a.t2);
      [x.hand, y.hand] = [y.hand, x.hand];
      log(G, `${head} : ${x.name} et ${y.name} échangent leurs cartes.`);
      for (const [m, o] of [[x, y], [y, x]]) if (m !== p) whisper(m, `Le Second de ${p.name} t'a fait échanger ta carte avec ${o.name}.`);
      break; }
    case 8: {
      const n = G.players.length, ring = [];
      for (let k = 0; k < n; k++) { const q = G.players[(G.cur + k) % n]; if (!q.out && !q.prot) ring.push(q); }
      if (ring.length < 2) { log(G, `${head}, sans effet.`); break; }
      const hands = ring.map(q => q.hand), m = ring.length;
      ring.forEach((q, i) => { q.hand = hands[(i - 1 + m) % m]; });
      log(G, `${head} : ${ring.map(q => q.name).join(', ')} passent leur carte au suivant.`);
      ring.forEach((q, i) => { if (q !== p) whisper(q, `Sirène : tu as reçu la carte de ${ring[(i - 1 + m) % m].name}.`); });
      break; }
    case 9:
      log(G, `${head}.`);
      eliminate(G, p, 'Trésor défaussé');
      break;
  }
  if (G.peek != null) G.phase = 'carto'; else endTurn(G);
}
function cartoChoice(G, toBottom) {
  const p = G.players[G.cur];
  if (toBottom) { G.deck.unshift(G.deck.pop()); log(G, `${p.name} glisse la carte du dessus sous la pioche.`); }
  else log(G, `${p.name} laisse la carte du dessus en place.`);
  G.peek = null;
  endTurn(G);
}
function endTurn(G) {
  const al = alive(G);
  if (al.length === 1) return endRound(G, al, `Plus personne face à ${al[0].name}.`);
  if (!G.deck.length) {
    const best = Math.max(...al.map(p => p.hand[0]));
    let w = al.filter(p => p.hand[0] === best);
    if (w.length > 1) {
      const sum = p => p.discard.reduce((s, x) => s + x, 0), bs = Math.max(...w.map(sum));
      w = w.filter(p => sum(p) === bs);
    }
    return endRound(G, w, `Pioche vide : la carte la plus forte est ${R(best)}.`);
  }
  do G.cur = (G.cur + 1) % G.players.length; while (G.players[G.cur].out);
  startTurn(G);
}
function endRound(G, winners, why) {
  winners.forEach(p => p.tokens++);
  G.starter = G.players.indexOf(winners[0]);
  G.result = { why, winners: winners.map(p => p.name), aside: G.aside,
    hands: G.players.map(p => ({ name: p.name, card: p.out ? null : p.hand[0] })) };
  log(G, `${winners.map(p => p.name).join(' et ')} : +1 doublon.`);
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
    case 'play': {
      if (G.phase !== 'play' || i !== G.cur) throw "Ce n'est pas ton tour.";
      const idx = msg.idx;
      if (idx !== 0 && idx !== 1) throw 'Carte inconnue.';
      const v = p.hand[idx], tg = validTargets(G, v), need = targetsNeeded(G, v);
      const t = Array.isArray(msg.targets) ? msg.targets : [];
      if (t.length !== need || new Set(t).size !== t.length || !t.every(x => tg.includes(x))) throw 'Cible invalide.';
      if (v === 1 && need && !GUESSABLE.includes(msg.guess)) throw 'Rôle accusé invalide.';
      return play(G, idx, { t1: t[0], t2: t[1], guess: msg.guess });
    }
    case 'carto':
      if (G.phase !== 'carto' || i !== G.cur) throw "Ce n'est pas ton tour.";
      return cartoChoice(G, msg.bottom === true);
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
    hand: me.hand, inbox: me.inbox,
    peek: G.phase === 'carto' && i === G.cur ? G.peek : null,
    options: myTurn ? me.hand.map(v => ({ targets: validTargets(G, v), need: targetsNeeded(G, v) })) : null,
    log: G.log.slice(0, 40), result: G.result || null,
  };
}

// ---------- Serveur HTTP ----------
const rooms = new Map();
const PAGE = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));

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
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', d => { s += d; if (s.length > 4096) { reject('Requête trop longue.'); req.destroy(); } });
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
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      return res.end(PAGE);
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
      const body = await readBody(req);
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
        if (room.G.players.length >= 5) return json(res, 409, { error: 'Le salon est complet (5 joueurs).' });
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
  server.listen(port, () => console.log(`Mutinerie sur http://localhost:${port}`));
}

module.exports = { ROLES, TOTAL_CARDS, GUESSABLE, newGame, addPlayer, startGame, newRound, play, cartoChoice, validTargets, targetsNeeded, act, view };
