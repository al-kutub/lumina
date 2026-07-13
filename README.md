# LUMINA

Neon physics orb-merge game (Suika-style). Drop glowing orbs into a vessel — same-tier orbs fuse into the next tier. Climb the chain, chase combos, don’t overflow the danger line.

## Run

No build step. Open locally:

```bash
# from this folder
python3 -m http.server 5173
# then open http://localhost:5173
```

Or open `index.html` directly in a modern browser (CDN scripts need network for Matter.js + fonts on first load).

## Controls

- **Aim:** move mouse / drag finger horizontally
- **Drop:** click / tap (or release after aiming on touch)
- **Mute:** speaker button (top-right)

## Features

- 11 orb tiers (Spark → Lumina)
- Matter.js gravity + collisions
- Merge scoring with short combo window bonuses
- Game over after resting above the danger line (grace period)
- Best score in `localStorage`
- Procedural Web Audio SFX
- Responsive layout for phone widths

## Files

| File | Role |
|------|------|
| `index.html` | Shell, screens, HUD |
| `styles.css` | Cosmic neon UI |
| `game.js` | Physics, merge loop, audio, render |
| `README.md` | This file |
