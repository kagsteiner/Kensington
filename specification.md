Build a beautiful, client-only web app that implements the game "Kensington" as described in this wikipedia page:

https://en.wikipedia.org/wiki/Kensington_(game)

## Features

- Human can play against the computer or against another human
- If played against the computer, human can choose between red and blue color and random assignment of the color; let's assume red always begins (unless the document says otherwise)
- Strong game engine, probably alpha-beta with 5 levels of difficulty
- precise representation of the kensington board. This board has a tricky structure that is hard to represent on the screen and hard to represent for the engine. Please think thoroughly what the best representation is. It may well be that the visual representation and the representation for the engine are vastly different. Once you have decided on a representation, check again whether it really represents the board. I have copied the board as Kensington_board.svg to the project folder.
- Beautifully rendered red and blue stones. In the real game these were flat cylinders of a slightly translucent material.

## Architecture

* implemented as HTML+Javascript+CSS, no dependencies
* full test suite of automatic tests of the game engine

