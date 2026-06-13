#!/usr/bin/env node
/*
 * Kensington self-play CLI — pit two evaluation variants against each other.
 *
 * Usage:
 *   node tools/selfplay.js [options]
 *
 * Options:
 *   --a <name>        weight set for contestant A   (default: base)
 *   --b <name>        weight set for contestant B   (default: block)
 *   --games <n>       number of games               (default: 100)
 *   --depth <n>       fixed search depth for both   (default: 3)
 *   --random <n>      neutral random opening plies   (default: 6)
 *   --seed <n>        base seed                      (default: 1000)
 *   --maxplies <n>    cap per game (then scored draw) (default: 250)
 *   --noise <x>       root score noise for both      (default: 0)
 *   --quiet           only print the final summary
 *   --list            list the available weight sets and exit
 *
 * A "weight set" is an overrides object on top of the engine's `base`
 * weights (any feature you don't mention keeps its base value). Add your own
 * ideas to VARIANTS below and run them against `base` — if a change really
 * helps, it should score clearly above 0.5 over a few hundred games.
 *
 * The full feature list lives in js/engine.js (the FEATURES array).
 */
'use strict';

var KEngine = require('../js/engine.js');
var KArena = require('../js/arena.js');

// ---------------------------------------------------------------------------
// Candidate evaluation variants. Edit freely; each is an overrides object.
// ---------------------------------------------------------------------------
var VARIANTS = {
  // the current engine, unchanged (all base weights)
  base: {},

  // Anticipate double threats: reward holding two strong hexagons at once, so
  // a shallow search steers toward (and away from) unstoppable double threats
  // before they are one move from winning.
  block: { multiThreat: 260 },

  // Same idea, stronger, plus a little more value on a deep single threat.
  block2: { multiThreat: 400, hex4: 150 },

  // Reshape the hexagon curve to be more aggressive about near-complete
  // hexagons (steeper at 4-5 stones).
  steep: { hex4: 160, hex5: 520, dirty4: 60, dirty5: 200 },

  // Value mobility and mill threats more in the movement phase.
  active: { mobility: 4, triThreat: 14, sqThreat: 22 },

  // Idea 1: steer toward hexagons that are actually a few slides from
  // completion ("moves to win, if the opponent does nothing").
  reach: { winReach: 6 },

  // Idea 2: an unblockable open mill is a huge weapon; a blockable one is
  // nearly worthless (its base triThreat of 8 is cancelled by millBlocked).
  livemill: { millLive: 24, millBlocked: -7 },

  // Both ideas together, plus double-threat awareness.
  goal: { winReach: 6, millLive: 24, millBlocked: -7, multiThreat: 200 },

  // Idea-2 ablations: bonus only vs. a stronger bonus+penalty.
  liveonly: { millLive: 24 },
  livemill2: { millLive: 40, millBlocked: -12 },

  // Value the *running* mill (closed + safely swingable) highly, and keep the
  // open-mill bonus modest so the engine prefers to close and swing rather than
  // sit on a static threat.
  running: { millRunning: 40, millClosed: 4, millLive: 8, millBlocked: -6 },

  // The full "swing then build" plan: a running mill to scatter the opponent
  // plus winReach to steer toward completing a hexagon.
  swarm: { millRunning: 40, millClosed: 4, millLive: 8, millBlocked: -6, winReach: 6 },

  // Anti-scatter: reward keeping your own stones clustered (able to combine).
  coord: { coordination: 3 },

  // Everything together: swing-then-build plus the anti-scatter term.
  swarm2: { millRunning: 40, millClosed: 4, millLive: 8, millBlocked: -6, winReach: 6, coordination: 3 }
};

// ---------------------------------------------------------------------------

