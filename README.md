# Level Up Quest

A Solo Leveling-style habit-tracking game for the Even Realities G2. The System hands you a Daily Quest. Clear it before UTC midnight or face a Penalty.

## The Daily Quest

The System dictates the quest set. You don't pick — Sung Jin-Woo didn't either.

```
[!] QUEST INFO — DAILY QUEST
TRAIN TO BECOME A FORMIDABLE COMBATANT

> [ ] PUSH-UPS                                [45/100]
  [x] SIT-UPS                                [100/100]
  [ ] SQUATS                                  [20/100]
  [ ] RUN                                   [3.5/10KM]
```

Tap to log progress on the highlighted goal. Swipe to move the highlight. Double-tap to flip between the Quest panel and your Hunter Status.

Clear all four before 00:00 UTC and the streak banks. Miss any goal and the Penalty Zone screen greets you on the next launch.

## Health disclaimer

A habit-tracking game. The exercises you choose to perform are your responsibility. Consult a physician before any exercise program. The authors accept no responsibility for injury, illness, or any consequence of following self-selected quests.

## Mechanics

- One fixed quest set: 100 push-ups, 100 sit-ups, 100 squats, 10 km run
- Tap on the highlighted goal adds an increment (5 reps, or 0.5 km)
- Clear all four by UTC midnight → streak +1, EXP awarded, day banked
- Miss any goal → Penalty Zone, streak resets to 0
- All state persists on-device via the Even Hub SDK's `setLocalStorage` — no servers, no accounts, no telemetry

## Hunter rank

| Rank | Streak required |
|---|---|
| E | 0 |
| D | 3 |
| C | 7 |
| B | 14 |
| A | 30 |
| S | 60 |

## EXP / Levels

- 100 base EXP per cleared day
- +10 EXP per day past streak 7 (compounding into a long run)
- 1000 EXP per level. Linear curve, no soft cap.

## Controls

| Gesture | Action |
|---|---|
| Single tap | +increment on highlighted goal (Quest screen) / advance dialog |
| Swipe up | Move highlight up |
| Swipe down | Move highlight down |
| Double tap | Cycle Quest ↔ Status |
| Long press | OS-reserved — opens system menu, never reaches the app |

The System doesn't let you walk out. To exit the app, use the OS long-press menu.

## Screens

- **Disclaimer** — first-launch health acceptance, one-time
- **Quest** — Daily Quest panel with header strip (rank · streak · countdown to UTC midnight)
- **Status** — Hunter level, EXP gauge, current/best streak, total days cleared, days to next rank
- **Quest Complete** — flashes once when you clear the daily; banks at UTC midnight
- **Penalty Zone** — shown once on the launch after a missed daily

## Develop

```bash
npm install
npm run dev                                          # browser companion at http://localhost:5173
npx evenhub-simulator http://localhost:5173          # desktop simulator (no IMU)
ipconfig getifaddr en1                               # find LAN IP
npx @evenrealities/evenhub-cli qr --url http://<lan-ip>:5173   # scan in Even Hub companion app
```

The Vite dev server may fall back to a port other than 5173 if 5173 is taken — use whatever port the `npm run dev` output prints.

## Build for distribution

```bash
npm run build
npm run pack                                         # produces .ehpk for Even Hub upload
```

## Tech notes

- `@evenrealities/even_hub_sdk` 0.0.10, TypeScript / Vite
- All state in `bridge.setLocalStorage("luq.state", ...)` — survives app restart
- UTC midnight rollover detected on `FOREGROUND_ENTER_EVENT` and on a 5-second timer while the Quest screen is open
- `setBackgroundState` / `onBackgroundRestore` not yet exposed by the public SDK at 0.0.10 — background→foreground in-session falls back to the Quest screen; cold-restart state is preserved via `setLocalStorage`

## Tips

BTC: `bc1qcrrrg6qhd2v9ar6c2u4megq4fc0d06rkkyt4hn`
PayPal: [paypal.me/SaguaroDev](https://paypal.me/SaguaroDev)

## License

MIT
