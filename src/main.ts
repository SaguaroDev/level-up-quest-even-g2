import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'

// ─── Solo Leveling Hunter System ─────────────────────────────────────────────
//
// One repeating Daily Quest set, dictated by the System (canon — the Hunter does
// not pick their quests). Tap on a goal adds an increment of progress. Clear all
// four before UTC midnight to gain EXP and grow your streak. Miss and the System
// imposes a Penalty — streak resets and a Penalty Zone screen greets you next.
//
// Ranks: E → D → C → B → A → S, gated by streak length.
// Display: 576 × 288 monochrome green, ~56 chars wide × ~10 lines tall.
//

type QuestDef = {
  id: string
  label: string
  target: number
  unit: string         // '', 'KM', 'MIN'
  increment: number    // value added per tap
  decimals: number     // display precision
}

// Solo Leveling canonical quest set. Same four every day. The System decides.
const QUESTS: QuestDef[] = [
  { id: 'pushups', label: 'PUSH-UPS', target: 100, unit: '',   increment: 5,   decimals: 0 },
  { id: 'situps',  label: 'SIT-UPS',  target: 100, unit: '',   increment: 5,   decimals: 0 },
  { id: 'squats',  label: 'SQUATS',   target: 100, unit: '',   increment: 5,   decimals: 0 },
  { id: 'run',     label: 'RUN',      target: 10,  unit: 'KM', increment: 0.5, decimals: 1 },
]

// ─── Rank ladder ─────────────────────────────────────────────────────────────
const RANKS = [
  { name: 'E', threshold: 0   },
  { name: 'D', threshold: 3   },
  { name: 'C', threshold: 7   },
  { name: 'B', threshold: 14  },
  { name: 'A', threshold: 30  },
  { name: 'S', threshold: 60  },
] as const

function rankFor(streak: number): string {
  let r: string = RANKS[0]!.name
  for (const tier of RANKS) {
    if (streak >= tier.threshold) r = tier.name
  }
  return r
}

function nextRankThreshold(streak: number): number | null {
  for (const tier of RANKS) {
    if (streak < tier.threshold) return tier.threshold
  }
  return null  // already S-rank
}

// EXP awarded per completed daily. Compounding bonus past day 7 to reward streaks.
function expForCompletion(streakAfter: number): number {
  const base = 100
  const bonus = Math.max(0, streakAfter - 7) * 10
  return base + bonus
}

const EXP_PER_LEVEL = 1000  // simple linear curve

function levelFromExp(totalExp: number): { level: number; expInLevel: number } {
  const level = Math.floor(totalExp / EXP_PER_LEVEL) + 1
  const expInLevel = totalExp % EXP_PER_LEVEL
  return { level, expInLevel }
}

// ─── State ───────────────────────────────────────────────────────────────────
type QuestState = { id: string; progress: number }
type State = {
  disclaimerAccepted: boolean
  quests: QuestState[]
  streak: number
  best: number
  totalDays: number
  totalExp: number
  lastResetUTC: number
  pendingPenalty: boolean   // show penalty banner once on next foreground
  pendingClear: boolean     // show "QUEST COMPLETE" banner once
  lastShownRank: string     // for rank-up detection
}

function makeInitial(): State {
  return {
    disclaimerAccepted: false,
    quests: QUESTS.map(q => ({ id: q.id, progress: 0 })),
    streak: 0,
    best: 0,
    totalDays: 0,
    totalExp: 0,
    lastResetUTC: utcDayStart(Date.now()),
    pendingPenalty: false,
    pendingClear: false,
    lastShownRank: 'E',
  }
}

let state: State = makeInitial()

// ─── Persistence ─────────────────────────────────────────────────────────────
const STORAGE_KEY = 'luq.state'

async function loadState(bridge: any): Promise<void> {
  try {
    const raw = await bridge.getLocalStorage(STORAGE_KEY)
    if (raw && typeof raw === 'string' && raw.length > 0) {
      const parsed = JSON.parse(raw) as Partial<State>
      state = { ...makeInitial(), ...parsed }
      // Re-bind quest order to canonical set; preserve progress where ids match.
      const byId = new Map((parsed.quests ?? []).map(q => [q.id, q.progress] as const))
      state.quests = QUESTS.map(def => ({ id: def.id, progress: byId.get(def.id) ?? 0 }))
    }
  } catch (err) {
    console.error('loadState parse failure, using defaults:', err)
    state = makeInitial()
  }
}

