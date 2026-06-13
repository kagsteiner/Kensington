#!/usr/bin/env node
/*
 * Kensington overnight iterated tuner.
 *
 * Runs Texel tuning in a loop within a wall-clock budget: each round generates
 * a fresh self-play corpus using the previous round's tuned weights (round 1
 * uses swarm2), fits new weights from base, and validates them against swarm2.
 * The corpus thus improves each round. When the budget is nearly spent it runs
 * a tighter final validation (vs swarm2 and base at the corpus depth) and a
 * small level-5 spot check, and writes the best weight set to --out.
 *
 * Everything is logged with timestamps to --results (flushed each round) so the
 * run can be read at any time, and every phase is wrapped so a late failure
 * still leaves the best-so-far weights and a readable log.
 *
 *   node tools/tune-overnight.js --hours 5.5 > /tmp/tune-overnight.stdout 2>&1 &
 *
 * Options (defaults): --hours 5.5  --depth 3  --games 2500  --vgames 120
 *   --reserveMin 90  --finalGames 400  --l5games 4  --l5time 6000  --l5depth 10
 *   --seed 5000  --out <file>  --results <file>
 */
'use strict';

var KEngine = require('../js/engine.js');
var KTuner = require('../js/tuner.js');
var KArena = require('../js/arena.js');
var fs = require('fs');

var SWARM2 = { millRunning: 40, millClosed: 4, millLive: 8, millBlocked: -6, winReach: 6, coordination: 3 };

function parseArgs(argv) {
  var o = {
    hours: 5.0, depth: 3, games: 2500, noise: 2, vgames: 150, reserveMin: 90,
    finalGames: 400, l5games: 4, l5time: 6000, l5depth: 10, seed: 5000,
    out: '/tmp/tuned-overnight.json', results: '/tmp/tune-overnight-results.log'
  };
  for (var i = 2; i < argv.length; i++) {
    if (argv[i].slice(0, 2) !== '--') continue;
    var name = argv[i].slice(2), val = argv[++i];
    if (['hours', 'l5time', 'reserveMin', 'noise'].indexOf(name) >= 0) o[name] = parseFloat(val);
    else if (['depth', 'games', 'vgames', 'finalGames', 'l5games', 'l5depth', 'seed'].indexOf(name) >= 0) o[name] = parseInt(val, 10);
    else o[name] = val;
  }
  return o;
}

var o = parseArgs(process.argv);

function log(msg) {
  var line = '[' + new Date().toISOString() + '] ' + msg;
  console.log(line);
  try { fs.appendFileSync(o.results, line + '\n'); } catch (e) { /* ignore */ }
}

function match(Wa, Wb, games, search, seed, onGame) {
  return KArena.runMatch(
    Object.assign({ name: 'a', weights: Wa }, search),
    Object.assign({ name: 'b', weights: Wb }, search),
    { games: games, seed: seed, randomPlies: 6, onGame: onGame });
}

function pct(x) { return (100 * x).toFixed(1) + '%'; }

