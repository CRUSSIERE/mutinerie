// Simulation : 3000 parties aléatoires jouées via act(), comme le ferait le serveur.
// Vérifie : aucune carte perdue, mains de bonne taille, actions illégales refusées, aucune fuite de main dans view().
const E = require('./server.js');
const assert = (c, m) => { if (!c) throw new Error(m); };
const rnd = a => a[Math.floor(Math.random() * a.length)];
const count = G => G.deck.length + G.faceUp.length + (G.aside != null ? 1 : 0) +
  G.players.reduce((s, p) => s + p.hand.length + p.discard.length, 0);
const rejects = (G, i, msg) => { try { E.act(G, i, msg); return false; } catch (e) { return typeof e === 'string'; } };

let games = 0, rounds = 0;
for (let g = 0; g < 3000; g++) {
  const G = E.newGame(), n = 2 + (g % 4);
  for (let k = 0; k < n; k++) E.addPlayer(G, 'P' + k);
  assert(rejects(G, 1, { type: 'start' }), 'non-host started');
  E.act(G, 0, { type: 'start' });
  const room = { code: 'TEST', G, clients: new Set() };
  let steps = 0;
  while (G.phase !== 'over') {
    assert(++steps < 5000, 'game never ends');
    assert(count(G) === E.TOTAL_CARDS, `card count ${count(G)} in phase ${G.phase}`);
    // Aucune vue ne contient la main d'un autre joueur.
    G.players.forEach((p, i) => {
      const v = E.view(room, i);
      assert(!JSON.stringify(v.players).includes('"hand"'), 'hand leaked');
      assert(v.peek == null || i === G.cur, 'peek leaked');
    });
    const i = G.cur, p = G.players[i];
    if (G.phase === 'play') {
      assert(p.hand.length === 2, 'should hold 2 cards');
      G.players.forEach((q, j) => j !== i && assert(q.hand.length === (q.out ? 0 : 1), 'bad hand size'));
      assert(rejects(G, (i + 1) % n, { type: 'play', idx: 0, targets: [] }), 'played out of turn');
      assert(rejects(G, i, { type: 'play', idx: 5, targets: [] }), 'bad idx accepted');
      const idx = Math.floor(Math.random() * 2), v = p.hand[idx];
      const tg = E.validTargets(G, v), need = E.targetsNeeded(G, v);
      if (need) assert(rejects(G, i, { type: 'play', idx, targets: [], guess: 2 }), 'missing target accepted');
      const targets = [...tg].sort(() => Math.random() - .5).slice(0, need);
      if (v === 1 && need) assert(rejects(G, i, { type: 'play', idx, targets, guess: 1 }), 'guessed Moussaillon');
      E.act(G, i, { type: 'play', idx, targets, guess: rnd(E.GUESSABLE) });
    } else if (G.phase === 'carto') {
      E.act(G, i, { type: 'carto', bottom: Math.random() < .5 });
    } else if (G.phase === 'roundEnd') {
      rounds++; E.act(G, 0, { type: 'next' });
    } else throw new Error('phase inattendue ' + G.phase);
  }
  assert(G.players.some(p => p.tokens >= G.goal), 'over without winner');
  games++;
}
console.log(`OK : ${games} parties, ${rounds} manches, ${E.TOTAL_CARDS} cartes conservées, aucune fuite de main.`);
