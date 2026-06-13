/*
 * Kensington engine: iterative-deepening alpha-beta (negamax) search.
 *
 * Search peculiarities of Kensington:
 *  - Mill relocations are extra "micro moves" by the same player within one
 *    turn. The search keeps the maximizing sign while game.toMove is
 *    unchanged and only negates when the turn actually passes.
 *  - Relocations have a huge raw branching factor (enemy tokens x empty
 *    vertices, up to ~600). The search restricts itself to the most
 *    plausible "from" tokens (those propping up enemy structures) and the
 *    most harmless "to" vertices. Skipping the relocation is always
 *    considered, so the search never loses a legal option entirely.
 *  - Positions with pending relocations are unstable, so the search never
 *    evaluates them statically; it extends until the turn is finished.
 *
 * Difficulty levels 1-5 map to depth/time budgets plus, for low levels,
 * random noise on the root move scores.
 */
(function (global, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./board.js'), require('./rules.js'));
  } else {
    global.KEngine = factory(global.KBoard, global.KRules);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (KBoard, KRules) {
  'use strict';

  var EMPTY = KRules.EMPTY, RED = KRules.RED, BLUE = KRules.BLUE;
  var WIN = 1000000;
  var INF = WIN * 2;

  var LEVELS = {
    1: { maxDepth: 1, timeMs: 400, noise: 90, rFrom: 3, rTo: 3, placeCap: 16 },
    2: { maxDepth: 2, timeMs: 800, noise: 35, rFrom: 3, rTo: 4, placeCap: 20 },
    3: { maxDepth: 4, timeMs: 1500, noise: 10, rFrom: 4, rTo: 4, placeCap: 24 },
    4: { maxDepth: 6, timeMs: 3000, noise: 0, rFrom: 4, rTo: 5, placeCap: 28 },
    5: { maxDepth: 10, timeMs: 6000, noise: 0, rFrom: 5, rTo: 6, placeCap: 32 }
  };

  // ---------------------------------------------------------------------
  // Static evaluation as a weighted sum of named features.
  //
  // The evaluation is split in two:
  //   extractFeatures(g, out) fills `out` with RED-perspective raw feature
  //     values. Each feature is (red's count - blue's count) of some pattern,
  //     so the vector is antisymmetric and a single weight vector serves both
  //     sides.
  //   evaluate(g, weights) dots that vector with a weight vector and flips the
  //     sign for the side to move.
  //
  // A "variant evaluation" is therefore just a different weight set. To add a
  // new idea: append its name to FEATURES, compute it in the matching board
  // sweep below, and give it a weight in the sets you want to try (a feature
  // absent from a weight object defaults to 0, i.e. it has no effect).
  // ---------------------------------------------------------------------

  var FEATURES = [
    // own k stones on a hexagon the side may win, opponent has none (k = 1..5)
    'hex1', 'hex2', 'hex3', 'hex4', 'hex5',
    // own k stones on such a hexagon, opponent has exactly one (still evictable)
    'dirty1', 'dirty2', 'dirty3', 'dirty4', 'dirty5',
    'triThreat',    // triangle with 2 own + 1 empty (mill threat)
    'sqThreat',     // square with 3 own + 1 empty (double-mill threat)
    'sqBuild',      // square with 2 own + 2 empty
    'mobility',     // free neighbours of own stones (movement phase only)
    'tempo',        // side to move
    // --- features off by default (weight 0 in base); turn on to experiment ---
    // The last three are computed only in the movement phase, and only when
    // their weight is non-zero, so they cost nothing in the base evaluation.
    'multiThreat',  // having >= 2 hexagons with own >= 4 and no enemy at once,
                    // a proxy for an impending unstoppable double threat that a
                    // shallow search cannot see coming
    'winReach',     // closeness to completing a winnable hexagon, scored as
                    // (M - estimated slides to bring stones onto its empty
                    // vertices): "moves to win, if the opponent does nothing"
    'millLive',     // open mill (2 own + 1 empty triangle) whose gap the
                    // opponent CANNOT step into next move (no adjacent enemy)
    'millBlocked',  // open mill whose gap an adjacent enemy stone can block
    'millClosed',   // a completed mill (3 own on a triangle)
    'millRunning',  // a completed mill that can be safely swung open and shut
                    // (a member can step out to an empty vertex with no enemy
                    // able to occupy the vacated point) -- a relocation engine
    'coordination'  // own adjacent stone-pairs: high = clustered and able to
                    // build mills/hexagons, low = scattered (the inverse of the
                    // "spread" a swinging mill inflicts on its victim)
  ];
  var NF = FEATURES.length;
  var FI = {};
  FEATURES.forEach(function (name, i) { FI[name] = i; });

  // indices captured as locals for the hot path (order-independent writes)
  var I_HEX1 = FI.hex1, I_DIRTY1 = FI.dirty1, I_TRI = FI.triThreat,
      I_SQT = FI.sqThreat, I_SQB = FI.sqBuild, I_MOB = FI.mobility,
      I_TEMPO = FI.tempo, I_MULTI = FI.multiThreat,
      I_REACH = FI.winReach, I_LIVE = FI.millLive, I_BLOCKED = FI.millBlocked,
      I_CLOSED = FI.millClosed, I_RUNNING = FI.millRunning, I_COORD = FI.coordination;

  // Named weight sets. `base` reproduces the original hand-tuned constants
  // exactly. Authoring a variant: see tools/selfplay.js.
  var WEIGHTS = {
    base: {
      hex1: 4, hex2: 14, hex3: 40, hex4: 120, hex5: 420,
      dirty1: 1, dirty2: 4, dirty3: 12, dirty4: 40, dirty5: 140,
      triThreat: 8, sqThreat: 14, sqBuild: 3, mobility: 2, tempo: 6,
      multiThreat: 0, winReach: 0, millLive: 0, millBlocked: 0,
      millClosed: 0, millRunning: 0, coordination: 0
    }
  };

  // Turn a weight set into a Float64Array aligned to FEATURES. A plain object
  // is treated as overrides on top of `base`, so a variant need only list the
  // knobs it changes. A Float64Array is returned as-is (already compiled).
  function compileWeights(w) {
    if (w instanceof Float64Array) return w;
    var merged = Object.assign({}, WEIGHTS.base, w || {});
    var arr = new Float64Array(NF);
    for (var name in merged) {
      if (FI[name] === undefined) throw new Error('unknown feature weight: ' + name);
      arr[FI[name]] = merged[name];
    }
    return arr;
  }

  // Resolve opts.weights (a Float64Array, a name in WEIGHTS, an overrides
  // object, or undefined) to a compiled Float64Array.
  function resolveWeights(w) {
    if (!w) return DEFAULT_WEIGHTS;
    if (w instanceof Float64Array) return w;
    if (typeof w === 'string') {
      if (!WEIGHTS[w]) throw new Error('unknown weight set: ' + w);
      return compileWeights(WEIGHTS[w]);
    }
    return compileWeights(w);
  }

  var DEFAULT_WEIGHTS = compileWeights(WEIGHTS.base);
  var scratch = new Float64Array(NF); // reused; consumed immediately by evaluate

  // All-pairs shortest-path distances on the (static) board graph, computed
  // once: DIST[a][b] = number of slides between vertices a and b. The winReach
  // feature uses it to estimate how many moves it takes to bring stones onto a
  // hexagon's empty vertices.
  var DIST = (function () {
    var n = KBoard.N, all = new Array(n);
    for (var s = 0; s < n; s++) {
      var d = new Int8Array(n); d.fill(-1); d[s] = 0;
      var q = [s];
      for (var qi = 0; qi < q.length; qi++) {
        var u = q[qi], nb = KBoard.adj[u];
        for (var k = 0; k < nb.length; k++) {
          var w2 = nb[k];
          if (d[w2] < 0) { d[w2] = d[u] + 1; q.push(w2); }
        }
      }
      all[s] = d;
    }
    return all;
  })();

  var REACH_M = 10, REACH_DCAP = 6;

  // "moves to win" potential for one hexagon: REACH_M minus the summed slide
  // distance of the cheapest stones routed to its empty vertices (one stone per
  // vertex, opponent ignored). Stones already on the hexagon stay put. Bigger =
  // closer to completing the hexagon.
  function reachPotential(B, stones, hi, empties) {
    var T = 0;
    for (var k = 0; k < empties.length; k++) {
      var de = DIST[empties[k]], best = REACH_DCAP;
      for (var si = 0; si < stones.length; si++) {
        var st = stones[si];
        if (B.hexAt[st] === hi) continue;     // keep stones already holding this hexagon
        var d = de[st];
        if (d >= 0 && d < best) best = d;
      }
      T += best;
      if (T >= REACH_M) return 0;
    }
    return REACH_M - T;
  }

  // Is an open mill's empty vertex blockable next move by `blocker`, i.e. does
  // `blocker` have a stone adjacent to the gap that could step into it?
  function millGapBlocked(B, board, t, blocker) {
    var gap = board[t[0]] === EMPTY ? t[0] : board[t[1]] === EMPTY ? t[1] : t[2];
    var nb = B.adj[gap];
    for (var z = 0; z < nb.length; z++) if (board[nb[z]] === blocker) return true;
    return false;
  }

  // Can a closed mill of color `c` be safely swung? It can if some member stone
  // has an empty vertex outside the triangle to step out to (re-opening the
  // mill) while no enemy stone sits next to that member -- so the opponent
  // cannot occupy the vacated point and the mill can be shut again next turn,
  // relocating an enemy stone. Such a "running mill" relocates roughly one enemy
  // stone every two moves.
  function millSwingable(B, board, t, c) {
    var enemy = 3 - c;
    for (var m = 0; m < 3; m++) {
      var V = t[m], nb = B.adj[V], emptyOut = false, enemyAdj = false;
      for (var z = 0; z < nb.length; z++) {
        var u = nb[z];
        if (u === t[0] || u === t[1] || u === t[2]) continue; // triangle's own edges
        if (board[u] === EMPTY) emptyOut = true;
        else if (board[u] === enemy) enemyAdj = true;
      }
      if (emptyOut && !enemyAdj) return true;
    }
    return false;
  }

  // Fills `out` (aligned to FEATURES) with RED-perspective raw features. The
  // movement-only winReach/millLive/millBlocked features are computed only when
  // `w` is absent (inspection) or assigns them a non-zero weight.
  function extractFeatures(g, out, w) {
    var B = g.B, board = g.board, i, j, v, r, b;
    out = out || scratch;
    for (i = 0; i < NF; i++) out[i] = 0;

    var movement = g.phase() === 'movement';
    var doMill = movement && (!w || w[I_LIVE] !== 0 || w[I_BLOCKED] !== 0 ||
                              w[I_CLOSED] !== 0 || w[I_RUNNING] !== 0);
    var doReach = movement && (!w || w[I_REACH] !== 0);
    var doCoord = movement && (!w || w[I_COORD] !== 0);

    var redStrongHex = 0, blueStrongHex = 0;
    for (i = 0; i < B.hexes.length; i++) {
      var h = B.hexes[i];
      var owner = KRules.hexOwner(h.color);
      r = 0; b = 0;
      for (j = 0; j < 6; j++) {
        v = board[h.verts[j]];
        if (v === RED) r++; else if (v === BLUE) b++;
      }
      if (owner !== BLUE) {            // RED may win on this hexagon
        if (b === 0 && r > 0) { out[I_HEX1 + r - 1] += 1; if (r >= 4) redStrongHex++; }
        else if (b === 1 && r > 0) out[I_DIRTY1 + r - 1] += 1;
      }
      if (owner !== RED) {             // BLUE may win on this hexagon
        if (r === 0 && b > 0) { out[I_HEX1 + b - 1] -= 1; if (b >= 4) blueStrongHex++; }
        else if (r === 1 && b > 0) out[I_DIRTY1 + b - 1] -= 1;
      }
    }
    if (redStrongHex >= 2) out[I_MULTI] += 1;
    if (blueStrongHex >= 2) out[I_MULTI] -= 1;

    for (i = 0; i < B.triangles.length; i++) {
      var t = B.triangles[i];
      r = 0; b = 0;
      for (j = 0; j < 3; j++) { v = board[t[j]]; if (v === RED) r++; else if (v === BLUE) b++; }
      if (r === 3) {
        if (doMill) { out[I_CLOSED] += 1; if (millSwingable(B, board, t, RED)) out[I_RUNNING] += 1; }
      } else if (b === 3) {
        if (doMill) { out[I_CLOSED] -= 1; if (millSwingable(B, board, t, BLUE)) out[I_RUNNING] -= 1; }
      } else if (r === 2 && b === 0) {
        out[I_TRI] += 1;
        if (doMill) out[millGapBlocked(B, board, t, BLUE) ? I_BLOCKED : I_LIVE] += 1;
      } else if (b === 2 && r === 0) {
        out[I_TRI] -= 1;
        if (doMill) out[millGapBlocked(B, board, t, RED) ? I_BLOCKED : I_LIVE] -= 1;
      }
    }

    for (i = 0; i < B.squares.length; i++) {
      var s = B.squares[i];
      r = 0; b = 0;
      for (j = 0; j < 4; j++) { v = board[s[j]]; if (v === RED) r++; else if (v === BLUE) b++; }
      if (b === 0) { if (r === 3) out[I_SQT] += 1; else if (r === 2) out[I_SQB] += 1; }
      else if (r === 0) { if (b === 3) out[I_SQT] -= 1; else if (b === 2) out[I_SQB] -= 1; }
    }

    if (movement) {
      var mob = 0;
      for (v = 0; v < B.N; v++) {
        var col = board[v];
        if (col === EMPTY) continue;
        var nbs = B.adj[v], free = 0;
        for (j = 0; j < nbs.length; j++) if (board[nbs[j]] === EMPTY) free++;
        if (col === RED) mob += free; else mob -= free;
      }
      out[I_MOB] = mob;
    }

    if (doCoord) {
      var coord = 0, eg, ca;
      for (i = 0; i < B.edges.length; i++) {
        eg = B.edges[i];
        ca = board[eg[0]];
        if (ca !== EMPTY && ca === board[eg[1]]) coord += ca === RED ? 1 : -1;
      }
      out[I_COORD] = coord;
    }

    if (doReach) {
      var redS = [], blueS = [];
      for (v = 0; v < B.N; v++) { if (board[v] === RED) redS.push(v); else if (board[v] === BLUE) blueS.push(v); }
      var pot = 0;
      for (i = 0; i < B.hexes.length; i++) {
        var hx = B.hexes[i], own2 = KRules.hexOwner(hx.color);
        r = 0; b = 0;
        var empties = [];
        for (j = 0; j < 6; j++) {
          var u = hx.verts[j], cc = board[u];
          if (cc === RED) r++; else if (cc === BLUE) b++; else empties.push(u);
        }
        if (own2 !== BLUE && b === 0 && r >= 1 && r < 6) pot += reachPotential(B, redS, i, empties);
        if (own2 !== RED && r === 0 && b >= 1 && b < 6) pot -= reachPotential(B, blueS, i, empties);
      }
      out[I_REACH] = pot;
    }

    out[I_TEMPO] = g.toMove === RED ? 1 : -1;
    return out;
  }

  function evaluate(g, weights) {
    var w = weights || DEFAULT_WEIGHTS;
    extractFeatures(g, scratch, w);
    var s = 0;
    for (var i = 0; i < NF; i++) s += scratch[i] * w[i];
    return g.toMove === RED ? s : -s;
  }

  // ---------------------------------------------------------------------
  // Move generation for the search: ordered, and capped where the raw
  // branching factor is unmanageable.
  // ---------------------------------------------------------------------

  // heuristic desirability of color c gaining empty vertex `to`
  function gainScore(g, c, to) {
    var B = g.B, board = g.board, e = 3 - c, s = 0, i, j, v;
    var hi = B.hexAt[to];
    if (hi >= 0) {
      var h = B.hexes[hi];
      var owner = KRules.hexOwner(h.color);
      var own = 0, enemy = 0;
      for (j = 0; j < 6; j++) {
        v = board[h.verts[j]];
        if (v === c) own++; else if (v === e) enemy++;
      }
      if ((owner === 0 || owner === c) && enemy === 0) {
        s += own === 5 ? 50000 : own * own * 30 + 10;
      }
      if ((owner === 0 || owner === e) && own === 0 && enemy > 0) {
        s += enemy * enemy * 22; // denying the enemy's hexagon
      }
    }
    var tris = B.trianglesAt[to];
    for (i = 0; i < tris.length; i++) {
      var t = B.triangles[tris[i]], own3 = 0, en3 = 0;
      for (j = 0; j < 3; j++) {
        if (t[j] === to) continue;
        v = board[t[j]];
        if (v === c) own3++; else if (v === e) en3++;
      }
      if (own3 === 2) s += 800;       // completes a mill
      else if (own3 === 1 && en3 === 0) s += 6;
      if (en3 === 2) s += 120;        // spoils an enemy mill threat
    }
    var sqs = B.squaresAt[to];
    for (i = 0; i < sqs.length; i++) {
      var q = B.squares[sqs[i]], own4 = 0, en4 = 0;
      for (j = 0; j < 4; j++) {
        if (q[j] === to) continue;
        v = board[q[j]];
        if (v === c) own4++; else if (v === e) en4++;
      }
      if (own4 === 3) s += 1500;      // completes a double mill
      else if (own4 === 2 && en4 === 0) s += 10;
      if (en4 === 3) s += 160;
    }
    return s;
  }

  // how much enemy structure rests on the enemy token at vertex `v`
  function evictionScore(g, mover, v) {
    var B = g.B, board = g.board, e = 3 - mover, s = 0, i, j, w;
    var hi = B.hexAt[v];
    if (hi >= 0) {
      var h = B.hexes[hi];
      var owner = KRules.hexOwner(h.color);
      var own = 0, enemy = 0;
      for (j = 0; j < 6; j++) {
        w = board[h.verts[j]];
        if (w === mover) own++; else if (w === e) enemy++;
      }
      if ((owner === 0 || owner === e) && own === 0) s += enemy * enemy * 30;
      // evicting the lone blocker of a hexagon the mover is building
      if ((owner === 0 || owner === mover) && enemy === 1) s += own * own * 25;
    }
    var sqs = B.squaresAt[v];
    for (i = 0; i < sqs.length; i++) {
      var q = B.squares[sqs[i]], en = 0;
      for (j = 0; j < 4; j++) if (board[q[j]] === e) en++;
      if (en >= 3) s += 20;
    }
    var tris = B.trianglesAt[v];
    for (i = 0; i < tris.length; i++) {
      var t = B.triangles[tris[i]], en = 0;
      for (j = 0; j < 3; j++) if (board[t[j]] === e) en++;
      if (en === 3) s += 10;
    }
    return s;
  }

  // How harmful it is (for the mover) to park an enemy token on empty vertex u.
  // The hexagon terms avoid handing the enemy a hexagon or wasting the mover's
  // own developing one. When `smart` (default), the mill term steers the
  // relocation into a "dead zone" -- a spot the enemy can't quickly turn into a
  // mill, either because the mover's stones smother the surrounding figures or
  // because it is isolated. High = bad place to park.
  function parkPenalty(g, mover, u, smart) {
    var B = g.B, board = g.board, e = 3 - mover, s = 0, j, w;
    var hi = B.hexAt[u];
    if (hi >= 0) {
      var h = B.hexes[hi];
      var owner = KRules.hexOwner(h.color);
      var own = 0, enemy = 0;
      for (j = 0; j < 6; j++) {
        w = board[h.verts[j]];
        if (w === mover) own++; else if (w === e) enemy++;
      }
      if ((owner === 0 || owner === e) && own === 0) s += (enemy + 1) * (enemy + 1) * 30;
      if ((owner === 0 || owner === mover) && enemy === 0) s += own * own * 25 + 5;
    }
    if (smart !== false) s += enemyMillPotential(g, mover, u);
    return s;
  }

  // Does `color` have a stone next to the gap vertex but OUTSIDE triangle t -- a
  // feeder that could slide in to complete the mill? (The two stones already on
  // t can't: moving one of them just re-opens the figure.)
  function feederAdjacent(B, board, t, gap, color) {
    var nb = B.adj[gap];
    for (var z = 0; z < nb.length; z++) {
      var w = nb[z];
      if (w === t[0] || w === t[1] || w === t[2]) continue;
      if (board[w] === color) return true;
    }
    return false;
  }

  // How much would parking an ENEMY stone at empty vertex u advance an enemy
  // mill within a move or two? Cheap, because each vertex lies in exactly one
  // triangle and one or two squares. Returns 0 for a dead zone: smothered by a
  // mover stone, or isolated from enemy stones.
  function enemyMillPotential(g, mover, u) {
    var B = g.B, board = g.board, e = 3 - mover;
    var placement = g.phase() === 'placement';
    var s = 0, i, j, vtx;

    var tris = B.trianglesAt[u];
    for (i = 0; i < tris.length; i++) {
      var t = B.triangles[tris[i]];
      var en = 0, blocked = false, gap = -1;
      for (j = 0; j < 3; j++) {
        vtx = t[j];
        if (vtx === u) continue;
        if (board[vtx] === e) en++;
        else if (board[vtx] === mover) blocked = true;
        else gap = vtx;
      }
      if (blocked) continue;                  // mover smothers this triangle
      if (en === 2) s += 900;                 // parking completes a closed enemy mill
      else if (en === 1) {                    // parking makes 2-of-3, one gap left
        // completable next move if the enemy can place there (placement) or has
        // a feeder to slide in (movement); otherwise it is a two-move threat
        s += (placement || (gap >= 0 && feederAdjacent(B, board, t, gap, e))) ? 300 : 90;
      }
    }

    var sqs = B.squaresAt[u];                 // a square is a double mill -> weightier
    for (i = 0; i < sqs.length; i++) {
      var q = B.squares[sqs[i]];
      var en4 = 0, blk = false;
      for (j = 0; j < 4; j++) {
        vtx = q[j];
        if (vtx === u) continue;
        if (board[vtx] === e) en4++;
        else if (board[vtx] === mover) blk = true;
      }
      if (blk) continue;
      if (en4 === 3) s += 1400;               // parking completes an enemy double mill
      else if (en4 === 2) s += 60;            // builds toward one
    }
    return s;
  }

  function genRelocations(g, cfg, atRoot) {
    var B = g.B, board = g.board, c = g.toMove, e = 3 - c;
    var nFrom = cfg.rFrom + (atRoot ? 2 : 0);
    var nTo = cfg.rTo + (atRoot ? 2 : 0);
    var smart = cfg.smartPark !== false;       // mill-aware relocation, on by default
    var froms = [], tos = [], v;
    for (v = 0; v < B.N; v++) {
      if (board[v] === e) froms.push({ v: v, s: evictionScore(g, c, v) });
      else if (board[v] === EMPTY) tos.push({ v: v, s: parkPenalty(g, c, v, smart) });
    }
    froms.sort(function (a, b) { return b.s - a.s; });
    tos.sort(function (a, b) { return a.s - b.s; });
    froms = froms.slice(0, nFrom);
    tos = tos.slice(0, nTo);
    var moves = [];
    froms.forEach(function (f) {
      tos.forEach(function (t) {
        moves.push({ type: 'relocate', from: f.v, to: t.v });
      });
    });
    moves.push({ type: 'skip' });
    return moves;
  }

  function genMoves(g, cfg, atRoot) {
    if (g.relocsLeft > 0) return genRelocations(g, cfg, atRoot);
    var moves = g.legalMoves();
    if (moves.length <= 1) return moves;
    var c = g.toMove;
    var scored = moves.map(function (m) {
      return { m: m, s: m.to !== undefined ? gainScore(g, c, m.to) : 0 };
    });
    scored.sort(function (a, b) { return b.s - a.s; });
    if (g.phase() === 'placement' && !atRoot && scored.length > cfg.placeCap) {
      scored = scored.slice(0, cfg.placeCap);
    }
    return scored.map(function (x) { return x.m; });
  }

  // ---------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------

  function moveKey(m) { return m.type + ':' + (m.from === undefined ? '' : m.from) + ':' + (m.to === undefined ? '' : m.to); }

  function Search(game, cfg) {
    this.g = game;
    this.cfg = cfg;
    this.weights = cfg.weights;          // compiled Float64Array
    this.deadline = Date.now() + cfg.timeMs;
    this.nodes = 0;
    this.tt = new Map(); // posKey -> {depth, value, flag, best}
    this.aborted = false;
  }

  Search.prototype.checkTime = function () {
    if ((this.nodes & 1023) === 0 && Date.now() > this.deadline) {
      this.aborted = true;
      throw Search.ABORT;
    }
  };
  Search.ABORT = { abort: true };

  Search.prototype.negamax = function (depth, alpha, beta, ply) {
    var g = this.g;
    this.nodes++;
    this.checkTime();

    if (g.winner !== 0) {
      return g.winner === g.toMove ? WIN - ply : -(WIN - ply);
    }
    if (g.draw) return 0;
    if (depth <= 0 && g.relocsLeft === 0) return evaluate(g, this.weights);

    var key = g._posKey() + ':' + g.relocsLeft;
    var entry = this.tt.get(key);
    var ttBest = null;
    if (entry) {
      if (entry.depth >= depth) {
        if (entry.flag === 0) return entry.value;
        if (entry.flag === -1 && entry.value <= alpha) return entry.value;
        if (entry.flag === 1 && entry.value >= beta) return entry.value;
      }
      ttBest = entry.best;
    }

    var moves = genMoves(g, this.cfg, false);
    if (ttBest) {
      for (var i = 0; i < moves.length; i++) {
        if (moveKey(moves[i]) === ttBest) {
          var tmp = moves[i];
          moves.splice(i, 1);
          moves.unshift(tmp);
          break;
        }
      }
    }

    var best = -INF, bestMove = null;
    var alphaOrig = alpha;
    for (i = 0; i < moves.length; i++) {
      var m = moves[i];
      var mover = g.toMove;
      g.applyMove(m);
      // the sign flips only when the perspective (side to move) changed;
      // mill relocations and game-ending moves keep the same perspective
      var v;
      if (g.toMove === mover) {
        v = this.negamax(depth - 1, alpha, beta, ply + 1);
      } else {
        v = -this.negamax(depth - 1, -beta, -alpha, ply + 1);
      }
      g.undoMove();
      if (v > best) {
        best = v;
        bestMove = m;
        if (v > alpha) alpha = v;
        if (alpha >= beta) break;
      }
    }

    var flag = best <= alphaOrig ? -1 : best >= beta ? 1 : 0;
    this.tt.set(key, { depth: depth, value: best, flag: flag, best: bestMove ? moveKey(bestMove) : null });
    return best;
  };

  // one full-width search of the root; returns scored root moves
  Search.prototype.searchRoot = function (depth, rootMoves) {
    var g = this.g;
    var alpha = -INF, beta = INF;
    var results = [];
    for (var i = 0; i < rootMoves.length; i++) {
      var m = rootMoves[i];
      var mover = g.toMove;
      g.applyMove(m);
      var v;
      if (g.toMove === mover) {
        v = this.negamax(depth - 1, alpha, beta, 1);
      } else {
        v = -this.negamax(depth - 1, -beta, -alpha, 1);
      }
      g.undoMove();
      results.push({ m: m, v: v });
      if (v > alpha) alpha = v;
    }
    return results;
  };

  /*
   * Picks a move for game.toMove. opts: {level} or explicit
   * {maxDepth, timeMs, noise, rFrom, rTo, placeCap, weights}. `weights` may be
   * a compiled Float64Array, a name in WEIGHTS, or an overrides object; it
   * defaults to the base weight set. Pass timeMs: Infinity for a deterministic
   * fixed-depth search (used by self-play). Works on a clone, so the passed
   * game is never mutated.
   */
  function chooseMove(game, opts) {
    opts = opts || {};
    var cfg = Object.assign({}, LEVELS[opts.level || 3], opts);
    cfg.weights = resolveWeights(opts.weights);
    var legal = game.legalMoves();
    if (legal.length === 0) return null;
    if (legal.length === 1) return legal[0];

    var g = game.clone();
    var search = new Search(g, cfg);
    var rootMoves = genMoves(g, cfg, true);
    // keep the root manageable when relocation branching explodes
    if (rootMoves.length > 80) rootMoves = rootMoves.slice(0, 80);

    var bestResults = null;
    var completedDepth = 0;
    for (var d = 1; d <= cfg.maxDepth; d++) {
      try {
        var results = search.searchRoot(d, rootMoves);
        bestResults = results;
        completedDepth = d;
        results.sort(function (a, b) { return b.v - a.v; });
        rootMoves = results.map(function (r) { return r.m; });
        if (results[0].v >= WIN - 100 || results[0].v <= -(WIN - 100)) break; // forced result
        if (Date.now() > search.deadline) break;
      } catch (err) {
        if (err === Search.ABORT) break;
        throw err;
      }
    }

    if (!bestResults) return legal[0];

    var noise = cfg.noise || 0;
    var best = null, bestVal = -Infinity;
    bestResults.forEach(function (r) {
      var v = r.v + (noise ? (Math.random() * 2 - 1) * noise : 0);
      if (v > bestVal) { bestVal = v; best = r.m; }
    });
    best._depth = completedDepth;
    best._nodes = search.nodes;
    best._score = bestResults[0].v;
    return best;
  }

  return {
    chooseMove: chooseMove,
    evaluate: evaluate,
    extractFeatures: extractFeatures,
    compileWeights: compileWeights,
    resolveWeights: resolveWeights,
    FEATURES: FEATURES,
    FI: FI,
    WEIGHTS: WEIGHTS,
    genMoves: genMoves,
    parkPenalty: parkPenalty,
    LEVELS: LEVELS,
    WIN: WIN
  };
});
