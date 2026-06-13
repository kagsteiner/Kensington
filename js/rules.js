/*
 * Kensington game rules.
 *
 * Summary (per the Wikipedia description of the game):
 *  - Red and Blue each have 15 tokens. Red places first.
 *  - Placement phase: players alternately place a token on an empty vertex
 *    until all 30 tokens are on the board.
 *  - Movement phase: players alternately slide one of their tokens along a
 *    line to an adjacent empty vertex. A player with no legal move passes
 *    and the opponent moves again.
 *  - Mills: a player whose placement/slide makes a triangle entirely their
 *    color may relocate ONE enemy token to any empty vertex ("mill");
 *    completing a square allows relocating TWO ("double mill"). No more than
 *    two tokens may be relocated in a single turn, even when several figures
 *    are completed at once. Relocation may be declined (skip).
 *  - Win: be the first to occupy all six vertices of a white hexagon or a
 *    hexagon of your own color. This can happen in either phase.
 *  - Draws (pragmatic additions, not in the original rules): threefold
 *    repetition of a position in the movement phase, or both players passing
 *    in succession.
 *
 * Moves are plain objects:
 *   {type:'place',    to}        — placement phase
 *   {type:'move',     from, to}  — movement phase, along an edge
 *   {type:'relocate', from, to}  — mill payoff: move an ENEMY token anywhere
 *   {type:'skip'}                — decline remaining relocations
 *   {type:'pass'}                — movement phase, no legal slide available
 */