function main() {
  try { fs.writeFileSync(o.results, ''); } catch (e) { /* ignore */ }
  var t0 = Date.now();
  var budgetMs = o.hours * 3600e3;
  var reserveMs = o.reserveMin * 60e3;
  var depthSearch = { maxDepth: o.depth, timeMs: Infinity, noise: 0 };

  log('=== overnight tuning start ===');
  log('budget ' + o.hours + 'h, depth ' + o.depth + ', ' + o.games + ' games/round, vgames ' + o.vgames +
    ', reserve ' + o.reserveMin + 'min');

  // best holds the strongest validated weights so far; each round's corpus is
  // generated from it, so a single bad fit can't poison subsequent rounds. A
  // round must BEAT swarm2 (score > 0.5) and be stable to become the new best.
  var best = { name: 'swarm2 (baseline)', W: SWARM2, overrides: SWARM2, score: 0.5, round: 0 };
  var round = 0;

  do {
    round++;
    try {
      var rt = Date.now();
      log('round ' + round + ': generating ' + o.games + ' games (corpus from ' + best.name + ')...');
      var corpus = KTuner.buildCorpus({
        games: o.games, depth: o.depth, genWeights: best.W, noise: o.noise,
        seed: o.seed + round * 1000, maxPlies: 250,
        onGame: function (gi, rows) {
          if ((gi + 1) % 500 === 0) process.stdout.write('\r   ' + (gi + 1) + '/' + o.games + ' games, ' + rows + ' pos   ');
        }
      });
      process.stdout.write('\n');

      var base = KEngine.compileWeights({});
      var K = KTuner.fitK(corpus, base);
      var mse0 = KTuner.mse(corpus, base, K);
      var fit = KTuner.fit(corpus, { init: base, K: K });
      var named = KTuner.weightsToObject(fit.weights);
      var overrides = KTuner.weightsToOverrides(fit.weights);

      var maxAbs = 0;
      for (var wi = 0; wi < fit.weights.length; wi++) maxAbs = Math.max(maxAbs, Math.abs(fit.weights[wi]));
      var stable = maxAbs < 1200;             // reject blown-up (separable-corpus) fits

      var v = match(named, SWARM2, o.vgames, depthSearch, o.seed + 600000 + round);
      log('round ' + round + ': ' + corpus.X.length + ' pos, MSE ' + mse0.toFixed(5) + '->' + fit.mse.toFixed(5) +
        ', vs swarm2 ' + pct(v.score) + ' (' + v.aWins + '-' + v.bWins + '-' + v.draws + '), maxW ' +
        maxAbs.toFixed(0) + (stable ? '' : ' UNSTABLE-skip') + ' [' + ((Date.now() - rt) / 1000).toFixed(0) + 's]');
      log('   overrides: ' + JSON.stringify(overrides));

      if (stable && v.score > best.score) {
        best = { name: 'round ' + round, W: named, overrides: overrides, score: v.score, round: round };
        try { fs.writeFileSync(o.out, JSON.stringify(overrides, null, 2) + '\n'); } catch (e) { /* ignore */ }
        log('   ^ new best (' + pct(v.score) + ' vs swarm2)');
      }
    } catch (e) {
      log('round ' + round + ' ERROR: ' + (e && e.stack || e));
      break;
    }
  } while (Date.now() - t0 < budgetMs - reserveMs);

  log('=== iteration done: ' + round + ' rounds in ' + ((Date.now() - t0) / 3600e3).toFixed(2) + 'h; best = ' +
    best.name + ' (' + pct(best.score) + ' vs swarm2 over ' + o.vgames + ' games) ===');

  try {
    log('final validation (depth ' + o.depth + ', ' + o.finalGames + ' games each)...');
    var fa = match(best.W, SWARM2, o.finalGames, depthSearch, o.seed + 800000);
    log('  best vs swarm2: ' + pct(fa.score) + ' ± ' + pct(fa.stderr) + ' (' + fa.aWins + '-' + fa.bWins + '-' + fa.draws + ')');
    var fb = match(best.W, {}, o.finalGames, depthSearch, o.seed + 810000);
    log('  best vs base:   ' + pct(fb.score) + ' ± ' + pct(fb.stderr) + ' (' + fb.aWins + '-' + fb.bWins + '-' + fb.draws + ')');
  } catch (e) { log('final validation ERROR: ' + (e && e.stack || e)); }

  if (o.l5games > 0) {
    try {
      log('level-5 spot check (' + o.l5games + ' games, timeMs ' + o.l5time + ', depth ' + o.l5depth + ')...');
      var l5search = { maxDepth: o.l5depth, timeMs: o.l5time, noise: 0 };
      var l5 = match(best.W, SWARM2, o.l5games, l5search, o.seed + 900000, function (i, r) {
        log('   l5 game ' + (i + 1) + ': ' + (r.winner === 0 ? 'draw (' + r.drawReason + ')'
          : (r.winner === 1 ? 'red' : 'blue') + ' wins') + ' ' + r.plies + ' plies');
      });
      log('  best vs swarm2 @ level5: ' + pct(l5.score) + ' (' + l5.aWins + '-' + l5.bWins + '-' + l5.draws + ')');
    } catch (e) { log('level-5 validation ERROR: ' + (e && e.stack || e)); }
  }

  try { fs.writeFileSync(o.out, JSON.stringify(best.overrides, null, 2) + '\n'); } catch (e) { /* ignore */ }
  log('=== DONE. best (' + best.name + ') written to ' + o.out + ' ===');
  log('best overrides: ' + JSON.stringify(best.overrides));
}

main();