let savePending: Promise<unknown> = Promise.resolve()
function persistState(bridge: any): void {
  const snapshot = JSON.stringify(state)
  savePending = savePending.then(() => bridge.setLocalStorage(STORAGE_KEY, snapshot))
}

// ─── UTC date math ───────────────────────────────────────────────────────────
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
  const s = totalSec % 60
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function isQuestDone(q: QuestState): boolean {
  const def = QUESTS.find(d => d.id === q.id)
  return def != null && q.progress >= def.target
}

function allDone(): boolean {
  return state.quests.every(isQuestDone)
}

// Rollover at UTC midnight. Grades the previous day and starts a new one.
function rolloverIfNeeded(now: number): boolean {
  const today = utcDayStart(now)
  if (today <= state.lastResetUTC) return false

  const completed = allDone()
  if (completed) {
    state.streak += 1
    state.totalDays += 1
    state.totalExp += expForCompletion(state.streak)
    if (state.streak > state.best) state.best = state.streak
  } else {
    // Penalty Zone — but only meaningful if you had a streak going.
    if (state.streak >= 1) state.pendingPenalty = true
    state.streak = 0
  }
  state.quests = QUESTS.map(def => ({ id: def.id, progress: 0 }))
  state.lastResetUTC = today
  return true
}

// ─── Screens ─────────────────────────────────────────────────────────────────
type Screen =
  | 'disclaimer'
  | 'quest'
  | 'status'
  | 'penalty'
  | 'clear'   // QUEST COMPLETE celebration

let screen: Screen = 'quest'
let cursor = 0  // highlighted quest index

// ─── Render helpers ──────────────────────────────────────────────────────────
const COLS = 56  // chars per line at 4px padding

function center(s: string, width = COLS): string {
  if (s.length >= width) return s.slice(0, width)
  const left = Math.floor((width - s.length) / 2)
  return ' '.repeat(left) + s
}

function pad(s: string, width: number, align: 'left' | 'right' = 'left'): string {
  if (s.length >= width) return s.slice(0, width)
  const fill = ' '.repeat(width - s.length)
  return align === 'left' ? s + fill : fill + s
}

// Ornate box-drawing frame, Hunter-System flavour. LVGL renders unicode box chars.
const FRAME_TOP    = '╔' + '═'.repeat(COLS - 2) + '╗'
const FRAME_MID    = '╠' + '═'.repeat(COLS - 2) + '╣'
const FRAME_BOT    = '╚' + '═'.repeat(COLS - 2) + '╝'

function framed(line: string): string {
  // Trim/pad inner content to COLS - 2.
  const inner = pad(line, COLS - 2)
  return `║${inner}║`
}

function progressLabel(q: QuestState): string {
  const def = QUESTS.find(d => d.id === q.id)!
  const cur = def.decimals === 0
    ? `${Math.floor(q.progress)}`
    : q.progress.toFixed(def.decimals)
  return `${cur}/${def.target}${def.unit}`
}

// ─── Render ──────────────────────────────────────────────────────────────────
function render(): string {
  switch (screen) {
    case 'disclaimer': return renderDisclaimer()
    case 'quest':      return renderQuest()
    case 'status':     return renderStatus()
    case 'penalty':    return renderPenalty()
    case 'clear':      return renderClear()
  }
}

function renderDisclaimer(): string {
  const body = [
    '',
    center('[!]  LEVEL UP QUEST  [!]'),
    '',
    center('A habit-tracking game inspired by'),
    center('Solo Leveling. The exercises you'),
    center('choose to perform are your own'),
    center('responsibility. Consult a physician'),
    center('before any exercise program. We accept'),
    center('no responsibility for injury or illness.'),
    '',
    center('— tap to accept —'),
  ]
  return body.join('\n')
}

