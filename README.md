# Wonderlab

Experiments in what a browser can do, in plain HTML, CSS and JavaScript. No libraries, no images, no build step: every pixel is computed live in the browser.

## Experiments

| # | Experiment | What it is |
|---|---|---|
| 01 | [Murmuration](murmuration/) | 12,000 starlings flocking over a marsh at dusk, each steering by its seven nearest neighbours. You fly the falcon. |

## Run locally

Open `index.html` in a browser. No server or install needed.

## Structure

- `index.html`, `style.css`: the gallery page
- `shared/`: the small UI kit every experiment uses (press <kbd>H</kbd> in any experiment to hide its interface)
- `assets/thumbs/`: gallery card images
- `<experiment>/`: one self-contained folder per experiment

## Adding an experiment

1. Create a folder with its own `index.html` that links `../shared/wonderlab.css` and `../shared/wonderlab.js`.
2. Copy the card `<li>` in `index.html` and point it at the new folder.
3. Push. Vercel redeploys automatically.

## Deploy

It's a static site. On Vercel, pick the "Other" framework preset, leave the build command empty and keep the output directory as the repository root.
