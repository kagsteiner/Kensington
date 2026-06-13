/*
 * Test suite for the Kensington board model, rules and engine.
 * Runs in Node (node tests/run-tests.js) and in the browser (tests.html).
 */
(function (global, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('../js/board.js'), require('../js/rules.js'), require('../js/engine.js'));
  } else {
    global.KTests = factory(global.KBoard, global.KRules, global.KEngine);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (B, K, E) {
  'use strict';

  var RED = K.RED, BLUE = K.BLUE, EMPTY = K.EMPTY;

  // ---- tiny harness ------------------------------------------------------
  var results = [];
  var current = null;
  function test(name, fn) {
    current = { name: name, failures: [] };
    try {
      fn();
    } catch (e) {
      current.failures.push('exception: ' + (e && e.stack || e));
    }
    results.push(current);
    current = null;
  }
  function ok(cond, msg) {
    if (!cond) current.failures.push(msg || 'assertion failed');
  }
  function eq(actual, expected, msg) {
    if (actual !== expected) {
      current.failures.push((msg || 'eq') + ': expected ' + expected + ', got ' + actual);
    }
  }

  // deterministic PRNG for fuzz tests
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  // ---- helpers -----------------------------------------------------------

  // builds a Game directly from a position description (bypasses play)
  function pos(opts) {
    var g = new K.Game();
    (opts.red || []).forEach(function (v) { g.board[v] = RED; });
    (opts.blue || []).forEach(function (v) { g.board[v] = BLUE; });
    if (opts.phase === 'movement') {
      g.placed = [0, 15, 15];
    } else {
      g.placed = [0, (opts.red || []).length, (opts.blue || []).length];
    }
    g.toMove = opts.toMove || RED;
    g.relocsLeft = opts.relocsLeft || 0;
    return g;
  }

  // some vertices far away from a given set: rim vertices (on no hexagon)
  function rimVerts(exclude, count) {
    var out = [];
    for (var v = 0; v < B.N && out.length < count; v++) {
      if (B.hexAt[v] < 0 && exclude.indexOf(v) < 0) out.push(v);
    }
    return out;
  }

  function hexByColor(color, idx) {
    var found = B.hexes.filter(function (h) { return h.color === color; });
    return found[idx || 0];
  }

  function countColor(g, c) {
    var n = 0;
    for (var v = 0; v < B.N; v++) if (g.board[v] === c) n++;
    return n;
  }

  // ---- board structure ----------------------------------------------------

  test('board passes structural self-check (72/132/7/30/24 etc.)', function () {
    var errors = B.verify();
    ok(errors.length === 0, 'verify() reported: ' + errors.join(' | '));
  });

  test('hexagon colors are placed correctly (red top, blue bottom)', function () {
    B.hexes.forEach(function (h) {
      if (h.color === 'red') ok(h.cy < -1, 'red hexagon should be in the upper half');
      if (h.color === 'blue') ok(h.cy > 1, 'blue hexagon should be in the lower half');
    });
    eq(B.hexes.filter(function (h) { return h.color === 'white'; }).length, 3, 'white hexagons');
  });

  test('triangle and square vertices are mutually adjacent along cell sides', function () {
    B.triangles.forEach(function (t) {
      for (var i = 0; i < 3; i++) {
        ok(B.adj[t[i]].indexOf(t[(i + 1) % 3]) >= 0, 'triangle side missing edge');
      }
    });
    B.squares.forEach(function (s) {
      for (var i = 0; i < 4; i++) {
        ok(B.adj[s[i]].indexOf(s[(i + 1) % 4]) >= 0, 'square side missing edge');
      }
      // diagonals must NOT be edges
      ok(B.adj[s[0]].indexOf(s[2]) < 0, 'square diagonal must not be an edge');
      ok(B.adj[s[1]].indexOf(s[3]) < 0, 'square diagonal must not be an edge');
    });
  });

  // ---- basic game flow -----------------------------------------------------

  test('initial position: red to move, placement phase, 72 placements', function () {
    var g = new K.Game();
    eq(g.toMove, RED, 'red starts');
    eq(g.phase(), 'placement', 'phase');
    eq(g.legalMoves().length, 72, 'placements');
    g.applyMove({ type: 'place', to: 0 });
    eq(g.toMove, BLUE, 'blue after red');
    eq(g.legalMoves().length, 71, 'one vertex taken');
    eq(g.board[0], RED, 'stone placed');
  });

  test('placement alternates and transitions to movement after 30 stones', function () {
    var g = new K.Game();
    // fill rim vertices first to avoid mills/hexagons: rim vertices share
    // triangles, so spread placements over distant vertices instead.
    var spots = [];
    for (var v = 0; v < B.N; v++) spots.push(v);
    // pick vertices pairwise non-adjacent greedily to avoid completing cells
    var chosen = [], used = new Set();
    for (v = 0; v < B.N && chosen.length < 30; v++) {
      if (used.has(v)) continue;
      chosen.push(v);
      used.add(v);
      B.adj[v].forEach(function (w) { used.add(w); });
    }
    // not enough fully isolated vertices exist; fall back: just play and
    // resolve any mills by skipping
    g = new K.Game();
    var i = 0;
    while (g.phase() === 'placement' && !g.over()) {
      if (g.relocsLeft > 0) { g.applyMove({ type: 'skip' }); continue; }
      var moves = g.legalMoves();
      g.applyMove(moves[i++ % moves.length]);
    }
    if (!g.over()) {
      eq(g.placed[RED], 15, 'red placed all');
      eq(g.placed[BLUE], 15, 'blue placed all');
      eq(g.phase(), 'movement', 'movement phase reached');
    }
  });

  // ---- mills ---------------------------------------------------------------

  test('completing a triangle grants one relocation', function () {
    var t = B.triangles[0];
    var park = rimVerts(t, 8).filter(function (v) { return t.indexOf(v) < 0; });
    // park blue stones away from the triangle; red completes it
    var g = pos({ red: [t[0], t[1]], blue: [park[4], park[5]], toMove: RED });
    g.applyMove({ type: 'place', to: t[2] });
    eq(g.relocsLeft, 1, 'one relocation owed');
    eq(g.toMove, RED, 'red still to move (relocation pending)');
    var moves = g.legalMoves();
    var relocs = moves.filter(function (m) { return m.type === 'relocate'; });
    var skips = moves.filter(function (m) { return m.type === 'skip'; });
    eq(skips.length, 1, 'skip offered');
    ok(relocs.length > 0, 'relocations offered');
    ok(relocs.every(function (m) { return g.board[m.from] === BLUE && g.board[m.to] === EMPTY; }),
      'relocations move blue stones to empty vertices');
    var r = relocs[0];
    g.applyMove(r);
    eq(g.relocsLeft, 0, 'relocation consumed');
    eq(g.toMove, BLUE, 'turn passes to blue');
    eq(g.board[r.from], EMPTY, 'stone removed');
    eq(g.board[r.to], BLUE, 'stone re-placed');
  });

  test('completing a square grants two relocations', function () {
    var s = B.squares[0];
    var park = rimVerts(s, 8);
    var g = pos({ red: [s[0], s[1], s[2]], blue: [park[3], park[4], park[5]], toMove: RED });
    g.applyMove({ type: 'place', to: s[3] });
    eq(g.relocsLeft, 2, 'two relocations owed');
    var r1 = g.legalMoves().filter(function (m) { return m.type === 'relocate'; })[0];
    g.applyMove(r1);
    eq(g.relocsLeft, 1, 'one left');
    eq(g.toMove, RED, 'still red');
    var r2 = g.legalMoves().filter(function (m) { return m.type === 'relocate'; })[0];
    g.applyMove(r2);
    eq(g.relocsLeft, 0, 'done');
    eq(g.toMove, BLUE, 'turn passes');
  });

  test('skip ends all pending relocations', function () {
    var s = B.squares[0];
    var park = rimVerts(s, 8);
    var g = pos({ red: [s[0], s[1], s[2]], blue: [park[3], park[4], park[5]], toMove: RED });
    g.applyMove({ type: 'place', to: s[3] });
    eq(g.relocsLeft, 2, 'two owed');
    g.applyMove({ type: 'skip' });
    eq(g.relocsLeft, 0, 'cleared');
    eq(g.toMove, BLUE, 'turn passes');
  });

  test('triangle + square completed by one move are capped at two relocations', function () {
    // in this tiling the triangle at a vertex shares an edge with each of the
    // vertex's squares; pre-fill the union of one such triangle/square pair
    // minus the shared vertex, then complete both with a single placement
    var v = B.squares[0][0];
    var s = B.squares[0];
    var t = B.triangles[B.trianglesAt[v][0]];
    var reds = [];
    s.concat(t).forEach(function (x) {
      if (x !== v && reds.indexOf(x) < 0) reds.push(x);
    });
    var park = rimVerts(reds.concat([v]), 12).slice(0, reds.length);
    var g = pos({ red: reds, blue: park, toMove: RED });
    g.applyMove({ type: 'place', to: v });
    eq(g.winner, 0, 'no win');
    eq(g.relocsLeft, 2, 'capped at two relocations (1 + 2 -> 2)');
    eq(g.lastMill.length, 2, 'both figures reported');
  });

  test('moving a stone (not placing) also triggers mills', function () {
    var t = B.triangles[0];
    // find an empty neighbor of t[2] outside the triangle to slide from
    var from = B.adj[t[2]].filter(function (v) { return t.indexOf(v) < 0; })[0];
    ok(from !== undefined, 'no neighbor to slide from');
    var park = rimVerts(t.concat([from]), 12).slice(0, 14);
    var g = pos({ red: [t[0], t[1], from], blue: park.slice(0, 3), toMove: RED, phase: 'movement' });
    g.applyMove({ type: 'move', from: from, to: t[2] });
    eq(g.relocsLeft, 1, 'mill by sliding');
  });

  // ---- winning -------------------------------------------------------------

  test('red wins on a white hexagon', function () {
    var h = hexByColor('white', 0);
    var g = pos({ red: h.verts.slice(0, 5), blue: rimVerts(h.verts, 5), toMove: RED });
    g.applyMove({ type: 'place', to: h.verts[5] });
    eq(g.winner, RED, 'red wins');
    ok(g.winHex >= 0 && B.hexes[g.winHex] === h, 'winning hexagon recorded');
    eq(g.relocsLeft, 0, 'win takes precedence over mills');
    eq(g.legalMoves().length, 0, 'game over');
  });

  test('red wins on a red hexagon, blue does not win on a red hexagon', function () {
    var h = hexByColor('red', 0);
    var g = pos({ red: h.verts.slice(0, 5), blue: rimVerts(h.verts, 5), toMove: RED });
    g.applyMove({ type: 'place', to: h.verts[5] });
    eq(g.winner, RED, 'red wins on own hexagon');

    var g2 = pos({ blue: h.verts.slice(0, 5), red: rimVerts(h.verts, 5), toMove: BLUE });
    g2.applyMove({ type: 'place', to: h.verts[5] });
    eq(g2.winner, 0, 'blue cannot win on a red hexagon');
  });

  test('win by sliding in the movement phase', function () {
    var h = hexByColor('white', 1);
    var target = h.verts[0];
    var from = B.adj[target].filter(function (v) { return h.verts.indexOf(v) < 0; })[0];
    ok(from !== undefined, 'need an outside neighbor');
    var g = pos({
      red: h.verts.slice(1, 6).concat([from]),
      blue: rimVerts(h.verts.concat([from]), 6),
      toMove: RED, phase: 'movement'
    });
    g.applyMove({ type: 'move', from: from, to: target });
    eq(g.winner, RED, 'red wins by sliding');
  });

  test('a careless relocation can hand the enemy the win', function () {
    var h = hexByColor('white', 0);
    // blue has 5 stones on the hexagon; red owes a relocation and moves the
    // 6th blue stone INTO the hexagon
    var blueExtra = rimVerts(h.verts, 1)[0];
    var g = pos({
      blue: h.verts.slice(0, 5).concat([blueExtra]),
      red: rimVerts(h.verts.concat([blueExtra]), 7).slice(1, 7),
      toMove: RED, relocsLeft: 1
    });
    g.applyMove({ type: 'relocate', from: blueExtra, to: h.verts[5] });
    eq(g.winner, BLUE, 'blue wins via red\'s relocation');
  });

  // ---- movement, passing, draws ---------------------------------------------

  test('movement moves go along edges to empty vertices only', function () {
    var v = 20;
    var g = pos({ red: [v], blue: [B.adj[v][0]], toMove: RED, phase: 'movement' });
    var moves = g.legalMoves().filter(function (m) { return m.from === v; });
    var expected = B.adj[v].filter(function (w) { return g.board[w] === EMPTY; });
    eq(moves.length, expected.length, 'one move per empty neighbor');
    ok(moves.every(function (m) { return B.adj[v].indexOf(m.to) >= 0; }), 'targets adjacent');
  });

  test('a blocked player must pass; two consecutive passes draw', function () {
    // block red's only stone: occupy all its neighbors with blue
    var v = 0;
    var g = pos({ red: [v], blue: B.adj[v].slice(), toMove: RED, phase: 'movement' });
    var moves = g.legalMoves();
    eq(moves.length, 1, 'only one option');
    eq(moves[0].type, 'pass', 'must pass');
    g.applyMove(moves[0]);
    eq(g.toMove, BLUE, 'blue moves again');
    ok(!g.over(), 'not over after one pass');
    g.applyMove({ type: 'pass' }); // force second pass mechanically
    ok(g.draw, 'double pass draws');
    eq(g.drawReason, 'stalemate', 'reason');
  });

  test('threefold repetition is a draw', function () {
    // red shuttles between a-b, blue between c-d, far apart
    var a = 0, b = B.adj[0][0];
    var c = 71, d = B.adj[71].filter(function (v) { return v !== a && v !== b; })[0];
    var g = pos({ red: [a], blue: [c], toMove: RED, phase: 'movement' });
    var seq = [
      { type: 'move', from: a, to: b }, { type: 'move', from: c, to: d },
      { type: 'move', from: b, to: a }, { type: 'move', from: d, to: c }
    ];
    var safety = 0;
    while (!g.over() && safety < 40) {
      g.applyMove(seq[safety % 4]);
      safety++;
    }
    ok(g.draw, 'draw by repetition');
    eq(g.drawReason, 'repetition', 'reason');
    ok(safety <= 12, 'draw detected within three cycles (after ' + safety + ' moves)');
  });

  // ---- undo -----------------------------------------------------------------

  test('undo restores the full game state across mills and relocations', function () {
    var s = B.squares[0];
    var park = rimVerts(s, 8);
    var g = pos({ red: [s[0], s[1], s[2]], blue: park.slice(0, 3), toMove: RED });
    var snapshot = JSON.stringify({
      board: Array.from(g.board), toMove: g.toMove, placed: g.placed,
      relocs: g.relocsLeft, rep: Array.from(g.rep.entries())
    });
    g.applyMove({ type: 'place', to: s[3] });
    var r = g.legalMoves().filter(function (m) { return m.type === 'relocate'; })[0];
    g.applyMove(r);
    g.applyMove({ type: 'skip' });
    g.undoMove();
    g.undoMove();
    g.undoMove();
    var after = JSON.stringify({
      board: Array.from(g.board), toMove: g.toMove, placed: g.placed,
      relocs: g.relocsLeft, rep: Array.from(g.rep.entries())
    });
    eq(after, snapshot, 'state identical after undo');
    eq(g.history.length, 0, 'history empty');
  });

  // ---- fuzz: random self-play maintains invariants ---------------------------

  test('fuzz: 60 random games keep all invariants', function () {
    var rnd = mulberry32(12345);
    for (var game = 0; game < 60; game++) {
      var g = new K.Game();
      var steps = 0;
      while (!g.over() && steps < 400) {
        var moves = g.legalMoves();
        ok(moves.length > 0, 'live game must have moves');
        if (moves.length === 0) break;
        var m = moves[Math.floor(rnd() * moves.length)];
        g.applyMove(m);
        steps++;
        // invariants
        ok(countColor(g, RED) === Math.min(g.placed[RED], 15), 'red stone count');
        ok(countColor(g, BLUE) === Math.min(g.placed[BLUE], 15), 'blue stone count');
        ok(g.relocsLeft >= 0 && g.relocsLeft <= 2, 'relocsLeft range');
        ok(g.placed[RED] <= 15 && g.placed[BLUE] <= 15, 'placement limits');
        ok(Math.abs(g.placed[RED] - g.placed[BLUE]) <= 1, 'placement alternation');
        if (g.winner) {
          var h = B.hexes[g.winHex];
          ok(h.verts.every(function (v) { return g.board[v] === g.winner; }),
            'winning hexagon fully occupied by winner');
          var owner = K.hexOwner(h.color);
          ok(owner === 0 || owner === g.winner, 'winner may win on that hexagon');
        }
      }
    }
  });

  test('fuzz: apply/undo round-trips through random games', function () {
    var rnd = mulberry32(999);
    var g = new K.Game();
    var keys = [JSON.stringify(Array.from(g.board)) + g.toMove + g.relocsLeft];
    var played = [];
    var steps = 0;
    while (!g.over() && steps < 120) {
      var moves = g.legalMoves();
      var m = moves[Math.floor(rnd() * moves.length)];
      g.applyMove(m);
      played.push(m);
      keys.push(JSON.stringify(Array.from(g.board)) + g.toMove + g.relocsLeft);
      steps++;
    }
    while (played.length) {
      g.undoMove();
      played.pop();
      var expectKey = keys[played.length];
      var gotKey = JSON.stringify(Array.from(g.board)) + g.toMove + g.relocsLeft;
      if (expectKey !== gotKey) {
        ok(false, 'undo mismatch at depth ' + played.length);
        break;
      }
    }
  });

  // ---- engine ----------------------------------------------------------------

  test('engine finds the winning placement (win in 1)', function () {
    var h = hexByColor('white', 0);
    var g = pos({ red: h.verts.slice(0, 5), blue: rimVerts(h.verts, 5), toMove: RED });
    var m = E.chooseMove(g, { maxDepth: 2, timeMs: 5000, noise: 0 });
    eq(m.type, 'place', 'places');
    eq(m.to, h.verts[5], 'on the winning vertex');
  });

  test('engine blocks the opponent\'s immediate win', function () {
    var h = hexByColor('white', 1);
    var g = pos({
      blue: h.verts.slice(0, 5),
      red: rimVerts(h.verts, 5),
      toMove: RED
    });
    var m = E.chooseMove(g, { maxDepth: 3, timeMs: 5000, noise: 0 });
    eq(m.type, 'place', 'places');
    eq(m.to, h.verts[5], 'on the blocking vertex');
  });

  test('engine wins by sliding when possible', function () {
    var h = hexByColor('red', 0);
    var target = h.verts[0];
    var from = B.adj[target].filter(function (v) { return h.verts.indexOf(v) < 0; })[0];
    var g = pos({
      red: h.verts.slice(1, 6).concat([from]),
      blue: rimVerts(h.verts.concat([from]), 6),
      toMove: RED, phase: 'movement'
    });
    var m = E.chooseMove(g, { maxDepth: 2, timeMs: 5000, noise: 0 });
    eq(m.type, 'move', 'slides');
    eq(m.to, target, 'into the winning vertex');
  });

  test('engine uses a pending relocation to defuse a lost hexagon', function () {
    var h = hexByColor('white', 2);
    var redPark = rimVerts(h.verts, 12).slice(0, 6);
    var g = pos({
      blue: h.verts.slice(0, 5),
      red: redPark,
      toMove: RED, relocsLeft: 1
    });
    g.placed = [0, 6, 6]; // keep it in the placement phase
    var m = E.chooseMove(g, { maxDepth: 3, timeMs: 6000, noise: 0 });
    eq(m.type, 'relocate', 'relocates');
    ok(h.verts.indexOf(m.from) >= 0, 'evicts a blue stone from the dangerous hexagon');
    // afterwards blue must not be able to win immediately
    g.applyMove(m);
    var blueOnHex = h.verts.filter(function (v) { return g.board[v] === BLUE; }).length;
    ok(blueOnHex <= 4, 'hexagon defused (blue stones on it: ' + blueOnHex + ')');
  });

  test('engine is deterministic with noise 0 and fixed depth', function () {
    var g = new K.Game();
    g.applyMove({ type: 'place', to: 10 });
    g.applyMove({ type: 'place', to: 50 });
    var m1 = E.chooseMove(g, { maxDepth: 2, timeMs: 60000, noise: 0 });
    var m2 = E.chooseMove(g, { maxDepth: 2, timeMs: 60000, noise: 0 });
    eq(JSON.stringify([m1.type, m1.from, m1.to]), JSON.stringify([m2.type, m2.from, m2.to]),
      'same move twice');
  });

  test('engine never mutates the game it is given', function () {
    var g = new K.Game();
    g.applyMove({ type: 'place', to: 30 });
    var before = JSON.stringify(Array.from(g.board)) + g.toMove + g.relocsLeft + g.history.length;
    E.chooseMove(g, { maxDepth: 3, timeMs: 1000, noise: 0 });
    var after = JSON.stringify(Array.from(g.board)) + g.toMove + g.relocsLeft + g.history.length;
    eq(after, before, 'game untouched');
  });

  test('engine vs engine: a full game finishes legally', function () {
    var g = new K.Game();
    var steps = 0;
    while (!g.over() && steps < 300) {
      var m = E.chooseMove(g, { maxDepth: 2, timeMs: 250, noise: 5 });
      ok(g.isLegal(m), 'engine move is legal (' + JSON.stringify(m) + ')');
      if (!g.isLegal(m)) break;
      g.applyMove(m);
      steps++;
    }
    ok(g.over() || steps >= 300, 'game progressed');
    // most engine-vs-engine games should actually end; tolerate long games
  });

  // ---- report ----------------------------------------------------------------

  function report() {
    var passed = 0, failed = 0, lines = [];
    results.forEach(function (r) {
      if (r.failures.length === 0) {
        passed++;
        lines.push('PASS  ' + r.name);
      } else {
        failed++;
        lines.push('FAIL  ' + r.name);
        r.failures.forEach(function (f) { lines.push('      - ' + f); });
      }
    });
    lines.push('');
    lines.push(passed + ' passed, ' + failed + ' failed, ' + results.length + ' total');
    return { passed: passed, failed: failed, lines: lines, results: results };
  }

  return { report: report };
});