function renderQuest(): string {
  const now = Date.now()
  const countdown = formatCountdown(msUntilNextUtcMidnight(now))
  const cleared = allDone()
  const rank = rankFor(state.streak)

  // Header strip: rank/streak left, countdown right.
  const headerLeft  = `RANK ${rank}  STREAK ${state.streak}`
  const headerRight = `[${countdown}]`
  const headerRoom  = COLS - headerLeft.length - headerRight.length
  const header = headerLeft + ' '.repeat(Math.max(1, headerRoom)) + headerRight

  const lines: string[] = []
  lines.push(header)
  lines.push(FRAME_TOP)
  lines.push(framed('  [!] QUEST INFO — DAILY QUEST'))
  lines.push(framed('  TRAIN TO BECOME A FORMIDABLE COMBATANT'))
  lines.push(FRAME_MID)

  state.quests.forEach((q, i) => {
    const done = isQuestDone(q)
    const marker = i === cursor ? '>' : ' '
    const def = QUESTS.find(d => d.id === q.id)!
    const check = done ? '[x]' : '[ ]'
    const labelCol = pad(`${marker} ${check} ${def.label}`, 20)
    const prog = `[${progressLabel(q)}]`
    const room = (COLS - 2) - labelCol.length - prog.length
    const inner = labelCol + ' '.repeat(Math.max(1, room)) + prog
    lines.push(`║${inner}║`)
  })

  lines.push(FRAME_BOT)
  if (cleared) {
    lines.push(center('— ALL CLEAR · banks at 00:00 UTC —'))
  }
  return lines.join('\n')
}

function renderStatus(): string {
  const { level, expInLevel } = levelFromExp(state.totalExp)
  const rank = rankFor(state.streak)
  const nextRank = nextRankThreshold(state.streak)
  const toNextRank = nextRank == null ? '— MAX —' : `${nextRank - state.streak} day(s)`

  // EXP bar — 30 cells wide.
  const barCells = 30
  const filled = Math.round((expInLevel / EXP_PER_LEVEL) * barCells)
  const bar = '█'.repeat(filled) + '░'.repeat(barCells - filled)

  const lines: string[] = []
  lines.push(FRAME_TOP)
  lines.push(framed('  [!]  STATUS'))
  lines.push(FRAME_MID)
  lines.push(framed(`  HUNTER       LVL ${level}   RANK ${rank}`))
  lines.push(framed(`  EXP   ${bar} ${pad(String(expInLevel), 4, 'right')}`))
  lines.push(framed(`  STREAK       ${state.streak}   BEST ${state.best}`))
  lines.push(framed(`  TOTAL DAYS   ${state.totalDays}`))
  lines.push(framed(`  NEXT RANK    ${toNextRank}`))
  lines.push(FRAME_BOT)
  lines.push(center('— double-tap to return —'))
  return lines.join('\n')
}

function renderPenalty(): string {
  return [
    FRAME_TOP,
    framed('  [!]  PENALTY ZONE'),
    FRAME_MID,
    framed('  THE DAILY QUEST REMAINED INCOMPLETE.'),
    framed(''),
    framed('  PENALTIES HAVE BEEN GIVEN'),
    framed('  ACCORDINGLY. STREAK RESET.'),
    FRAME_BOT,
    center('— tap to continue —'),
  ].join('\n')
}

function renderClear(): string {
  const { level } = levelFromExp(state.totalExp)
  const rank = rankFor(state.streak)
  return [
    FRAME_TOP,
    framed('  [!]  QUEST COMPLETE'),
    FRAME_MID,
    framed('  ALL GOALS CLEARED.'),
    framed(''),
    framed(`  STREAK   x${state.streak}    RANK   ${rank}`),
    framed(`  LEVEL    ${level}`),
    FRAME_BOT,
    center('— tap to continue —'),
  ].join('\n')
}

// ─── Bridge + container ──────────────────────────────────────────────────────
const SCREEN_W = 576
const SCREEN_H = 288

const bridge = await waitForEvenAppBridge()
await loadState(bridge)

// Decide initial screen.
if (!state.disclaimerAccepted) {
  screen = 'disclaimer'
} else {
  if (rolloverIfNeeded(Date.now())) persistState(bridge)
  if (state.pendingPenalty) {
    screen = 'penalty'
  } else if (state.pendingClear) {
    screen = 'clear'
  } else {
    screen = 'quest'
  }
}

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

// ─── Render queue (LVGL crashes on parallel upgrades) ────────────────────────
let rendering: Promise<unknown> = Promise.resolve()
function refresh(): void {
  rendering = rendering.then(() =>
    bridge.textContainerUpgrade(
      new TextContainerUpgrade({ containerID: 1, containerName: 'main', content: render() }),
    ),
  )
}

