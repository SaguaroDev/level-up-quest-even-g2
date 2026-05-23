# Level Up Quest

Even Realities G2 habit-tracking app. Pick four daily quests at setup, complete all four before midnight UTC, your streak grows by one. Miss any quest, streak resets to zero.

The exercises shown by default (run, pushups, situps, squats) are placeholders. You pick from a small library and lock the set in at setup. The set only changes if you reset the app, which also zeros your streak.

## Health disclaimer

Level Up Quest is a habit-tracking game. The exercises you choose to perform are your responsibility. Consult a physician before beginning any exercise program. The authors accept no responsibility for injury, illness, or any consequence of following self-selected quests.

## Mechanics

- Four quests, locked at setup
- Tap to highlight, long-press to check off
- Streak +1 if all four are checked at UTC midnight rollover
- Streak resets to 0 if any quest is missed
- All state persists on-device via the Even Hub SDK's local storage — no servers, no accounts, no tracking
- Reset (from Settings) zeroes streak, best streak, total days, and lets you re-pick your four quests

## Screens

| Screen | Purpose |
|---|---|
| Disclaimer | First-launch health acceptance (one-time) |
| Setup — Pick | Choose 4 quests from the library |
| Setup — Confirm | Lock in the four-quest set |
| Today | Daily check-off, streak, countdown to UTC reset |
| Stats | Current streak, best streak, total days cleared |
| Settings | Full reset (clears streak) |

## Controls

| Gesture | Action |
|---|---|
| Single tap | Advance highlight |
| Long press | Toggle / confirm / accept |
| Swipe down | Next screen (forward) |
| Swipe up | Previous screen (back) |
| Double tap | Exit app |

## Quest library

Run · Pushups · Situps · Squats · Pullups · Plank · Meditate · Read · Water

## Develop

```bash
npm install
npm run dev                                     # browser companion at http://localhost:5173
npx evenhub-simulator http://localhost:5173     # desktop simulator
ipconfig getifaddr en1                          # find LAN IP
npx evenhub qr --url http://<lan-ip>:5173       # scan in Even Hub companion app on phone
```

## Build for distribution

```bash
npm run build
npm run pack                                    # produces .ehpk for Even Hub upload
```

## Tech notes

- `@evenrealities/even_hub_sdk` 0.0.10
- TypeScript / Vite
- All state in `bridge.setLocalStorage("luq.state", ...)` — survives app restart
- Background→foreground state position falls back to Today on resume (cold-restart state preserved). The `setBackgroundState` / `onBackgroundRestore` API documented in the everything-evenhub skill catalog is not yet exposed by the public SDK at this version; will wire in once available.
- UTC midnight rollover detected on `FOREGROUND_ENTER_EVENT` and on a 30s timer while the Today screen is open

## Tips

BTC: `bc1qcrrrg6qhd2v9ar6c2u4megq4fc0d06rkkyt4hn`
PayPal: [paypal.me/SaguaroDev](https://paypal.me/SaguaroDev)

## License

MIT
