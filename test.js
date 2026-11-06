// Simulation : 3000 parties aléatoires jouées via act(), comme le ferait le serveur.
// Vérifie : aucune carte perdue, mains de bonne taille, actions illégales refusées, aucune fuite de main dans view().
// Thèmes écrits dans un dossier temporaire, jamais dans le dépôt.
const os = require('os'), fs = require('fs'), path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mutinerie-'));
process.env.THEMES_FILE = path.join(TMP, 'themes.json');
const E = require('./server.js');
const assert = (c, m) => { if (!c) throw new Error(m); };
const rnd = a => a[Math.floor(Math.random() * a.length)];
const count = G => G.deck.length + G.faceUp.length + (G.aside != null ? 1 : 0) +
  G.players.reduce((s, p) => s + p.hand.length + p.discard.length, 0);
const rejects = (G, i, msg) => { try { E.act(G, i, msg); return false; } catch (e) { return typeof e === 'string'; } };

assert(E.TOTAL_CARDS === 21, 'deck should have 21 cards');

// Cartographe : on garde une carte, les deux autres vont sous la pioche dans l'ordre choisi.
{
  const G = E.newGame(); E.addPlayer(G, 'A'); E.addPlayer(G, 'B'); E.act(G, 0, { type: 'start' });
  G.cur = 0; G.players[0].hand = [6, 2]; G.deck = [1, 1, 1, 9, 4];
  E.act(G, 0, { type: 'play', idx: 0, targets: [] });
  assert(G.phase === 'carto' && G.players[0].hand.join() === '2,4,9', 'Cartographe draws 2');
  assert(rejects(G, 1, { type: 'carto', keep: 0 }), 'carto out of turn');
  assert(rejects(G, 0, { type: 'carto', keep: 3 }), 'carto bad keep');
  E.act(G, 0, { type: 'carto', keep: 2, flip: true });   // garde 9 ; ordre inversé : 4 puis 2 (2 tout au fond)
  assert(G.players[0].hand.join() === '9' && G.deck.slice(0, 2).join() === '2,4', 'carto order ' + G.deck);
}
// Rat de cale : seul joueur en lice à en avoir joué un → +1 doublon, en plus du gagnant.
{
  const G = E.newGame(); ['A', 'B', 'C'].forEach(n => E.addPlayer(G, n)); E.act(G, 0, { type: 'start' });
  G.cur = 0; G.players[0].hand = [0, 2]; G.players[1].hand = [9]; G.players[2].hand = [3]; G.deck = [];
  G.players.forEach(p => { p.tokens = 0; p.discard = []; p.out = false; p.prot = false; });
  E.act(G, 0, { type: 'play', idx: 0, targets: [] });
  assert(G.players[1].tokens === 1 && G.players[0].tokens === 1 && G.players[2].tokens === 0, 'rat bonus');
}
assert(E.MAX_PLAYERS === 6, 'max 6 joueurs');

