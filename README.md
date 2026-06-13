# Kensington

A client-only web implementation of the board game
[Kensington](https://en.wikipedia.org/wiki/Kensington_(game)) (Brian Taylor &
Peter Forbes, 1979). Plain HTML + CSS + JavaScript, no dependencies, no build
step.

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
| `js/engine.js` | AI: iterative-deepening alpha-beta (negamax) with a transposition table, heuristic move ordering, and capped relocation branching. Difficulty levels 1–5 map to depth/time budgets plus root-score noise at low levels. |
| `js/ui.js` | SVG board rendering, interaction, AI scheduling. |
| `tests/tests.js` | Test suite (board structure, rules, fuzz/self-play invariants, engine tactics). Runs in Node and the browser. |

### Notes on the board representation

Visually the board is intricate, but combinatorially it is simple: in the
3.4.6.4 tiling every vertex belongs to exactly one hexagon-or-rim position,
one triangle, and one or two squares. The model is generated as the union of
seven "rosettes" (hexagon + 6 edge squares + 6 corner triangles), deduplicated
by coordinates, then renumbered. The engine sees only vertex ids, an adjacency
list, and the vertex lists of hexagons/squares/triangles; the UI reuses the
generated coordinates for drawing, so the two representations can never drift
apart.
