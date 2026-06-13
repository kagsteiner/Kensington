/*
 * Kensington evaluation tuner (Texel-style logistic regression).
 *
 * The evaluation is linear in the features (score = features . weights), so
 * tuning the weights is a logistic-regression problem:
 *
 *   1. buildCorpus(): play self-play games once and record, for every quiet
 *      position, its RED-perspective feature vector and the game's final
 *      result from RED's view (win 1 / draw 1/2 / loss 0).
 *   2. fitK(): find the sigmoid scaling K so that sigmoid(K * score) best
 *      predicts those results for the starting weights.
 *   3. fit(): coordinate-descent the weights (K fixed) to minimise the mean
 *      squared error between sigmoid(K * score) and the results.
 *
 * Everything is kept in RED's perspective: the feature vector is already
 * antisymmetric, so a weight set that predicts P(RED wins) is exactly the
 * weight set the (sign-flipping) search needs for both sides. The `tempo`
 * feature carries the side-to-move information.
 *
 * Node-oriented (corpus building is CPU-heavy), but the pure-math fit runs
 * anywhere.
 */
(function (global, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./board.js'), require('./rules.js'), require('./engine.js'));
  } else {
    global.KTuner = factory(global.KBoard, global.KRules, global.KEngine);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (KBoard, KRules, KEngine) {
  'use strict';

  var RED = KRules.RED;

  function mulberry32(seed) {
    seed = seed >>> 0;
    return function () {
      seed = seed + 0x6D2B79F5 | 0;
      var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  // ---- corpus -----------------------------------------------------------

  /*
   * Plays `games` self-play games with `genWeights` and records the
   * RED-perspective feature vector of every quiet, post-opening position,
   * labelled by the game's result from RED's view. Returns
   * { X: [Float64Array], y: [number], nFeatures }.
   */
  function buildCorpus(opts) {
    opts = opts || {};
    var games = opts.games || 500;
    var depth = opts.depth || 3;
    var genW = KEngine.resolveWeights(opts.genWeights);
    var randomPlies = opts.randomPlies != null ? opts.randomPlies : 6;
    var maxPlies = opts.maxPlies || 250;
    var noise = opts.noise != null ? opts.noise : 8;   // diversifies positions
    var baseSeed = opts.seed || 5000;
    var nF = KEngine.FEATURES.length;
    var cfg = { maxDepth: depth, timeMs: Infinity, noise: noise, weights: genW };

    var X = [], y = [];
    for (var gi = 0; gi < games; gi++) {
      var rng = mulberry32(baseSeed + gi);
      var g = new KRules.Game();
      var rows = [];          // indices into X for this game, labelled at the end
      var plies = 0;
      while (!g.over() && plies < maxPlies) {
        var m;
        if (plies < randomPlies && g.relocsLeft === 0) {
          var legal = g.legalMoves();
          m = legal[Math.floor(rng() * legal.length)];
        } else {
          if (g.relocsLeft === 0) {                 // quiet position: record it
            X.push(KEngine.extractFeatures(g, new Float64Array(nF)));
            rows.push(X.length - 1);
            y.push(0.5);                            // placeholder, set below
          }
          m = KEngine.chooseMove(g, cfg);
        }
        if (!m) break;
        g.applyMove(m);
        plies++;
      }
      var result = g.winner === RED ? 1 : g.winner === KRules.BLUE ? 0 : 0.5;
      for (var k = 0; k < rows.length; k++) y[rows[k]] = result;
      if (opts.onGame) opts.onGame(gi, X.length);
    }
    return { X: X, y: y, nFeatures: nF };
  }

  // ---- logistic fit -----------------------------------------------------

  function computeScores(corpus, w) {
    var X = corpus.X, n = X.length, nF = corpus.nFeatures, scores = new Float64Array(n);
    for (var i = 0; i < n; i++) {
      var f = X[i], s = 0;
      for (var j = 0; j < nF; j++) s += f[j] * w[j];
      scores[i] = s;
    }
    return scores;
  }

  function mseScores(scores, y, K) {
    var n = scores.length, s = 0;
    for (var i = 0; i < n; i++) {
      var p = 1 / (1 + Math.exp(-K * scores[i]));
      var d = p - y[i];
      s += d * d;
    }
    return s / n;
  }

  function mse(corpus, w, K) {
    return mseScores(computeScores(corpus, w), corpus.y, K);
  }

  // Find the sigmoid scaling K minimising the error for the given weights:
  // a coarse logarithmic scan followed by a golden-section refinement.
  function fitK(corpus, w) {
    var scores = computeScores(corpus, w), y = corpus.y;
    var bestK = 0.01, bestE = Infinity, e;
    for (e = -6; e <= 1.0001; e += 0.2) {
      var K = Math.pow(10, e), m = mseScores(scores, y, K);
      if (m < bestE) { bestE = m; bestK = K; }
    }
    var lo = bestK / 3, hi = bestK * 3, gr = (Math.sqrt(5) - 1) / 2;
    var c = hi - gr * (hi - lo), d = lo + gr * (hi - lo);
    var fc = mseScores(scores, y, c), fd = mseScores(scores, y, d);
    for (var it = 0; it < 40; it++) {
      if (fc < fd) { hi = d; d = c; fd = fc; c = hi - gr * (hi - lo); fc = mseScores(scores, y, c); }
      else { lo = c; c = d; fc = fd; d = lo + gr * (hi - lo); fd = mseScores(scores, y, d); }
    }
    return (lo + hi) / 2;
  }

  /*
   * Coordinate-descent the weights (K fixed) to minimise the MSE. Uses
   * incremental scoring: changing weight j by delta shifts every score by
   * delta * X[i][j], so each trial costs O(rows) rather than O(rows*features).
   * opts: { init (Float64Array|object), K, steps, maxPasses, onPass }.
   */
  function fit(corpus, opts) {
    opts = opts || {};
    var X = corpus.X, y = corpus.y, n = X.length, nF = corpus.nFeatures;
    var w = opts.init instanceof Float64Array ? Float64Array.from(opts.init)
          : KEngine.compileWeights(opts.init || {});
    var K = opts.K != null ? opts.K : fitK(corpus, w);
    var steps = opts.steps || [40, 10, 3, 1];
    var maxPasses = opts.maxPasses || 40;

    var scores = computeScores(corpus, w);
    var best = mseScores(scores, y, K);

    for (var si = 0; si < steps.length; si++) {
      var step = steps[si], improved = true, passes = 0;
      while (improved && passes < maxPasses) {
        improved = false; passes++;
        for (var j = 0; j < nF; j++) {
          for (var dir = 0; dir < 2; dir++) {
            var delta = dir === 0 ? step : -step, trial = 0, i;
            for (i = 0; i < n; i++) {
              var sc = scores[i] + delta * X[i][j];
              var p = 1 / (1 + Math.exp(-K * sc));
              var dd = p - y[i];
              trial += dd * dd;
            }
            trial /= n;
            if (trial < best - 1e-12) {
              best = trial; w[j] += delta;
              for (i = 0; i < n; i++) scores[i] += delta * X[i][j];
              improved = true;
              break;          // keep this weight's improvement; move on
            }
          }
        }
        if (opts.onPass) opts.onPass(step, passes, best);
      }
    }
    return { weights: w, K: K, mse: best };
  }

  // ---- weight <-> object helpers ----------------------------------------

  // named weight object (rounded) from a Float64Array aligned to FEATURES
  function weightsToObject(w, round) {
    var o = {};
    KEngine.FEATURES.forEach(function (name, i) {
      o[name] = round === false ? w[i] : Math.round(w[i]);
    });
    return o;
  }

  // only the entries that differ from `base` (a compact overrides object)
  function weightsToOverrides(w) {
    var base = KEngine.WEIGHTS.base, o = {};
    KEngine.FEATURES.forEach(function (name, i) {
      var v = Math.round(w[i]);
      if (v !== (base[name] || 0)) o[name] = v;
    });
    return o;
  }

  return {
    buildCorpus: buildCorpus,
    fit: fit,
    fitK: fitK,
    mse: mse,
    mseScores: mseScores,
    computeScores: computeScores,
    weightsToObject: weightsToObject,
    weightsToOverrides: weightsToOverrides,
    mulberry32: mulberry32
  };
});
