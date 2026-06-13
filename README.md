# Kensington

A client-only web implementation of the board game
[Kensington](https://en.wikipedia.org/wiki/Kensington_(game)) (Brian Taylor &
Peter Forbes, 1979). Plain HTML + CSS + JavaScript, no dependencies, no build
step.

## Vibe Coding warning

The app has been fully vibe coded by Claude Fable. I've reviewed the code, though
I cannot claim I have understood its full Rhombitrihexagonal tiling beauty. This
is clearly better code than I can write (although I write code since the early
80s. Oh my).

You can play the game in my homepage:

[Kensington app](https://agsteiner.neocities.org/appsngames/Kensington/)

## Run

Open `index.html` in any modern browser. Open `tests.html` to run the test
suite in the browser, or run it headlessly with:

```sh
node tests/run-tests.js
```

## The game

The board is a finite piece of the rhombitrihexagonal tiling: 7 hexagons
(2 red, 2 blue, 3 white), 30 squares and 24 triangles meeting at 72 points.

- Each player has 15 stones; Red begins.
- **Placement phase:** players alternately place stones on empty points.
- **Movement phase:** slide one of your stones along a line to an adjacent
  empty point. A player who cannot move passes, and the opponent moves again.
- **Mills:** completing a triangle in your color lets you relocate one enemy
  stone to any empty point; completing a square lets you relocate two. At most
  two relocations per turn; relocating may be declined.
- **Win** by occupying all six corners of a white hexagon or a hexagon of your
  own color (possible in either phase).
- Pragmatic draw rules (not part of the original game): threefold repetition,
  or both players being unable to move.

## Architecture

| File | Role |
| --- | --- |
| `js/board.js` | Board model. Generates the 72 vertices, 132 edges and all cells mathematically from the 7 hexagon centers, with a structural self-check (`verify()`). The same model drives the engine and the rendering. |
| `js/rules.js` | Game state, legal move generation, apply/undo, mills, win and draw detection. |
| `js/engine.js` | AI: iterative-deepening alpha-beta (negamax) with a transposition table, heuristic move ordering, and capped relocation branching. Evaluation is a weighted sum of named **features** (see below). Difficulty levels 1–5 map to depth/time budgets plus root-score noise at low levels. |
| `js/arena.js` | Headless self-play harness for comparing two evaluation variants (`playGame`, `runMatch`). |
| `js/ui.js` | SVG board rendering, interaction, AI scheduling. |
| `tests/tests.js` | Test suite (board structure, rules, fuzz/self-play invariants, engine tactics, eval framework). Runs in Node and the browser. |
| `tools/selfplay.js` | CLI front-end for the arena: `node tools/selfplay.js`. |

## Tuning the engine

The static evaluation is factored into two pieces so that different evaluations
can be tried without touching the search:

- `extractFeatures(g, out)` fills a vector of **raw, RED-perspective** features
  — each is `red_count − blue_count` of some board pattern (stones on a winnable
  hexagon by occupancy level, mill threats, square builds, mobility, tempo, …),
  so the vector is antisymmetric and one weight set serves both sides.
- `evaluate(g, weights)` is the dot product of that vector with a **weight set**,
  with the side-to-move sign applied.

A weight set is authored as an overrides object on the built-in `base` set
(anything you omit keeps its base value), so an experiment is usually one line.
Adding a brand-new idea is: append a name to the `FEATURES` array in
`js/engine.js`, compute it in the matching board sweep, and give it a weight.
The `base` set reproduces the original hand-tuned constants exactly, so the app
and tests are unaffected until you deliberately change a weight.

A few features are shipped switched **off** (weight 0 in `base`) as starting
points for experiments. They are computed only in the movement phase and only
when given a non-zero weight, so they cost nothing by default:

- `winReach` — "moves to win, if the opponent does nothing": for each winnable
  hexagon, `M` minus the estimated slides to bring stones onto its empty
  vertices (using precomputed all-pairs board distances).
- `millLive` / `millBlocked` — split an open mill (`2 own + 1 empty` triangle)
  by whether the opponent has a stone adjacent to the gap and can block it next
  move. A live (unblockable) mill is a strong weapon; a blockable one is not.

In quick self-play (depth 3, 150 games) the most useful of these so far is a
mild **penalty on blockable mills** (`{ millLive: 24, millBlocked: -7 }`, ~53%
vs `base`); the live-mill bonus alone is inert, `winReach` is roughly neutral as
formulated, and over-strong weights backfire. None are conclusive yet — they
are left for further tuning rather than turned on by default.

### Self-play

Compare two weight sets head-to-head, with no UI:

```sh
node tools/selfplay.js --a base --b block --games 200 --depth 3
node tools/selfplay.js --list          # show the built-in variants
```

Games are played in **color-swapped pairs from a shared opening** (common random
numbers), which cancels first-move advantage and cuts variance: identical
weight sets score exactly 50%. A variant that genuinely helps should score
clearly above 50% over a few hundred games. Search is fixed-depth
(`timeMs: Infinity`) so results don't depend on machine speed. Add your own
candidate weight sets to the `VARIANTS` table at the top of
[`tools/selfplay.js`](tools/selfplay.js).

> Note: at low depth the engine is very drawish — many games hit the ply cap
> (reported as `maxplies` draws) because it does not convert the movement phase
> well. That is itself a useful signal about where the evaluation needs work.

### Notes on the board representation

Visually the board is intricate, but combinatorially it is simple: in the
3.4.6.4 tiling every vertex belongs to exactly one hexagon-or-rim position,
one triangle, and one or two squares. The model is generated as the union of
seven "rosettes" (hexagon + 6 edge squares + 6 corner triangles), deduplicated
by coordinates, then renumbered. The engine sees only vertex ids, an adjacency
list, and the vertex lists of hexagons/squares/triangles; the UI reuses the
generated coordinates for drawing, so the two representations can never drift
apart.
