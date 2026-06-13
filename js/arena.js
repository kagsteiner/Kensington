/*
 * Kensington self-play arena.
 *
 * A headless harness for measuring one engine configuration against another.
 * No UI, no rendering — just games played as fast as the search allows.
 *
 * A "contestant" is a config object passed straight to KEngine.chooseMove,
 * e.g. { name: 'experiment', weights: {...}, maxDepth: 3, timeMs: Infinity,
 * noise: 0 }. The two contestants normally share search settings and differ
 * only in `weights`, so a match isolates the effect of the evaluation.
 *
 * Determinism / fairness:
 *  - timeMs: Infinity makes the search a pure fixed-depth search, so results
 *    do not depend on machine speed.
 *  - Each game opens with a few random plies (a shared, seeded sequence that
 *    is independent of which engine plays which color) so the contestants
 *    explore many different positions instead of replaying one game.
 *  - runMatch swaps colors every game, so first-move advantage cancels out.
 */
(function (global, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./board.js'), require('./rules.js'), require('./engine.js'));
  } else {
    global.KArena = factory(global.KBoard, global.KRules, global.KEngine);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (KBoard, KRules, KEngine) {
  'use strict';

  var RED = KRules.RED, BLUE = KRules.BLUE;

  // small deterministic PRNG so matches are reproducible from a seed
  function mulberry32(seed) {
    seed = seed >>> 0;
    return function () {
      seed = seed + 0x6D2B79F5 | 0;
      var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  var DEFAULT_SEARCH = { maxDepth: 3, timeMs: Infinity, noise: 0 };

  // resolve a contestant config into something chooseMove can use every move,
  // pre-compiling the weights once so we don't recompile on each call
  function prepare(cfg) {
    var out = Object.assign({}, DEFAULT_SEARCH, cfg);
    out.weights = KEngine.resolveWeights(cfg && cfg.weights);
    return out;
  }

  /*
   * Plays a single game. redCfg / blueCfg are prepared contestant configs.
   * opts: { seed, randomPlies, maxPlies }. Returns
   * { winner, draw, drawReason, winHexColor, plies, nodes }.
   */
  function playGame(redCfg, blueCfg, opts) {
    opts = opts || {};
    var rng = mulberry32(opts.seed || 1);
    var randomPlies = opts.randomPlies != null ? opts.randomPlies : 6;
    var maxPlies = opts.maxPlies || 400;

    var g = new KRules.Game();
    var plies = 0, nodes = 0;
    while (!g.over() && plies < maxPlies) {
      var m;
      // open with a neutral, seeded random sequence to diversify games; never
      // randomise relocations (let the engine handle any mill that arises)
      if (plies < randomPlies && g.relocsLeft === 0) {
        var legal = g.legalMoves();
        m = legal[Math.floor(rng() * legal.length)];
      } else {
        m = KEngine.chooseMove(g, g.toMove === RED ? redCfg : blueCfg);
        if (m && m._nodes) nodes += m._nodes;
      }
      if (!m) break;
      g.applyMove(m);
      plies++;
    }

    var capped = !g.over() && plies >= maxPlies;
    return {
      winner: g.winner,
      draw: g.draw || capped,
      drawReason: g.over() ? g.drawReason : (capped ? 'maxplies' : null),
      winHexColor: g.winner ? g.B.hexes[g.winHex].color : null,
      plies: plies,
      nodes: nodes
    };
  }

  /*
   * Plays contestants A and B as PAIRS of games: each opening seed is played
   * twice, once with A as red and once with A as blue (colors swapped, same
   * opening). This cancels first-move advantage exactly and shrinks variance,
   * since both contestants face the identical opening from both sides.
   *
   * opts: { games, seed, randomPlies, maxPlies, onGame }. `games` is the total
   * number of games (rounded to an even number, min 2). Returns an aggregate
   * from A's perspective, including `score` (= (winsA + draws/2) / games) and
   * its standard error.
   */
  function runMatch(cfgA, cfgB, opts) {
    opts = opts || {};
    var games = Math.max(2, opts.games || 100);
    var pairs = Math.round(games / 2);
    var baseSeed = opts.seed || 1000;
    var A = prepare(cfgA), B = prepare(cfgB);

    var res = {
      a: (cfgA && cfgA.name) || 'A',
      b: (cfgB && cfgB.name) || 'B',
      games: 0, aWins: 0, bWins: 0, draws: 0,
      aWinsAsRed: 0, aWinsAsBlue: 0, bWinsAsRed: 0, bWinsAsBlue: 0,
      plies: 0, nodes: 0, drawReasons: {}
    };

    function tally(r, aIsRed) {
      res.games++;
      res.plies += r.plies;
      res.nodes += r.nodes;
      if (r.winner === 0) {
        res.draws++;
        if (r.drawReason) res.drawReasons[r.drawReason] = (res.drawReasons[r.drawReason] || 0) + 1;
      } else {
        var aWon = (r.winner === RED) === aIsRed;
        if (aWon) {
          res.aWins++;
          if (aIsRed) res.aWinsAsRed++; else res.aWinsAsBlue++;
        } else {
          res.bWins++;
          if (aIsRed) res.bWinsAsBlue++; else res.bWinsAsRed++;
        }
      }
      if (opts.onGame) opts.onGame(res.games - 1, r, res);
    }

    for (var k = 0; k < pairs; k++) {
      var gameOpts = { seed: baseSeed + k, randomPlies: opts.randomPlies, maxPlies: opts.maxPlies };
      tally(playGame(A, B, gameOpts), true);   // A red, B blue
      tally(playGame(B, A, gameOpts), false);  // B red, A blue (same opening)
    }

    res.score = (res.aWins + res.draws / 2) / res.games;
    res.stderr = Math.sqrt(res.score * (1 - res.score) / res.games);
    res.avgPlies = res.plies / res.games;
    return res;
  }

  return {
    playGame: playGame,
    runMatch: runMatch,
    prepare: prepare,
    mulberry32: mulberry32,
    DEFAULT_SEARCH: DEFAULT_SEARCH
  };
});
