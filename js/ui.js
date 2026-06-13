/*
 * Kensington UI: SVG board rendering and interaction.
 *
 * The board SVG is generated from the same KBoard model the engine uses;
 * model coordinates (hexagon side = 1) are scaled by SCALE to SVG units.
 */
(function () {
  'use strict';

  var B = window.KBoard, K = window.KRules, E = window.KEngine;
  var RED = K.RED, BLUE = K.BLUE, EMPTY = K.EMPTY;
  var SCALE = 100;
  var SVG_NS = 'http://www.w3.org/2000/svg';

  var verifyErrors = B.verify();
  if (verifyErrors.length) {
    console.error('Board model failed verification:', verifyErrors);
  }

  // ---- state ---------------------------------------------------------

  var game = null;
  var settings = { mode: 'ai', humanColor: RED, level: 3 };
  var aiThinking = false;
  var selected = -1;          // selected vertex (own stone, or enemy stone during relocation)
  var els = {};               // dom references
  var layers = {};            // svg groups

  var LEVEL_HINTS = {
    1: 'Beginner — plays casually and makes mistakes.',
    2: 'Easy — a little foresight.',
    3: 'Medium — thinks a few moves ahead.',
    4: 'Strong — solid tactical play.',
    5: 'Expert — deep search, takes its time.'
  };

  // ---- svg helpers -----------------------------------------------------

  function svgEl(name, attrs, parent) {
    var el = document.createElementNS(SVG_NS, name);
    for (var k in attrs) el.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(el);
    return el;
  }

  function px(v) { return (B.verts[v].x * SCALE).toFixed(1); }
  function py(v) { return (B.verts[v].y * SCALE).toFixed(1); }

  function polyPoints(ids) {
    return ids.map(function (v) { return px(v) + ',' + py(v); }).join(' ');
  }

  // ---- board construction ----------------------------------------------

  function buildBoard() {
    var svg = els.board;
    svg.innerHTML = '';

    var defs = svgEl('defs', {}, svg);
    defs.innerHTML =
      '<radialGradient id="gradRed" cx="35%" cy="30%" r="80%">' +
      '  <stop offset="0%" stop-color="#ffb3a0" stop-opacity="0.95"/>' +
      '  <stop offset="40%" stop-color="#e2453a" stop-opacity="0.92"/>' +
      '  <stop offset="100%" stop-color="#8e1410" stop-opacity="0.97"/>' +
      '</radialGradient>' +
      '<radialGradient id="gradBlue" cx="35%" cy="30%" r="80%">' +
      '  <stop offset="0%" stop-color="#a9bbff" stop-opacity="0.95"/>' +
      '  <stop offset="40%" stop-color="#3a55d4" stop-opacity="0.92"/>' +
      '  <stop offset="100%" stop-color="#101f6e" stop-opacity="0.97"/>' +
      '</radialGradient>' +
      '<radialGradient id="gradShine" cx="50%" cy="50%" r="50%">' +
      '  <stop offset="0%" stop-color="#ffffff" stop-opacity="0.65"/>' +
      '  <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>' +
      '</radialGradient>' +
      '<filter id="stoneShadow" x="-40%" y="-40%" width="180%" height="180%">' +
      '  <feDropShadow dx="0" dy="5" stdDeviation="5" flood-color="#000" flood-opacity="0.38"/>' +
      '</filter>';

    layers.cells = svgEl('g', {}, svg);
    layers.edges = svgEl('g', {}, svg);
    layers.holes = svgEl('g', {}, svg);
    layers.marks = svgEl('g', {}, svg);   // last move markers
    layers.fx = svgEl('g', {}, svg);      // mill flashes, win glow
    layers.hints = svgEl('g', {}, svg);
    layers.stones = svgEl('g', {}, svg);
    layers.hits = svgEl('g', {}, svg);

    // cells: squares and triangles below, hexagons on top of them
    B.squares.forEach(function (s) {
      svgEl('polygon', { points: polyPoints(s), 'class': 'cell-square' }, layers.cells);
    });
    B.triangles.forEach(function (t) {
      svgEl('polygon', { points: polyPoints(t), 'class': 'cell-triangle' }, layers.cells);
    });
    B.hexes.forEach(function (h) {
      svgEl('polygon', { points: polyPoints(h.verts), 'class': 'hex-' + h.color }, layers.cells);
    });

    B.edges.forEach(function (e) {
      svgEl('line', {
        x1: px(e[0]), y1: py(e[0]), x2: px(e[1]), y2: py(e[1]),
        'class': 'board-line'
      }, layers.edges);
    });

    for (var v = 0; v < B.N; v++) {
      svgEl('circle', { cx: px(v), cy: py(v), r: 8, 'class': 'hole' }, layers.holes);
      var hit = svgEl('circle', { cx: px(v), cy: py(v), r: 31, 'class': 'hit' }, layers.hits);
      hit.dataset.v = v;
      hit.addEventListener('click', onVertexClick);
    }
  }

  // ---- rendering --------------------------------------------------------

  function drawStone(v, color, popIn) {
    var g = svgEl('g', { 'class': 'stone' + (popIn ? ' pop' : '') }, layers.stones);
    var x = +px(v), y = +py(v);
    svgEl('circle', {
      cx: x, cy: y, r: 30,
      fill: color === RED ? 'url(#gradRed)' : 'url(#gradBlue)',
      'class': 'body', filter: 'url(#stoneShadow)'
    }, g);
    // soft specular highlight: the stones are slightly translucent discs
    svgEl('ellipse', {
      cx: x - 9, cy: y - 12, rx: 15, ry: 9,
      fill: 'url(#gradShine)'
    }, g);
    return g;
  }

  function clearLayer(layer) {
    while (layer.firstChild) layer.removeChild(layer.firstChild);
  }

  function colorName(c) { return c === RED ? 'Red' : 'Blue'; }

  function isHumanTurn() {
    return settings.mode === '2p' || game.toMove === settings.humanColor;
  }

  function render() {
    clearLayer(layers.stones);
    clearLayer(layers.hints);
    clearLayer(layers.marks);

    var lm = game.lastMove;
    var popV = lm && lm.to !== undefined ? lm.to : -1;

    for (var v = 0; v < B.N; v++) {
      if (game.board[v] !== EMPTY) drawStone(v, game.board[v], v === popV);
    }

    // last move markers
    if (lm && lm.to !== undefined) {
      svgEl('circle', { cx: px(lm.to), cy: py(lm.to), r: 36, 'class': 'last-move-ring' }, layers.marks);
      if (lm.from !== undefined) {
        svgEl('circle', { cx: px(lm.from), cy: py(lm.from), r: 7, 'class': 'last-move-from' }, layers.marks);
      }
    }

    renderInteraction();
    renderStatus();
    renderWinState();
  }

  // hints, selection ring, clickable targets
  function renderInteraction() {
    var canAct = !game.over() && !aiThinking && isHumanTurn();
    var hits = layers.hits.children;
    var clickable = {};
    var v;

    if (canAct) {
      if (game.relocsLeft > 0) {
        var e = game.enemy(game.toMove);
        for (v = 0; v < B.N; v++) {
          if (selected < 0 && game.board[v] === e) clickable[v] = true;
          if (selected >= 0 && (game.board[v] === EMPTY || game.board[v] === e)) clickable[v] = true;
        }
        // glow on relocatable enemy stones
        if (selected < 0) {
          for (v = 0; v < B.N; v++) {
            if (game.board[v] === e) {
              svgEl('circle', { cx: px(v), cy: py(v), r: 36, 'class': 'reloc-glow' }, layers.hints);
            }
          }
        }
      } else if (game.phase() === 'placement') {
        for (v = 0; v < B.N; v++) if (game.board[v] === EMPTY) clickable[v] = true;
      } else {
        for (v = 0; v < B.N; v++) {
          if (game.board[v] === game.toMove) {
            var movable = B.adj[v].some(function (w) { return game.board[w] === EMPTY; });
            if (movable) clickable[v] = true;
          }
        }
        if (selected >= 0) {
          B.adj[selected].forEach(function (w) {
            if (game.board[w] === EMPTY) {
              clickable[w] = true;
              svgEl('circle', { cx: px(w), cy: py(w), r: 18, 'class': 'hint-ring' }, layers.hints);
            }
          });
        }
      }
    }

    if (selected >= 0) {
      svgEl('circle', { cx: px(selected), cy: py(selected), r: 37, 'class': 'sel-ring' }, layers.hints);
    }

    for (v = 0; v < B.N; v++) {
      hits[v].classList.toggle('clickable', !!clickable[v]);
    }
  }

  function renderStatus() {
    var c = game.toMove;
    els.turnChip.className = 'turn-chip ' + (c === RED ? 'red' : 'blue') + (aiThinking ? ' thinking' : '');

    var who;
    if (settings.mode === '2p') who = colorName(c);
    else who = c === settings.humanColor ? 'You (' + colorName(c) + ')' : 'Computer (' + colorName(c) + ')';

    if (game.over()) {
      if (game.winner) {
        els.turnText.textContent = colorName(game.winner) + ' wins!';
        els.turnChip.className = 'turn-chip ' + (game.winner === RED ? 'red' : 'blue');
      } else {
        els.turnText.textContent = 'Draw';
      }
      els.phaseText.textContent = 'Game over';
    } else {
      els.turnText.textContent = aiThinking ? 'Thinking…' : who + ' to move';
      var ph = game.phase() === 'placement' ? 'Placement phase' : 'Movement phase';
      els.phaseText.textContent = ph;
    }

    els.message.innerHTML = statusMessage();

    // reserves
    renderDots(els.dotsRed, RED);
    renderDots(els.dotsBlue, BLUE);

    // buttons
    var humanReloc = !game.over() && game.relocsLeft > 0 && isHumanTurn() && !aiThinking;
    els.btnSkip.classList.toggle('hidden', !humanReloc);
    els.btnUndo.disabled = game.history.length === 0 || aiThinking;
  }

  function statusMessage() {
    if (game.over()) {
      if (game.winner) {
        var hexCol = B.hexes[game.winHex].color;
        return '<span class="gold">' + colorName(game.winner) + ' surrounded a ' + hexCol +
          ' hexagon.</span>';
      }
      return game.drawReason === 'repetition'
        ? 'Draw by threefold repetition.'
        : 'Draw — neither player can move.';
    }
    if (aiThinking) {
      return 'The computer is considering its move…';
    }
    if (game.relocsLeft > 0) {
      var mill = game.lastMill.length ? game.lastMill.map(function (m) { return m.type; }).join(' + ') : 'mill';
      var n = game.relocsLeft;
      if (isHumanTurn()) {
        if (selected >= 0) {
          return '<span class="gold">Mill!</span> Now click any empty point to drop the enemy stone there.';
        }
        var name = settings.mode === '2p' ? colorName(game.toMove) : 'You';
        return '<span class="gold">' + name + ' completed a ' + mill + '!</span> Click an enemy stone to relocate (' +
          n + ' left), or skip.';
      }
      return '';
    }
    if (game.phase() === 'placement') {
      if (isHumanTurn()) return 'Click an empty point to place a stone.';
      return '';
    }
    if (isHumanTurn()) {
      return selected >= 0
        ? 'Click a highlighted point to slide the stone there.'
        : 'Click one of your stones, then an adjacent empty point.';
    }
    return '';
  }

  function renderDots(container, color) {
    if (container.childElementCount === 0) {
      for (var i = 0; i < K.PIECES_PER_PLAYER; i++) {
        var d = document.createElement('span');
        d.className = 'dot';
        container.appendChild(d);
      }
    }
    var remaining = K.PIECES_PER_PLAYER - game.placed[color];
    for (i = 0; i < K.PIECES_PER_PLAYER; i++) {
      var dot = container.children[i];
      dot.className = 'dot' + (i < remaining ? ' full ' + (color === RED ? 'red' : 'blue') : '');
    }
  }

  function renderWinState() {
    clearLayer(layers.fx);
    if (game.winner && game.winHex >= 0) {
      svgEl('polygon', {
        points: polyPoints(B.hexes[game.winHex].verts),
        'class': 'win-glow'
      }, layers.fx);
    }
    var showOverlay = game.over() && !els.overlay.dataset.dismissed;
    els.overlay.classList.toggle('hidden', !showOverlay);
    if (game.over()) {
      if (game.winner) {
        var winnerIsHuman = settings.mode === '2p' || game.winner === settings.humanColor;
        var title = settings.mode === '2p'
          ? colorName(game.winner) + ' wins!'
          : (winnerIsHuman ? 'You win!' : 'The computer wins');
        els.overlayTitle.textContent = title;
        els.overlayTitle.className = 'overlay-title ' + (game.winner === RED ? 'red-wins' : 'blue-wins');
        els.overlaySub.textContent = colorName(game.winner) + ' surrounded a ' +
          B.hexes[game.winHex].color + ' hexagon.';
      } else {
        els.overlayTitle.textContent = 'Draw';
        els.overlayTitle.className = 'overlay-title draw';
        els.overlaySub.textContent = game.drawReason === 'repetition'
          ? 'The position repeated three times.'
          : 'Neither player can move.';
      }
    }
  }

  function flashMills() {
    game.lastMill.forEach(function (m) {
      var p = svgEl('polygon', { points: polyPoints(m.verts), 'class': 'mill-flash' }, layers.fx);
      setTimeout(function () { if (p.parentNode) p.parentNode.removeChild(p); }, 1700);
    });
  }

  // ---- moves ------------------------------------------------------------

  function playMove(m) {
    game.applyMove(m);
    selected = -1;
    delete els.overlay.dataset.dismissed;
    render();
    if (game.lastMill.length) flashMills();
    scheduleNext();
  }

  // after every state change: let the AI move, or auto-pass for a blocked human
  function scheduleNext() {
    if (game.over()) return;

    if (settings.mode === 'ai' && game.toMove !== settings.humanColor) {
      aiThinking = true;
      render();
      // let the browser paint the "thinking" state before the search blocks
      setTimeout(function () {
        var m = E.chooseMove(game, { level: settings.level });
        aiThinking = false;
        if (m) playMove(m);
        else render();
      }, 80);
      return;
    }

    // human (or 2p current player) has no legal slide: forced pass
    var moves = game.legalMoves();
    if (moves.length === 1 && moves[0].type === 'pass') {
      els.message.innerHTML = '<span class="gold">' + colorName(game.toMove) +
        ' has no moves — the turn passes.</span>';
      setTimeout(function () { playMove({ type: 'pass' }); }, 1100);
    }
  }

  function onVertexClick(ev) {
    var v = +ev.currentTarget.dataset.v;
    if (game.over() || aiThinking || !isHumanTurn()) return;

    if (game.relocsLeft > 0) {
      var e = game.enemy(game.toMove);
      if (game.board[v] === e) {
        selected = selected === v ? -1 : v;
        render();
      } else if (selected >= 0 && game.board[v] === EMPTY) {
        playMove({ type: 'relocate', from: selected, to: v });
      }
      return;
    }

    if (game.phase() === 'placement') {
      if (game.board[v] === EMPTY) playMove({ type: 'place', to: v });
      return;
    }

    // movement phase
    if (game.board[v] === game.toMove) {
      selected = selected === v ? -1 : v;
      render();
    } else if (selected >= 0 && game.board[v] === EMPTY && B.adj[selected].indexOf(v) >= 0) {
      playMove({ type: 'move', from: selected, to: v });
    }
  }

  // ---- buttons ------------------------------------------------------------

  function undo() {
    if (aiThinking || game.history.length === 0) return;
    game.undoMove();
    if (settings.mode === 'ai') {
      // rewind through the computer's moves (and its mill relocations) so the
      // human is back at their own decision point
      var guard = 0;
      while (game.history.length > 0 && game.toMove !== settings.humanColor && guard++ < 50) {
        game.undoMove();
      }
    }
    selected = -1;
    delete els.overlay.dataset.dismissed;
    render();
    scheduleNext();
  }

  function newGameFromDialog() {
    var form = els.formNew;
    settings.mode = form.elements.mode.value;
    settings.level = +form.elements.level.value;
    var colorChoice = form.elements.color.value;
    if (colorChoice === 'random') settings.humanColor = Math.random() < 0.5 ? RED : BLUE;
    else settings.humanColor = colorChoice === 'red' ? RED : BLUE;

    game = new K.Game();
    selected = -1;
    aiThinking = false;
    delete els.overlay.dataset.dismissed;
    render();

    if (settings.mode === 'ai' && settings.humanColor !== RED) {
      // tell the player which color they got before the computer starts
      els.message.innerHTML = colorChoice === 'random'
        ? 'You play <span class="gold">' + colorName(settings.humanColor) + '</span>. Red begins.'
        : '';
    }
    scheduleNext();
  }

  // ---- init -----------------------------------------------------------------

  function init() {
    ['board', 'turnChip', 'turnText', 'phaseText', 'message', 'dotsRed', 'dotsBlue',
     'btnSkip', 'btnUndo', 'btnNew', 'overlay', 'overlayTitle', 'overlaySub',
     'btnOverlayNew', 'btnOverlayClose', 'dlgNew', 'formNew', 'fsColor', 'fsLevel',
     'levelHint'].forEach(function (id) { els[id] = document.getElementById(id); });

    buildBoard();
    game = new K.Game();
    render();

    els.btnUndo.addEventListener('click', undo);
    els.btnSkip.addEventListener('click', function () {
      if (!game.over() && game.relocsLeft > 0 && isHumanTurn() && !aiThinking) {
        playMove({ type: 'skip' });
      }
    });
    els.btnNew.addEventListener('click', function () { els.dlgNew.showModal(); });
    els.btnOverlayNew.addEventListener('click', function () { els.dlgNew.showModal(); });
    els.btnOverlayClose.addEventListener('click', function () {
      els.overlay.dataset.dismissed = '1';
      els.overlay.classList.add('hidden');
    });

    // dialog behavior: mode toggles color/level fieldsets; level hint text
    els.formNew.addEventListener('change', function () {
      var twoP = els.formNew.elements.mode.value === '2p';
      els.fsColor.classList.toggle('disabled', twoP);
      els.fsLevel.classList.toggle('disabled', twoP);
      els.levelHint.textContent = LEVEL_HINTS[+els.formNew.elements.level.value];
    });
    els.formNew.addEventListener('submit', function () { newGameFromDialog(); });

    els.dlgNew.showModal();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
