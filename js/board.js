/*
 * Kensington board model.
 *
 * The board is a finite portion of the rhombitrihexagonal tiling (3.4.6.4):
 * a central hexagon surrounded by a ring of six hexagons (2 red on top,
 * 2 blue on the bottom, 3 white: left, right, center). Every hexagon is
 * decorated with a "rosette": one square on each of its 6 edges and one
 * triangle on each of its 6 corners. The union of the 7 rosettes is the
 * Kensington board:
 *
 *   72 vertices, 132 edges, 7 hexagons, 30 squares, 24 triangles.
 *
 * The same model serves the engine (vertex ids, adjacency, cell lists used
 * for mills and win detection) and the UI (vertex coordinates). Coordinates
 * use hexagon side = 1 and screen orientation (y grows downward), so the
 * red hexagons end up at the top, like on the printed board.
 */
(function (global, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else global.KBoard = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SQRT3 = Math.sqrt(3);
  var DIST = 1 + SQRT3; // distance between adjacent hexagon centers

  function build() {
    // --- 1. The seven hexagons -------------------------------------------
    var hexDefs = [{ cx: 0, cy: 0, color: 'white' }];
    // ring index k -> angle k*60deg (y downward): 0 right, 1 down-right,
    // 2 down-left, 3 left, 4 up-left, 5 up-right
    var ringColors = ['white', 'blue', 'blue', 'white', 'red', 'red'];
    for (var k = 0; k < 6; k++) {
      var a = (k * 60) * Math.PI / 180;
      hexDefs.push({ cx: DIST * Math.cos(a), cy: DIST * Math.sin(a), color: ringColors[k] });
    }

    // --- 2. Vertex registry (deduplicated by rounded coordinates) --------
    var verts = [];
    var vmap = new Map();
    function vid(x, y) {
      var key = Math.round(x * 1000) + ',' + Math.round(y * 1000);
      if (vmap.has(key)) return vmap.get(key);
      var id = verts.length;
      verts.push({ x: x, y: y });
      vmap.set(key, id);
      return id;
    }

    // --- 3. Cells ----------------------------------------------------------
    var hexes = [];
    var squareMap = new Map();   // canonical key -> vertex list in perimeter order
    var triangleMap = new Map();
    function addCell(map, ids) {
      var key = ids.slice().sort(function (a, b) { return a - b; }).join(',');
      if (!map.has(key)) map.set(key, ids);
    }

    hexDefs.forEach(function (h) {
      // pointy-top hexagon: corners at -90deg + j*60deg
      var corners = [];
      for (var j = 0; j < 6; j++) {
        var a = (-90 + 60 * j) * Math.PI / 180;
        corners.push(vid(h.cx + Math.cos(a), h.cy + Math.sin(a)));
      }
      // unit outward normal of each edge (corner j -> corner j+1)
      var normals = [];
      for (j = 0; j < 6; j++) {
        var p = verts[corners[j]], q = verts[corners[(j + 1) % 6]];
        var mx = (p.x + q.x) / 2 - h.cx, my = (p.y + q.y) / 2 - h.cy;
        var len = Math.hypot(mx, my);
        normals.push({ x: mx / len, y: my / len });
      }
      // a square sits on every hexagon edge
      for (j = 0; j < 6; j++) {
        var aV = verts[corners[j]], bV = verts[corners[(j + 1) % 6]], n = normals[j];
        addCell(squareMap, [
          corners[j], corners[(j + 1) % 6],
          vid(bV.x + n.x, bV.y + n.y), vid(aV.x + n.x, aV.y + n.y)
        ]);
      }
      // a triangle sits on every hexagon corner, between the two adjacent squares
      for (j = 0; j < 6; j++) {
        var v = verts[corners[j]];
        var nPrev = normals[(j + 5) % 6], nNext = normals[j];
        addCell(triangleMap, [
          corners[j],
          vid(v.x + nPrev.x, v.y + nPrev.y),
          vid(v.x + nNext.x, v.y + nNext.y)
        ]);
      }
      hexes.push({ verts: corners, color: h.color, cx: h.cx, cy: h.cy });
    });

    // --- 4. Renumber vertices in reading order (stable, deterministic) ----
    var order = verts.map(function (_, i) { return i; });
    order.sort(function (a, b) {
      var ya = Math.round(verts[a].y * 1000), yb = Math.round(verts[b].y * 1000);
      if (ya !== yb) return ya - yb;
      return Math.round(verts[a].x * 1000) - Math.round(verts[b].x * 1000);
    });
    var remap = [];
    order.forEach(function (oldId, newId) { remap[oldId] = newId; });
    var newVerts = order.map(function (oldId) { return verts[oldId]; });
    function remapCell(ids) { return ids.map(function (i) { return remap[i]; }); }

    hexes = hexes.map(function (h) {
      return { verts: remapCell(h.verts), color: h.color, cx: h.cx, cy: h.cy };
    });
    var squares = Array.from(squareMap.values()).map(remapCell);
    var triangles = Array.from(triangleMap.values()).map(remapCell);

    // --- 5. Edges and adjacency -------------------------------------------
    var edgeSet = new Map();
    function addEdge(a, b) {
      var key = Math.min(a, b) + ',' + Math.max(a, b);
      if (!edgeSet.has(key)) edgeSet.set(key, [a, b]);
    }
    function addPerimeter(ids) {
      for (var i = 0; i < ids.length; i++) addEdge(ids[i], ids[(i + 1) % ids.length]);
    }
    hexes.forEach(function (h) { addPerimeter(h.verts); });
    squares.forEach(addPerimeter);
    triangles.forEach(addPerimeter);
    var edges = Array.from(edgeSet.values());

    var N = newVerts.length;
    var adj = [];
    for (var i = 0; i < N; i++) adj.push([]);
    edges.forEach(function (e) {
      adj[e[0]].push(e[1]);
      adj[e[1]].push(e[0]);
    });
    adj.forEach(function (list) { list.sort(function (a, b) { return a - b; }); });

    // --- 6. Per-vertex lookups --------------------------------------------
    var hexAt = new Array(N).fill(-1);          // index of the hexagon a vertex belongs to
    var trianglesAt = [], squaresAt = [];
    for (i = 0; i < N; i++) { trianglesAt.push([]); squaresAt.push([]); }
    hexes.forEach(function (h, hi) {
      h.verts.forEach(function (v) { hexAt[v] = hi; });
    });
    triangles.forEach(function (t, ti) {
      t.forEach(function (v) { trianglesAt[v].push(ti); });
    });
    squares.forEach(function (s, si) {
      s.forEach(function (v) { squaresAt[v].push(si); });
    });

    return {
      N: N,
      verts: newVerts,
      edges: edges,
      adj: adj,
      hexes: hexes,
      squares: squares,
      triangles: triangles,
      hexAt: hexAt,
      trianglesAt: trianglesAt,
      squaresAt: squaresAt
    };
  }

  var board = build();

  /*
   * Structural self-check. Returns a list of problems (empty = board is a
   * correct Kensington board). The expected numbers follow from the tiling:
   * see the header comment.
   */
  board.verify = function () {
    var B = board, errors = [];
    function expect(cond, msg) { if (!cond) errors.push(msg); }

    expect(B.N === 72, 'expected 72 vertices, got ' + B.N);
    expect(B.edges.length === 132, 'expected 132 edges, got ' + B.edges.length);
    expect(B.hexes.length === 7, 'expected 7 hexagons, got ' + B.hexes.length);
    expect(B.squares.length === 30, 'expected 30 squares, got ' + B.squares.length);
    expect(B.triangles.length === 24, 'expected 24 triangles, got ' + B.triangles.length);

    var colorCount = { red: 0, blue: 0, white: 0 };
    B.hexes.forEach(function (h) { colorCount[h.color]++; });
    expect(colorCount.red === 2 && colorCount.blue === 2 && colorCount.white === 3,
      'expected hexagon colors 2 red / 2 blue / 3 white, got ' + JSON.stringify(colorCount));

    // every edge of the tiling has length 1 (hexagon side)
    B.edges.forEach(function (e) {
      var p = B.verts[e[0]], q = B.verts[e[1]];
      var d = Math.hypot(p.x - q.x, p.y - q.y);
      expect(Math.abs(d - 1) < 1e-9, 'edge ' + e + ' has length ' + d);
    });

    // degree histogram: 48 vertices of degree 4, 24 rim vertices of degree 3
    var degCount = {};
    B.adj.forEach(function (list) { degCount[list.length] = (degCount[list.length] || 0) + 1; });
    expect(degCount[4] === 48 && degCount[3] === 24 && Object.keys(degCount).length === 2,
      'unexpected degree histogram ' + JSON.stringify(degCount));

    // 42 hexagon vertices (6 per hexagon, none shared)
    var onHex = B.hexAt.filter(function (h) { return h >= 0; }).length;
    expect(onHex === 42, 'expected 42 hexagon vertices, got ' + onHex);

    // every vertex belongs to exactly one triangle (24 * 3 = 72)
    var triCounts = B.trianglesAt.map(function (l) { return l.length; });
    expect(triCounts.every(function (c) { return c === 1; }),
      'every vertex must belong to exactly one triangle');

    // square membership: hexagon vertices in 2 squares; rim vertices in 1 or 2
    var sq1 = 0, sq2 = 0;
    for (var v = 0; v < B.N; v++) {
      var c = B.squaresAt[v].length;
      if (B.hexAt[v] >= 0) {
        expect(c === 2, 'hexagon vertex ' + v + ' belongs to ' + c + ' squares');
      } else {
        if (c === 1) sq1++; else if (c === 2) sq2++;
        else errors.push('rim vertex ' + v + ' belongs to ' + c + ' squares');
      }
    }
    expect(sq1 === 24 && sq2 === 6, 'rim square membership: ' + sq1 + 'x1 + ' + sq2 + 'x2');

    // adjacency is symmetric and irreflexive
    for (v = 0; v < B.N; v++) {
      B.adj[v].forEach(function (w) {
        expect(w !== v, 'self-loop at ' + v);
        expect(B.adj[w].indexOf(v) >= 0, 'asymmetric adjacency ' + v + '-' + w);
      });
    }
    return errors;
  };

  return board;
});
