# Pipeline Tycoon (CLI)

The idle data-pipeline game from [ry-mart.com](https://ry-mart.com/games/pipeline-tycoon), in your
terminal. Start with an intern copy-pasting CSVs; end by integrating the planet.

```sh
npx @rymart/pipeline-tycoon
```

Needs Node 20 or newer and a terminal at least 80×24.

## Same save as the web

Your progress lives on the server, so the browser and the terminal play the **same game**:

- **Already playing in a browser?** Open the game, go to **Stats → Play in your terminal → Show a
  link code**, then run `npx @rymart/pipeline-tycoon link <CODE>`.
- **Started here and want the browser?** Run `npx @rymart/pipeline-tycoon code`, then in the web
  game go to **Stats → Have a code from another device?**

One device plays at a time: starting on one pauses the other.

## Keys

| Key               |                                                       |
| ----------------- | ----------------------------------------------------- |
| `space` / `enter` | process records                                       |
| `1`–`0`           | build a generator tier (`x` switches ×1 / ×10 / ×100) |
| `tab` / `←` `→`   | Build · Upgrades · Migrate · Stats                    |
| letters           | buy the upgrade with that letter (Upgrades tab)       |
| `g`               | catch the golden packet ◆ while it's on screen        |
| `m` `m`           | platform migration (Migrate tab)                      |
| `c`               | show a link code for a browser (Stats tab)            |
| `s`               | save now                                              |
| `q`               | save and quit                                         |

## Commands

```
pipeline-tycoon               play
pipeline-tycoon link <CODE>   join the game from your browser
pipeline-tycoon code          show a code to open this game in a browser
pipeline-tycoon unlink        forget the game on this computer
  --no-color                  plain text (NO_COLOR is respected too)
```

Your player's key is kept in `~/.config/pipeline-tycoon/config.json` (`%APPDATA%` on Windows),
readable only by you.

If the game says it's out of date, run `npx @rymart/pipeline-tycoon@latest`.