(function (global, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./board.js'));
  } else {
    global.KRules = factory(global.KBoard);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (KBoard) {
  'use strict';

  var EMPTY = 0, RED = 1, BLUE = 2;
  var PIECES_PER_PLAYER = 15;
  var MAX_RELOCATIONS = 2;

  // hexagon color name -> player number that may win on it (0 = both/white)
  function hexOwner(color) { return color === 'red' ? RED : color === 'blue' ? BLUE : 0; }

  function Game(board) {
    this.B = board || KBoard;
    this.board = new Uint8Array(this.B.N);   // EMPTY / RED / BLUE per vertex
    this.toMove = RED;
    this.placed = [0, 0, 0];                 // indexed by color
    this.relocsLeft = 0;                     // pending mill relocations owed by toMove
    this.winner = 0;
    this.winHex = -1;                        // index of the winning hexagon
    this.draw = false;
    this.drawReason = null;
    this.passes = 0;                         // consecutive passes
    this.rep = new Map();                    // position key -> occurrence count
    this.history = [];
    this.lastMove = null;
    this.lastMill = [];                      // figures completed by the last move (for UI)
  }

  Game.prototype.enemy = function (c) { return 3 - c; };

  Game.prototype.phase = function () {
    return this.placed[RED] + this.placed[BLUE] < 2 * PIECES_PER_PLAYER ? 'placement' : 'movement';
  };

  Game.prototype.over = function () { return this.winner !== 0 || this.draw; };

  Game.prototype.legalMoves = function () {
    if (this.over()) return [];
    var moves = [], i, n = this.B.N;
    if (this.relocsLeft > 0) {
      var e = this.enemy(this.toMove);
      var empties = [];
      for (i = 0; i < n; i++) if (this.board[i] === EMPTY) empties.push(i);
      for (i = 0; i < n; i++) {
        if (this.board[i] === e) {
          for (var j = 0; j < empties.length; j++) {
            moves.push({ type: 'relocate', from: i, to: empties[j] });
          }
        }
      }
      moves.push({ type: 'skip' });
      return moves;
    }
    if (this.phase() === 'placement') {
      for (i = 0; i < n; i++) if (this.board[i] === EMPTY) moves.push({ type: 'place', to: i });
      return moves;
    }
    for (i = 0; i < n; i++) {
      if (this.board[i] === this.toMove) {
        var nbs = this.B.adj[i];
        for (var k = 0; k < nbs.length; k++) {
          if (this.board[nbs[k]] === EMPTY) moves.push({ type: 'move', from: i, to: nbs[k] });
        }
      }
    }
    if (moves.length === 0) moves.push({ type: 'pass' });
    return moves;
  };

  Game.prototype.isLegal = function (m) {
    return this.legalMoves().some(function (x) {
      return x.type === m.type && x.from === m.from && x.to === m.to;
    });
  };

  /*
   * Applies a move and returns an undo record. No legality check is done
   * here (the engine only generates legal moves); use isLegal() for input
   * validation if needed.
   */
  Game.prototype.applyMove = function (m) {
    var rec = {
      m: m, toMove: this.toMove, relocsLeft: this.relocsLeft,
      winner: this.winner, winHex: this.winHex,
      draw: this.draw, drawReason: this.drawReason, passes: this.passes,
      repKey: null, lastMove: this.lastMove, lastMill: this.lastMill
    };
    var c = this.toMove;
    this.lastMove = m;
    this.lastMill = [];

    switch (m.type) {
      case 'place':
        this.board[m.to] = c;
        this.placed[c]++;
        this.passes = 0;
        this._afterOwnAction(c, m.to, rec);
        break;
      case 'move':
        this.board[m.from] = EMPTY;
        this.board[m.to] = c;
        this.passes = 0;
        this._afterOwnAction(c, m.to, rec);
        break;
      case 'relocate': {
        var e = this.enemy(c);
        this.board[m.from] = EMPTY;
        this.board[m.to] = e;
        this.relocsLeft--;
        this.passes = 0;
        // a relocation places an ENEMY token: it can never trigger mills, but
        // it could (foolishly) complete a hexagon for the enemy
        var wh = this._winHexAt(e, m.to);
        if (wh >= 0) {
          this.winner = e;
          this.winHex = wh;
        } else if (this.relocsLeft === 0) {
          this._endTurn(rec);
        }
        break;
      }
      case 'skip':
        this.relocsLeft = 0;
        this._endTurn(rec);
        break;
      case 'pass':
        this.passes++;
        if (this.passes >= 2) {
          this.draw = true;
          this.drawReason = 'stalemate';
        } else {
          this._endTurn(rec);
        }
        break;
      default:
        throw new Error('unknown move type ' + m.type);
    }
    this.history.push(rec);
    return rec;
  };

  // common handling after the mover gained vertex `to`: win check, then mills
  Game.prototype._afterOwnAction = function (c, to, rec) {
    var wh = this._winHexAt(c, to);
    if (wh >= 0) {
      this.winner = c;
      this.winHex = wh;
      return;
    }
    var B = this.B, grants = 0, mills = [];
    var tris = B.trianglesAt[to];
    for (var i = 0; i < tris.length; i++) {
      var t = B.triangles[tris[i]];
      if (this.board[t[0]] === c && this.board[t[1]] === c && this.board[t[2]] === c) {
        grants += 1;
        mills.push({ type: 'triangle', verts: t });
      }
    }
    var sqs = B.squaresAt[to];
    for (i = 0; i < sqs.length; i++) {
      var s = B.squares[sqs[i]];
      if (this.board[s[0]] === c && this.board[s[1]] === c &&
          this.board[s[2]] === c && this.board[s[3]] === c) {
        grants += 2;
        mills.push({ type: 'square', verts: s });
      }
    }
    grants = Math.min(grants, MAX_RELOCATIONS, this.placed[this.enemy(c)]);
    this.lastMill = mills;
    if (grants > 0) {
      this.relocsLeft = grants; // same player relocates before the turn ends
    } else {
      this._endTurn(rec);
    }
  };

  Game.prototype._endTurn = function (rec) {
    this.toMove = this.enemy(this.toMove);
    if (this.phase() === 'movement') {
      var key = this._posKey();
      var count = (this.rep.get(key) || 0) + 1;
      this.rep.set(key, count);
      rec.repKey = key;
      if (count >= 3) {
        this.draw = true;
        this.drawReason = 'repetition';
      }
    }
  };

  // hexagon won by color c when it just gained vertex v, or -1
  Game.prototype._winHexAt = function (c, v) {
    var hi = this.B.hexAt[v];
    if (hi < 0) return -1;
    var h = this.B.hexes[hi];
    var owner = hexOwner(h.color);
    if (owner !== 0 && owner !== c) return -1; // can't win on the opponent's hexagon
    for (var i = 0; i < 6; i++) if (this.board[h.verts[i]] !== c) return -1;
    return hi;
  };

  Game.prototype._posKey = function () {
    return this.toMove + ':' + this.board.join('');
  };

  Game.prototype.undoMove = function () {
    var rec = this.history.pop();
    if (!rec) return null;
    var m = rec.m;
    switch (m.type) {
      case 'place':
        this.board[m.to] = EMPTY;
        this.placed[rec.toMove]--;
        break;
      case 'move':
        this.board[m.to] = EMPTY;
        this.board[m.from] = rec.toMove;
        break;
      case 'relocate':
        this.board[m.to] = EMPTY;
        this.board[m.from] = 3 - rec.toMove;
        break;
      case 'skip':
      case 'pass':
        break;
    }
    if (rec.repKey !== null) {
      var n = this.rep.get(rec.repKey) - 1;
      if (n <= 0) this.rep.delete(rec.repKey); else this.rep.set(rec.repKey, n);
    }
    this.toMove = rec.toMove;
    this.relocsLeft = rec.relocsLeft;
    this.winner = rec.winner;
    this.winHex = rec.winHex;
    this.draw = rec.draw;
    this.drawReason = rec.drawReason;
    this.passes = rec.passes;
    this.lastMove = rec.lastMove;
    this.lastMill = rec.lastMill;
    return rec;
  };

  Game.prototype.clone = function () {
    var g = new Game(this.B);
    g.board.set(this.board);
    g.toMove = this.toMove;
    g.placed = this.placed.slice();
    g.relocsLeft = this.relocsLeft;
    g.winner = this.winner;
    g.winHex = this.winHex;
    g.draw = this.draw;
    g.drawReason = this.drawReason;
    g.passes = this.passes;
    this.rep.forEach(function (v, k) { g.rep.set(k, v); });
    g.lastMove = this.lastMove;
    g.lastMill = this.lastMill;
    return g;
  };

  return {
    Game: Game,
    EMPTY: EMPTY,
    RED: RED,
    BLUE: BLUE,
    PIECES_PER_PLAYER: PIECES_PER_PLAYER,
    MAX_RELOCATIONS: MAX_RELOCATIONS,
    hexOwner: hexOwner
  };
});
