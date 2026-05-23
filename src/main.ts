import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
  ImuReportPace,
} from '@evenrealities/even_hub_sdk'

// ─── Quest library ───────────────────────────────────────────────────────────
type QuestDef = {
  id: string
  label: string        // displayed label, padded to fit
  target: number
  unit: string         // '', 'km', 'min'
  increment: number    // value added per tap
  decimals: number     // display precision
}

const QUEST_LIBRARY: Record<string, QuestDef> = {
  pushups:  { id: 'pushups',  label: 'PUSH-UPS', target: 100, unit: '',    increment: 5,   decimals: 0 },
  situps:   { id: 'situps',   label: 'SIT-UPS',  target: 100, unit: '',    increment: 5,   decimals: 0 },
  squats:   { id: 'squats',   label: 'SQUATS',   target: 100, unit: '',    increment: 5,   decimals: 0 },
  run:      { id: 'run',      label: 'RUN',      target: 10,  unit: 'km',  increment: 0.5, decimals: 1 },
  pullups:  { id: 'pullups',  label: 'PULL-UPS', target: 20,  unit: '',    increment: 1,   decimals: 0 },
  plank:    { id: 'plank',    label: 'PLANK',    target: 5,   unit: 'min', increment: 1,   decimals: 0 },
  meditate: { id: 'meditate', label: 'MEDITATE', target: 10,  unit: 'min', increment: 1,   decimals: 0 },
  pages:    { id: 'pages',    label: 'READ',     target: 30,  unit: 'pg',  increment: 5,   decimals: 0 },
  water:    { id: 'water',    label: 'WATER',    target: 8,   unit: 'gl',  increment: 1,   decimals: 0 },
}

const DEFAULT_QUEST_IDS = ['pushups', 'situps', 'squats', 'run']

// ─── State shape ─────────────────────────────────────────────────────────────
type Quest = { id: string; progress: number }
type State = {
  disclaimerAccepted: boolean
  quests: Quest[]
  streak: number
  best: number
  totalDays: number
  lastResetUTC: number
}

function makeInitial(): State {
  return {
    disclaimerAccepted: false,
    quests: DEFAULT_QUEST_IDS.map(id => ({ id, progress: 0 })),
    streak: 0,
    best: 0,
    totalDays: 0,
    lastResetUTC: utcDayStart(Date.now()),
  }
}

let state: State = makeInitial()

// ─── Screen / runtime ────────────────────────────────────────────────────────
type Screen = 'disclaimer' | 'today' | 'leaderboard'
let screen: Screen = 'disclaimer'
let cursor = 0            // highlighted quest index on Today
let compassHeading = ''   // updated from IMU; empty until first sample

// ─── Persistence ─────────────────────────────────────────────────────────────
const STORAGE_KEY = 'luq.state'

async function loadState(bridge: any): Promise<void> {
  try {
    const raw = await bridge.getLocalStorage(STORAGE_KEY)
    if (raw && typeof raw === 'string' && raw.length > 0) {
      const parsed = JSON.parse(raw) as Partial<State>
      state = { ...makeInitial(), ...parsed }
      // Ensure quest array is well-formed.
      if (!Array.isArray(state.quests) || state.quests.length !== 4) {
        state.quests = DEFAULT_QUEST_IDS.map(id => ({ id, progress: 0 }))
      }
    }
  } catch (err) {
    console.error('loadState parse failure, using defaults:', err)
    state = makeInitial()
  }
}

let savePending: Promise<unknown> = Promise.resolve()
function persistState(bridge: any): void {
  savePending = savePending.then(() => bridge.setLocalStorage(STORAGE_KEY, JSON.stringify(state)))
}

