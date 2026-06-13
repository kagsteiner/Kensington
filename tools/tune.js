#!/usr/bin/env node
/*
 * Kensington evaluation tuner CLI (Texel-style).
 *
 *   node tools/tune.js [options]
 *
 * Pipeline: generate a self-play corpus once, fit the eval weights by logistic
 * regression to predict game outcomes, print before -> after, and optionally
 * validate the tuned weights against the starting ones in the arena.
 *
 * Options:
 *   --games <n>     corpus games                       (default: 300)
 *   --depth <n>     fixed search depth for generation  (default: 3)
 *   --gen <set>     weights used to GENERATE the games (default: swarm2)
 *   --init <set>    starting weights for the fit       (default: base)
 *   --noise <x>     root-score noise during generation (default: 8)
 *   --seed <n>      base seed                          (default: 5000)
 *   --maxplies <n>  per-game cap                       (default: 250)
 *   --validate <n>  play n arena games tuned vs init   (default: 0 = skip)
 *   --vdepth <n>    search depth for validation        (default: --depth)
 *   --out <file>    write the tuned weight set as JSON
 *
 * `gen` and `init` accept: base, swarm2 (or any name below). A larger --games
 * gives a steadier fit; iterate by feeding the tuned set back in via --gen.
 */
'use strict';

var KEngine = require('../js/engine.js');
var KTuner = require('../js/tuner.js');
var KArena = require('../js/arena.js');

var WEIGHTSETS = {
  base: {},
  swarm2: { millRunning: 40, millClosed: 4, millLive: 8, millBlocked: -6, winReach: 6, coordination: 3 }
};

function parseArgs(argv) {
  var o = { games: 300, depth: 3, gen: 'swarm2', init: 'base', noise: 8,
            seed: 5000, maxplies: 250, validate: 0, vdepth: 0, out: null };
  for (var i = 2; i < argv.length; i++) {
    var k = argv[i];
    if (k.slice(0, 2) !== '--') continue;
    var name = k.slice(2), val = argv[++i];
    if (['games', 'depth', 'seed', 'maxplies', 'validate', 'vdepth'].indexOf(name) >= 0) o[name] = parseInt(val, 10);
    else if (name === 'noise') o.noise = parseFloat(val);
    else o[name] = val;
  }
  return o;
}

function fmtRow(name, before, after) {
  var arrow = before === after ? '   ' : (after > before ? ' ↑ ' : ' ↓ ');
  return '  ' + name.padEnd(13) + String(before).padStart(6) + arrow + String(after).padStart(6);
}

function main() {
  var o = parseArgs(process.argv);
  if (!WEIGHTSETS[o.gen]) { console.error('unknown --gen set: ' + o.gen); process.exit(1); }
  if (!WEIGHTSETS[o.init]) { console.error('unknown --init set: ' + o.init); process.exit(1); }

  console.log('Kensington eval tuner');
  console.log('  generate: ' + o.games + ' games, depth ' + o.depth + ', gen=' + o.gen +
    ', noise=' + o.noise + ', seed=' + o.seed);

  var t0 = Date.now();
  var corpus = KTuner.buildCorpus({
    games: o.games, depth: o.depth, genWeights: WEIGHTSETS[o.gen],
    noise: o.noise, seed: o.seed, maxplies: o.maxplies,
    onGame: function (gi, rows) {
      if ((gi + 1) % 25 === 0 || gi + 1 === o.games) {
        process.stdout.write('\r  ...' + (gi + 1) + '/' + o.games + ' games, ' + rows + ' positions   ');
      }
    }
  });
  process.stdout.write('\n');
  console.log('  corpus: ' + corpus.X.length + ' positions in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');

  var initW = KEngine.compileWeights(WEIGHTSETS[o.init]);
  var K = KTuner.fitK(corpus, initW);
  var mse0 = KTuner.mse(corpus, initW, K);
  var t1 = Date.now();
  var res = KTuner.fit(corpus, { init: initW, K: K });
  console.log('  fit: K=' + K.toExponential(2) + ', MSE ' + mse0.toFixed(5) + ' -> ' + res.mse.toFixed(5) +
    ' in ' + ((Date.now() - t1) / 1000).toFixed(1) + 's');

  var before = KTuner.weightsToObject(initW);
  var after = KTuner.weightsToObject(res.weights);
  console.log('\n  weight            init   tuned');
  KEngine.FEATURES.forEach(function (name) { console.log(fmtRow(name, before[name], after[name])); });

  var overrides = KTuner.weightsToOverrides(res.weights);
  console.log('\n  tuned set (overrides on base):\n  ' + JSON.stringify(overrides));

  if (o.out) {
    require('fs').writeFileSync(o.out, JSON.stringify(overrides, null, 2) + '\n');
    console.log('  written to ' + o.out);
  }

  if (o.validate > 0) {
    var vdepth = o.vdepth || o.depth;
    console.log('\n  validating: ' + o.validate + ' games at depth ' + vdepth + ' (tuned vs ' + o.init + ')...');
    var vres = KArena.runMatch(
      { name: 'tuned', weights: after, maxDepth: vdepth, timeMs: Infinity, noise: 0 },
      { name: o.init, weights: WEIGHTSETS[o.init], maxDepth: vdepth, timeMs: Infinity, noise: 0 },
      { games: o.validate, seed: o.seed + 100000, randomPlies: 6 });
    console.log('  tuned vs ' + o.init + ': ' + vres.aWins + 'W-' + vres.bWins + 'L-' + vres.draws + 'D' +
      '  score for tuned: ' + (100 * vres.score).toFixed(1) + '% ± ' + (100 * vres.stderr).toFixed(1) + '%');
  }
}

main();
