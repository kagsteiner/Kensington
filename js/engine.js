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
  // Static evaluation, from the point of view of `c` (the side to move).
  // ---------------------------------------------------------------------

  // value of having n own tokens on a 6-vertex hexagon with no enemy tokens
  var HEX_CLEAN = [0, 4, 14, 40, 120, 420];
  // same, but one enemy token spoils it (still some value: mills can evict)
  var HEX_DIRTY = [0, 1, 4, 12, 40, 140];
  var TRI_THREAT = 8;    // 2 own + 1 empty on a triangle
  var SQ_THREAT = 14;    // 3 own + 1 empty on a square
  var SQ_BUILD = 3;      // 2 own + 2 empty on a square
  var MOBILITY = 2;      // per empty neighbor of an own token (movement phase)
  var TEMPO = 6;

  function evaluate(g) {
    var B = g.B, board = g.board;
    var score = 0; // positive = good for RED
    var i, j, v, redCnt, blueCnt, emptyCnt;

    for (i = 0; i < B.hexes.length; i++) {
      var h = B.hexes[i];
      var owner = KRules.hexOwner(h.color);
      redCnt = 0; blueCnt = 0;
      for (j = 0; j < 6; j++) {
        v = board[h.verts[j]];
        if (v === RED) redCnt++; else if (v === BLUE) blueCnt++;
      }
      if (owner !== BLUE) { // RED may win here
        if (blueCnt === 0) score += HEX_CLEAN[redCnt];
        else if (blueCnt === 1) score += HEX_DIRTY[redCnt];
      }
      if (owner !== RED) { // BLUE may win here
        if (redCnt === 0) score -= HEX_CLEAN[blueCnt];
        else if (redCnt === 1) score -= HEX_DIRTY[blueCnt];
      }
    }

    for (i = 0; i < B.triangles.length; i++) {
      var t = B.triangles[i];
      redCnt = 0; blueCnt = 0;
      for (j = 0; j < 3; j++) {
        v = board[t[j]];
        if (v === RED) redCnt++; else if (v === BLUE) blueCnt++;
      }
      if (redCnt === 2 && blueCnt === 0) score += TRI_THREAT;
      else if (blueCnt === 2 && redCnt === 0) score -= TRI_THREAT;
    }

    for (i = 0; i < B.squares.length; i++) {
      var s = B.squares[i];
      redCnt = 0; blueCnt = 0;
      for (j = 0; j < 4; j++) {
        v = board[s[j]];
        if (v === RED) redCnt++; else if (v === BLUE) blueCnt++;
      }
      if (blueCnt === 0) {
        if (redCnt === 3) score += SQ_THREAT;
        else if (redCnt === 2) score += SQ_BUILD;
      } else if (redCnt === 0) {
        if (blueCnt === 3) score -= SQ_THREAT;
        else if (blueCnt === 2) score -= SQ_BUILD;
      }
    }

    if (g.phase() === 'movement') {
      for (v = 0; v < B.N; v++) {
        var col = board[v];
        if (col === EMPTY) continue;
        var nbs = B.adj[v], free = 0;
        for (j = 0; j < nbs.length; j++) if (board[nbs[j]] === EMPTY) free++;
        if (col === RED) score += free * MOBILITY; else score -= free * MOBILITY;
      }
    }

    var fromRed = score + (g.toMove === RED ? TEMPO : -TEMPO);
    return g.toMove === RED ? fromRed : -fromRed;
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

  // how harmful it is (for the mover) to park an enemy token on empty vertex u
  function parkPenalty(g, mover, u) {
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
    return s;
  }

  function genRelocations(g, cfg, atRoot) {
    var B = g.B, board = g.board, c = g.toMove, e = 3 - c;
    var nFrom = cfg.rFrom + (atRoot ? 2 : 0);
    var nTo = cfg.rTo + (atRoot ? 2 : 0);
    var froms = [], tos = [], v;
    for (v = 0; v < B.N; v++) {
      if (board[v] === e) froms.push({ v: v, s: evictionScore(g, c, v) });
      else if (board[v] === EMPTY) tos.push({ v: v, s: parkPenalty(g, c, v) });
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
    if (depth <= 0 && g.relocsLeft === 0) return evaluate(g);

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
   * {maxDepth, timeMs, noise, rFrom, rTo, placeCap}. Works on a clone, so
   * the passed game is never mutated.
   */
  function chooseMove(game, opts) {
    opts = opts || {};
    var cfg = Object.assign({}, LEVELS[opts.level || 3], opts);
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
    genMoves: genMoves,
    LEVELS: LEVELS,
    WIN: WIN
  };
});