function parseArgs(argv) {
  var o = {
    a: 'base', b: 'block', games: 100, depth: 3, random: 6,
    seed: 1000, maxplies: 250, noise: 0, quiet: false, list: false
  };
  for (var i = 2; i < argv.length; i++) {
    var k = argv[i];
    if (k === '--quiet') o.quiet = true;
    else if (k === '--list') o.list = true;
    else if (k === '--help' || k === '-h') { o.help = true; }
    else if (k.slice(0, 2) === '--') {
      var name = k.slice(2), val = argv[++i];
      if (['games', 'depth', 'random', 'seed', 'maxplies'].indexOf(name) >= 0) o[name] = parseInt(val, 10);
      else if (name === 'noise') o.noise = parseFloat(val);
      else o[name] = val;
    }
  }
  return o;
}

function pct(x) { return (100 * x).toFixed(1) + '%'; }

function main() {
  var o = parseArgs(process.argv);

  if (o.help) {
    console.log(require('fs').readFileSync(__filename, 'utf8').split('*/')[0].replace(/^[\s\S]*?\/\*/, ''));
    return;
  }
  if (o.list) {
    console.log('Available weight sets:');
    Object.keys(VARIANTS).forEach(function (n) {
      console.log('  ' + n.padEnd(10) + JSON.stringify(VARIANTS[n]));
    });
    return;
  }
  if (!VARIANTS[o.a]) { console.error('unknown weight set: ' + o.a); process.exit(1); }
  if (!VARIANTS[o.b]) { console.error('unknown weight set: ' + o.b); process.exit(1); }

  var search = { maxDepth: o.depth, timeMs: Infinity, noise: o.noise };
  var cfgA = Object.assign({ name: o.a, weights: VARIANTS[o.a] }, search);
  var cfgB = Object.assign({ name: o.b, weights: VARIANTS[o.b] }, search);

  console.log('Kensington self-play');
  console.log('  A = ' + o.a + '  ' + JSON.stringify(VARIANTS[o.a]));
  console.log('  B = ' + o.b + '  ' + JSON.stringify(VARIANTS[o.b]));
  console.log('  games=' + o.games + ' depth=' + o.depth + ' random=' + o.random +
    ' seed=' + o.seed + ' noise=' + o.noise);
  console.log('');

  var t0 = Date.now();
  var res = KArena.runMatch(cfgA, cfgB, {
    games: o.games, seed: o.seed, randomPlies: o.random, maxPlies: o.maxplies,
    onGame: o.quiet ? null : function (i, r, agg) {
      var w = r.winner === 0 ? 'draw' : (r.winner === 1 ? 'red' : 'blue') + ' (' + r.winHexColor + ')';
      var line = 'game ' + String(i + 1).padStart(3) + '  ' + w.padEnd(14) +
        ' ' + String(r.plies).padStart(3) + ' plies' +
        '   running A: ' + agg.aWins + '-' + agg.bWins + '-' + agg.draws +
        ' (' + pct((agg.aWins + agg.draws / 2) / agg.games) + ')';
      process.stdout.write('\r' + line.padEnd(78));
    }
  });
  var secs = (Date.now() - t0) / 1000;
  if (!o.quiet) process.stdout.write('\n\n');

  console.log('Result (A = ' + res.a + ' vs B = ' + res.b + ', ' + res.games + ' games)');
  console.log('  A wins : ' + res.aWins + '   (as red ' + res.aWinsAsRed + ', as blue ' + res.aWinsAsBlue + ')');
  console.log('  B wins : ' + res.bWins + '   (as red ' + res.bWinsAsRed + ', as blue ' + res.bWinsAsBlue + ')');
  console.log('  draws  : ' + res.draws + (Object.keys(res.drawReasons).length ? '  ' + JSON.stringify(res.drawReasons) : ''));
  console.log('  score for A : ' + pct(res.score) + ' ± ' + pct(res.stderr) +
    '   (0.5 = even; > 0.5 means A is stronger)');
  console.log('  avg game    : ' + res.avgPlies.toFixed(1) + ' plies');
  console.log('  speed       : ' + secs.toFixed(1) + 's, ' +
    (res.nodes / 1e6).toFixed(1) + 'M nodes, ' +
    Math.round(res.nodes / Math.max(secs, 0.001) / 1000) + 'k nodes/s');
}

main();