// Tick countdown + rollover check every 5s while on quest screen.
setInterval(() => {
  if (screen === 'quest') {
    if (rolloverIfNeeded(Date.now())) {
      persistState(bridge)
      // Bump to penalty/clear screen on rollover with consequences.
      if (state.pendingPenalty) screen = 'penalty'
    }
    refresh()
  }
}, 5_000)

// ─── Events ──────────────────────────────────────────────────────────────────
const unsubscribe = bridge.onEvenHubEvent((event: any) => {
  const rawSys = event.sysEvent?.eventType
  const sysType = rawSys ?? 0
  const hasSys = event.sysEvent != null
  const textType = event.textEvent?.eventType ?? null

  // Foreground entry: re-grade in case the phone slept past midnight UTC.
  if (hasSys && sysType === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
    if (rolloverIfNeeded(Date.now())) persistState(bridge)
    if (state.pendingPenalty) screen = 'penalty'
    refresh()
    return
  }

  // Double-tap: cycle quest ↔ status (never exit the app this way — Solo
  // Leveling's System doesn't let you walk away).
  if (
    (hasSys && sysType === OsEventTypeList.DOUBLE_CLICK_EVENT) ||
    textType === OsEventTypeList.DOUBLE_CLICK_EVENT
  ) {
    onDoubleTap()
    return
  }

  if (textType === OsEventTypeList.SCROLL_TOP_EVENT)    { onSwipe(-1); return }
  if (textType === OsEventTypeList.SCROLL_BOTTOM_EVENT) { onSwipe(+1); return }

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
    screen = 'quest'
    cursor = 0
    refresh()
    return
  }

  if (screen === 'penalty') {
    state.pendingPenalty = false
    persistState(bridge)
    screen = 'quest'
    refresh()
    return
  }

  if (screen === 'clear') {
    state.pendingClear = false
    persistState(bridge)
    screen = 'quest'
    refresh()
    return
  }

  if (screen === 'quest') {
    const q = state.quests[cursor]
    if (!q) return
    const def = QUESTS.find(d => d.id === q.id)
    if (!def) return
    const wasAllDone = allDone()
    q.progress = Math.min(def.target, q.progress + def.increment)
    persistState(bridge)
    if (!wasAllDone && allDone()) {
      // Just sealed the daily — flash a celebration but DON'T bank streak yet;
      // streak banks at UTC midnight rollover. Show the panel as immediate
      // feedback, then return to quest screen for the rest of the day.
      state.pendingClear = true
      persistState(bridge)
      screen = 'clear'
    }
    refresh()
    return
  }

  // status: tap is a no-op
}

function onSwipe(delta: -1 | 1): void {
  if (screen !== 'quest') return
  const n = state.quests.length
  cursor = (cursor + delta + n) % n
  refresh()
}

function onDoubleTap(): void {
  if (screen === 'quest')  { screen = 'status'; refresh(); return }
  if (screen === 'status') { screen = 'quest';  refresh(); return }
  // disclaimer / penalty / clear ignore double-tap — single path forward.
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────
let cleanedUp = false
function cleanup(): void {
  if (cleanedUp) return
  cleanedUp = true
  unsubscribe()
}
window.addEventListener('beforeunload', cleanup)

// ─── Browser companion mirror ────────────────────────────────────────────────
const app = document.querySelector<HTMLDivElement>('#app')!
app.innerHTML = `
  <main style="margin:auto;padding:24px;max-width:680px;box-sizing:border-box;">
    <header style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h1 style="font-size:18px;font-weight:600;margin:0;color:#9fdc9f;">LEVEL UP QUEST</h1>
      <span id="meta" style="font-size:12px;color:#919191;"></span>
    </header>
    <pre id="mirror" style="background:#0a0d12;border:1px solid #2a3340;border-radius:12px;padding:20px;font:14px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre;color:#9fdc9f;margin:0;min-height:288px;"></pre>
    <footer style="font-size:12px;color:#7B7B7B;text-align:center;margin-top:16px;">
      tap: progress · swipe up/down: select · double-tap: status
    </footer>
  </main>
`

function mirrorCompanion(): void {
  const mirror = document.getElementById('mirror')
  const meta = document.getElementById('meta')
  if (mirror) mirror.textContent = render()
  if (meta) meta.textContent = `screen: ${screen}  ·  rank: ${rankFor(state.streak)}  ·  streak: ${state.streak}`
}
setInterval(mirrorCompanion, 1000)
mirrorCompanion()