// ─── Date math (UTC midnight rollover) ───────────────────────────────────────
function utcDayStart(ms: number): number {
  const d = new Date(ms)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

function msUntilNextUtcMidnight(now: number): number {
  return utcDayStart(now) + 86_400_000 - now
}

function formatCountdown(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function formatLocalClock(now: number): string {
  const d = new Date(now)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function isQuestDone(q: Quest): boolean {
  const def = QUEST_LIBRARY[q.id]
  return def != null && q.progress >= def.target
}

function rolloverIfNeeded(now: number): boolean {
  const today = utcDayStart(now)
  if (today <= state.lastResetUTC) return false
  const allDone = state.quests.every(isQuestDone)
  if (allDone) {
    state.streak += 1
    state.totalDays += 1
    if (state.streak > state.best) state.best = state.streak
  } else {
    state.streak = 0
  }
  state.quests = state.quests.map(q => ({ id: q.id, progress: 0 }))
  state.lastResetUTC = today
  return true
}

// ─── Bridge + container ──────────────────────────────────────────────────────
const SCREEN_W = 576
const SCREEN_H = 288

const bridge = await waitForEvenAppBridge()
await loadState(bridge)

if (!state.disclaimerAccepted) screen = 'disclaimer'
else screen = 'today'

if (rolloverIfNeeded(Date.now())) persistState(bridge)

const mainBox = new TextContainerProperty({
  xPosition: 0, yPosition: 0, width: SCREEN_W, height: SCREEN_H,
  borderWidth: 0, borderColor: 5, paddingLength: 4,
  containerID: 1, containerName: 'main',
  content: render(),
  isEventCapture: 1,
})

const created = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({ containerTotalNum: 1, textObject: [mainBox] }),
)
if (created !== 0) console.error('createStartUpPageContainer failed:', created)

// Turn on IMU at low rate for the compass corner. The display is text-only so
// 100 Hz is wasteful — we only need a heading sample every ~500ms.
try {
  await bridge.imuControl(true, ImuReportPace.P100)
} catch (err) {
  console.warn('imuControl failed; compass corner stays empty:', err)
}

// ─── Render ──────────────────────────────────────────────────────────────────
//
// Layout target — corner widgets + center content:
//
//   CLOCK                                                STREAK
//
//                  DAILY QUEST
//                  ─ PUSH-UPS    [42/100]
//                  ─ SIT-UPS     [100/100]
//                  ─ SQUATS      [12/100]
//                  ─ RUN         [3.2/10km]
//
//   COMPASS                                              COUNTDOWN
//
// Width budget: 576px / ~10px per monospace char ≈ 57 chars/line. Inner width
// after 4px padding ≈ 56 chars. Height budget: 288 / 27px line height ≈ 10 lines.
// Layout below is 9 lines including blank rows.

function render(): string {
  switch (screen) {
    case 'disclaimer':  return renderDisclaimer()
    case 'today':       return renderToday()
    case 'leaderboard': return renderLeaderboard()
  }
}

// Pad/truncate a string to a fixed display width.
function pad(s: string, width: number, align: 'left' | 'right' = 'left'): string {
  if (s.length >= width) return s.slice(0, width)
  const fill = ' '.repeat(width - s.length)
  return align === 'left' ? s + fill : fill + s
}

// Build a line with left and right widgets at the edges, blank middle.
function edges(left: string, right: string, totalWidth = 56): string {
  const room = totalWidth - left.length - right.length
  if (room <= 0) return (left + right).slice(0, totalWidth)
  return left + ' '.repeat(room) + right
}

function questLine(q: Quest, indent: string, highlighted: boolean): string {
  const def = QUEST_LIBRARY[q.id]
  if (!def) return ''
  const prog = def.decimals === 0
    ? `${Math.floor(q.progress)}/${def.target}${def.unit}`
    : `${q.progress.toFixed(def.decimals)}/${def.target}${def.unit}`
  const marker = highlighted ? '>' : ' '
  const labelCol = pad(`${marker} ${def.label}`, 14)
  return `${indent}${labelCol}  [${prog}]`
}

function renderDisclaimer(): string {
  return [
    '         LEVEL UP QUEST',
    '',
    '  A habit-tracking game. The exercises',
    '  you choose are your responsibility.',
    '',
    '  Consult a physician before any',
    '  exercise program. We accept no',
    '  responsibility for injury, illness,',
    '  or any consequence of following',
    '  self-selected quests.',
    '',
    '         tap to accept',
  ].join('\n')
}

function renderToday(): string {
  const now = Date.now()
  const clock = formatLocalClock(now)
  const streak = `x${state.streak}`
  const compass = compassHeading || '--'
  const countdown = formatCountdown(msUntilNextUtcMidnight(now))

  const lines: string[] = []
  lines.push(edges(clock, streak))
  lines.push('')
  lines.push('         DAILY QUEST')
  lines.push('')
  state.quests.forEach((q, i) => lines.push(questLine(q, '         ', i === cursor)))
  lines.push('')
  const allDone = state.quests.every(isQuestDone)
  if (allDone) {
    lines.push('     ALL CLEAR — streak banks at 00:00 UTC')
  } else {
    lines.push('     swipe: highlight  tap: +rep  dbl-tap: board')
  }
  lines.push(edges(compass, countdown))
  return lines.join('\n')
}

function renderLeaderboard(): string {
  // No backend yet. Placeholder shows local-only stats.
  return [
    '         LEADERBOARD',
    '',
    `  Current streak     ${state.streak}`,
    `  Best streak        ${state.best}`,
    `  Total days cleared ${state.totalDays}`,
    '',
    '  (Global leaderboard coming soon.)',
    '',
    '         double-tap to return',
  ].join('\n')
}

// ─── Render queue ────────────────────────────────────────────────────────────
let rendering: Promise<unknown> = Promise.resolve()
function refresh(): void {
  rendering = rendering.then(() =>
    bridge.textContainerUpgrade(
      new TextContainerUpgrade({ containerID: 1, containerName: 'main', content: render() }),
    ),
  )
}

// Tick clock + countdown + rollover check every 15s while on Today.
setInterval(() => {
  if (screen === 'today') {
    if (rolloverIfNeeded(Date.now())) persistState(bridge)
    refresh()
  }
}, 15_000)

// ─── Compass from IMU ────────────────────────────────────────────────────────
//
// Without a magnetometer we can't get true heading. The G2 IMU is accelerometer-
// only at the SDK level; gravity vector tells us pitch/roll but not yaw-relative-
// to-north. We synthesize an N/E/S/W approximation from accelerometer drift over
// time (rough but better than empty). For v1 we just display a placeholder string
// and update it from any incoming IMU sample. Replace with proper heading once
// magnetometer support lands.

let lastCompassUpdate = 0
function updateCompass(_x: number, _y: number, _z: number): void {
  // Placeholder — show a fixed cardinal until real heading derivation is wired.
  const now = Date.now()
  if (now - lastCompassUpdate < 2000) return
  lastCompassUpdate = now
  // Cycle through N/E/S/W as a "we are alive" signal; replace with real bearing.
  const cardinals = ['N ↑', 'E →', 'S ↓', 'W ←']
  compassHeading = cardinals[Math.floor(now / 5000) % 4]!
  if (screen === 'today') refresh()
}

// ─── Event handling ──────────────────────────────────────────────────────────
//
// Tap          → primary action (accept disclaimer / +rep on highlighted quest)
// Swipe up     → move highlight up
// Swipe down   → move highlight down
// Double-tap   → switch screens (today ↔ leaderboard)
// Long-press   → reserved by OS for app exit; we do not bind it
//
// Critical: CLICK_EVENT === 0. Protobuf omits zero-value fields, so the click
// event arrives with `eventType` either === 0 OR undefined. Coalesce with ?? 0
// before comparing or `=== OsEventTypeList.CLICK_EVENT` quietly fails on the
// undefined branch — which is exactly what bit us in v0.

const unsubscribe = bridge.onEvenHubEvent((event: any) => {
  // IMU samples — drive the compass corner.
  const rawSys = event.sysEvent?.eventType
  const sysType = rawSys ?? 0  // <-- coalesce missing-zero to actual zero
  const hasSys = event.sysEvent != null

  if (hasSys && sysType === OsEventTypeList.IMU_DATA_REPORT) {
    const d = event.sysEvent?.imuData
    if (d) updateCompass(d.x ?? 0, d.y ?? 0, d.z ?? 0)
    return
  }

  const textType = event.textEvent?.eventType ?? null

  // Double-tap → screen switch (NOT exit; OS long-press handles exit).
  if (
    (hasSys && sysType === OsEventTypeList.DOUBLE_CLICK_EVENT) ||
    textType === OsEventTypeList.DOUBLE_CLICK_EVENT
  ) {
    onDoubleTap()
    return
  }

  if (hasSys && sysType === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
    if (rolloverIfNeeded(Date.now())) persistState(bridge)
    refresh()
    return
  }

  // Swipe → move highlight.
  if (textType === OsEventTypeList.SCROLL_TOP_EVENT) {
    onSwipe(-1)
    return
  }
  if (textType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
    onSwipe(+1)
    return
  }

  // Single tap → primary action. CLICK_EVENT is value 0.
  if (hasSys && sysType === OsEventTypeList.CLICK_EVENT) {
    onTap()
    return
  }

  if (
    hasSys &&
    (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT ||
      sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT)
  ) {
    cleanup()
  }
})

function onTap(): void {
  if (screen === 'disclaimer') {
    state.disclaimerAccepted = true
    persistState(bridge)
    screen = 'today'
    cursor = 0
    refresh()
    return
  }

  if (screen === 'today') {
    // +increment on the highlighted quest.
    const q = state.quests[cursor]
    if (!q) return
    const def = QUEST_LIBRARY[q.id]
    if (!def) return
    q.progress = Math.min(def.target, q.progress + def.increment)
    persistState(bridge)
    refresh()
    return
  }

  // leaderboard: tap is a no-op for now
}

function onSwipe(delta: -1 | 1): void {
  if (screen !== 'today') return
  if (state.quests.length === 0) return
  const n = state.quests.length
  cursor = (cursor + delta + n) % n
  refresh()
}

function onDoubleTap(): void {
  if (screen === 'today') {
    screen = 'leaderboard'
    refresh()
    return
  }
  if (screen === 'leaderboard') {
    screen = 'today'
    refresh()
    return
  }
  // disclaimer: ignore — tap is the only path forward
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────
let cleanedUp = false
function cleanup(): void {
  if (cleanedUp) return
  cleanedUp = true
  unsubscribe()
  try { bridge.imuControl(false) } catch { /* noop */ }
}
window.addEventListener('beforeunload', cleanup)

// ─── Companion mirror (browser dev surface) ──────────────────────────────────
const app = document.querySelector<HTMLDivElement>('#app')!
app.innerHTML = `
  <main style="margin:auto;padding:24px;max-width:680px;box-sizing:border-box;">
    <header style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h1 style="font-size:18px;font-weight:600;margin:0;">Level Up Quest</h1>
      <span id="meta" style="font-size:12px;color:#919191;"></span>
    </header>
    <pre id="mirror" style="background:#0e1218;border:1px solid #2a3340;border-radius:12px;padding:20px;font:14px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre;color:#9fdc9f;margin:0;min-height:288px;"></pre>
    <footer style="font-size:12px;color:#7B7B7B;text-align:center;margin-top:16px;">
      tap: +rep · swipe up/down: leaderboard · double-tap: exit
    </footer>
  </main>
`

function mirrorCompanion(): void {
  const mirror = document.getElementById('mirror')
  const meta = document.getElementById('meta')
  if (mirror) mirror.textContent = render()
  if (meta) meta.textContent = `screen: ${screen}  ·  streak: ${state.streak}`
}
setInterval(mirrorCompanion, 1000)
mirrorCompanion()