// Thèmes : création, validation, choix dans le salon, illustrations, rechargement depuis le disque.
{
  const throwsMsg = f => { try { f(); return false; } catch (e) { return typeof e === 'string'; } };
  const gang = ['Indic', 'Porte-flingue', 'Mouchard', 'Caïd', 'Avocat', 'Tueur', 'Comptable', 'Consigliere', 'Veuve', 'Magot'];
  assert(E.themeList()[0].id === 'pirate', 'default theme');
  assert(throwsMsg(() => E.upsertTheme({ label: '', names: gang })), 'empty label accepted');
  assert(throwsMsg(() => E.upsertTheme({ label: 'X', names: gang.slice(0, 9) })), '9 names accepted');
  assert(throwsMsg(() => E.upsertTheme({ label: 'X', names: [...gang.slice(0, 9), 'indic'] })), 'duplicate names accepted');
  assert(E.upsertTheme({ label: 'Gangsters', names: gang }) === 'gangsters', 'slug id');
  const G = E.newGame(); ['A', 'B'].forEach(n => E.addPlayer(G, n));
  const room = { code: 'T', G, clients: new Set() };
  assert(rejects(G, 1, { type: 'theme', id: 'gangsters' }), 'non-host changed theme');
  assert(rejects(G, 0, { type: 'theme', id: 'nope' }), 'unknown theme accepted');
  E.act(G, 0, { type: 'theme', id: 'gangsters' });
  const v = E.view(room, 0);
  assert(v.roles[1].name === 'Porte-flingue' && v.roles[8].txt.includes('Consigliere') && v.roles[8].txt.includes('Tueur'), 'theme names in view');
  // Illustration : vrai PNG accepté, faux fichier refusé, suppression du thème = suppression du fichier.
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  assert(throwsMsg(() => E.setImage('gangsters', 3, 'data:image/png;base64,' + Buffer.from('<svg onload=alert(1)>').toString('base64'))), 'fake image accepted');
  assert(throwsMsg(() => E.setImage('gangsters', 10, png)), 'bad card index accepted');
  E.setImage('gangsters', 3, png);
  assert(/^\/img\/gangsters\/3\?v=\d+$/.test(E.themeList().find(t => t.id === 'gangsters').roles[3].img), 'img url');
  assert(fs.existsSync(path.join(TMP, 'illustrations', 'gangsters-3.png')), 'img file written');
  E.loadThemes();
  assert(E.themeList().find(t => t.id === 'gangsters').roles[3].img, 'themes reload from disk');
  assert(throwsMsg(() => E.deleteTheme('pirate')), 'default theme deleted');
  E.deleteTheme('gangsters');
  assert(!fs.existsSync(path.join(TMP, 'illustrations', 'gangsters-3.png')), 'img file left behind');
  assert(E.view(room, 0).roles[1].name === 'Moussaillon', 'deleted theme falls back to default');
}

let games = 0, rounds = 0;
for (let g = 0; g < 3000; g++) {
  const G = E.newGame(), n = 2 + (g % 5);
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
    });
    const i = G.cur, p = G.players[i];
    if (G.phase === 'play') {
      assert(p.hand.length === 2, 'should hold 2 cards');
      G.players.forEach((q, j) => j !== i && assert(q.hand.length === (q.out ? 0 : 1), 'bad hand size'));
      assert(rejects(G, (i + 1) % n, { type: 'play', idx: 0, targets: [] }), 'played out of turn');
      assert(rejects(G, i, { type: 'play', idx: 5, targets: [] }), 'bad idx accepted');
      // Sirène obligatoire avec le Second ou un Canonnier.
      const forced = E.mustPlaySirene(p.hand);
      if (forced) assert(rejects(G, i, { type: 'play', idx: p.hand.indexOf(8) ^ 1, targets: [] }), 'Sirène not forced');
      const idx = forced ? p.hand.indexOf(8) : Math.floor(Math.random() * 2), v = p.hand[idx];
      const tg = E.validTargets(G, v), need = E.targetsNeeded(G, v);
      if (need) assert(rejects(G, i, { type: 'play', idx, targets: [], guess: 2 }), 'missing target accepted');
      const targets = [...tg].sort(() => Math.random() - .5).slice(0, need);
      if (v === 1 && need) assert(rejects(G, i, { type: 'play', idx, targets, guess: 1 }), 'guessed Moussaillon');
      E.act(G, i, { type: 'play', idx, targets, guess: rnd(E.GUESSABLE) });
    } else if (G.phase === 'carto') {
      assert(p.hand.length >= 2 && p.hand.length <= 3, 'carto hand size');
      E.act(G, i, { type: 'carto', keep: Math.floor(Math.random() * p.hand.length), flip: Math.random() < .5 });
    } else if (G.phase === 'roundEnd') {
      rounds++; E.act(G, 0, { type: 'next' });
    } else throw new Error('phase inattendue ' + G.phase);
  }
  assert(G.players.some(p => p.tokens >= G.goal), 'over without winner');
  games++;
}
console.log(`OK : ${games} parties, ${rounds} manches, ${E.TOTAL_CARDS} cartes conservées, aucune fuite de main.`);
