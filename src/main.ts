import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'

// ─── Solo Leveling Hunter System ─────────────────────────────────────────────
//
// One repeating Daily Quest set. Tap to increment progress on the highlighted
// goal. Clear all four before UTC midnight to bank a streak day. Miss the
// window and the Penalty Zone screen greets you next.
//
// Ranks: E -> D -> C -> B -> A -> S, gated by streak length.
//
// Layout philosophy (rewritten May 23 2026):
//
// Single text container at xPosition=0, width=SAFE_TEXT_WIDTH, full height.
// Pattern lifted from EvenChess (chess HUD that ships and works). The
// waveguide aperture clips content past ~pixel 380; multi-container splits
// with pixel-anchored right values were never readable on the test unit no
// matter what gutter we tried. The fix is to never place text near the right
// edge at all. All content lives in one left-anchored container with column
// layout done by ASCII space padding.

type QuestDef = {
  id: string
  label: string
  target: number
  unit: string         // '', 'KM', 'MIN'
  increment: number
  decimals: number
}

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
  return null
}

function expForCompletion(streakAfter: number): number {
  const base = 100
  const bonus = Math.max(0, streakAfter - 7) * 10
  return base + bonus
}

const EXP_PER_LEVEL = 1000

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
  pendingPenalty: boolean
  pendingClear: boolean
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
      const byId = new Map((parsed.quests ?? []).map(q => [q.id, q.progress] as const))
      state.quests = QUESTS.map(def => ({ id: def.id, progress: byId.get(def.id) ?? 0 }))
    }
  } catch (err) {
    console.error('loadState parse failure:', err)
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
    if (state.streak >= 1) state.pendingPenalty = true
    state.streak = 0
  }
  state.quests = QUESTS.map(def => ({ id: def.id, progress: 0 }))
  state.lastResetUTC = today
  return true
}

function progressLabel(q: QuestState): string {
  const def = QUESTS.find(d => d.id === q.id)!
  const cur = def.decimals === 0
    ? `${Math.floor(q.progress)}`
    : q.progress.toFixed(def.decimals)
  return `${cur}/${def.target}${def.unit}`
}

// ─── Screen state ────────────────────────────────────────────────────────────
type Screen =
  | 'disclaimer'
  | 'quest'
  | 'status'
  | 'penalty'
  | 'clear'

let screen: Screen = 'quest'
let cursor = 0

// ─── Layout geometry ─────────────────────────────────────────────────────────
//
// Waveguide-safe text region empirically lives between roughly pixel 0 and
// pixel 380 on the test unit. We use a 540-px wide container as a generous
// upper bound but never compose lines longer than ~40 ASCII chars so content
// stays inside the safe zone regardless of proportional-font width variance.
//
// Single text container = simplest possible architecture. No pretext
// measurements, no leading-space padding, no pixel anchoring, no parallel
// container upgrades. Same model EvenChess (chess HUD, v2.0.4) uses.
const SCREEN_W = 576
const SCREEN_H = 288
const PAD = 4
const COLS = 40             // chars per line, conservative for proportional font

const CID_MAIN = 1

// ─── Helpers ─────────────────────────────────────────────────────────────────
function pad(s: string, width: number, align: 'left' | 'right' = 'left'): string {
  if (s.length >= width) return s.slice(0, width)
  const fill = ' '.repeat(width - s.length)
  return align === 'left' ? s + fill : fill + s
}

function center(s: string, width = COLS): string {
  if (s.length >= width) return s.slice(0, width)
  const left = Math.floor((width - s.length) / 2)
  return ' '.repeat(left) + s
}

// Two-column row: label on the left, value column-anchored to a fixed character
// position. NOT pixel-anchored to the right edge - that lost the multi-month
// fight with the waveguide. Anchored to a column the LABEL field pads up to.
// Proportional-font drift on the value's right edge is acceptable because the
// eye reads LABEL+VALUE as a left-anchored unit.
const VALUE_COL = 28        // column where the value starts (chars from x=0)
function row(label: string, value: string): string {
  // pad label up to VALUE_COL-1, append value
  return pad(label, VALUE_COL - 1) + value
}

const FRAME_LINE = '+' + '-'.repeat(COLS - 2) + '+'
function framed(line: string): string {
  return '|' + pad(line, COLS - 2) + '|'
}

// ─── Screen content (one composed string per screen) ─────────────────────────

function renderScreen(): string {
  switch (screen) {
    case 'disclaimer': return renderDisclaimer()
    case 'quest':      return renderQuest()
    case 'status':     return renderStatus()
    case 'penalty':    return renderPenalty()
    case 'clear':      return renderClear()
  }
}

function renderDisclaimer(): string {
  return [
    '',
    center('[!]  LEVEL UP QUEST  [!]'),
    '',
    center('A habit game inspired by'),
    center('Solo Leveling. Exercises you'),
    center('do are your responsibility.'),
    center('Consult a physician before any'),
    center('exercise program. No liability'),
    center('for injury or illness.'),
    '',
    center('-- tap to accept --'),
  ].join('\n')
}

function renderQuest(): string {
  const rank = rankFor(state.streak)
  const countdown = formatCountdown(msUntilNextUtcMidnight(Date.now()))

  const lines: string[] = []
  // Header row: rank+streak on the left, countdown column-anchored on the right
  lines.push(row(`RANK ${rank}  STREAK ${state.streak}`, countdown))
  lines.push(FRAME_LINE)
  lines.push(framed(' DAILY QUEST'))
  lines.push(framed(' Train to become a hunter.'))
  lines.push(FRAME_LINE)

  state.quests.forEach((q, i) => {
    const done = isQuestDone(q)
    const marker = i === cursor ? '>' : ' '
    const def = QUESTS.find(d => d.id === q.id)!
    const check = done ? '[x]' : '[ ]'
    const label = `${marker} ${check} ${def.label}`
    lines.push(row(label, progressLabel(q)))
  })

  lines.push(FRAME_LINE)
  if (allDone()) {
    lines.push(center('-- ALL CLEAR - banks 00:00 UTC --'))
  } else {
    lines.push(center('tap: +progress  swipe: select'))
  }
  return lines.join('\n')
}

function renderStatus(): string {
  const { level, expInLevel } = levelFromExp(state.totalExp)
  const rank = rankFor(state.streak)
  const nextRank = nextRankThreshold(state.streak)
  const toNextRank = nextRank == null ? 'MAX' : `${nextRank - state.streak}d`

  const barCells = 20
  const filled = Math.round((expInLevel / EXP_PER_LEVEL) * barCells)
  const bar = '#'.repeat(filled) + '.'.repeat(barCells - filled)

  const lines: string[] = []
  lines.push(FRAME_LINE)
  lines.push(framed(' STATUS'))
  lines.push(FRAME_LINE)
  lines.push(row(' HUNTER', `LVL ${level}`))
  lines.push(row(' RANK', rank))
  lines.push(row(' EXP', `${expInLevel}/${EXP_PER_LEVEL}`))
  lines.push(' ' + bar)
  lines.push(row(' STREAK', `${state.streak}`))
  lines.push(row(' BEST', `${state.best}`))
  lines.push(row(' TOTAL DAYS', `${state.totalDays}`))
  lines.push(row(' NEXT RANK', toNextRank))
  lines.push(FRAME_LINE)
  lines.push(center('-- double-tap: back --'))
  return lines.join('\n')
}

function renderPenalty(): string {
  return [
    FRAME_LINE,
    framed(' PENALTY ZONE'),
    FRAME_LINE,
    framed(' Daily Quest incomplete.'),
    framed(''),
    framed(' Penalty given.'),
    framed(' Streak reset.'),
    FRAME_LINE,
    center('-- tap to continue --'),
  ].join('\n')
}

function renderClear(): string {
  const { level } = levelFromExp(state.totalExp)
  const rank = rankFor(state.streak)
  return [
    FRAME_LINE,
    framed(' QUEST COMPLETE'),
    FRAME_LINE,
    framed(' All goals cleared.'),
    framed(''),
    row(' STREAK', `x${state.streak}`),
    row(' RANK', rank),
    row(' LEVEL', `${level}`),
    FRAME_LINE,
    center('-- tap to continue --'),
  ].join('\n')
}

// ─── Bridge boot ─────────────────────────────────────────────────────────────
const bridge = await waitForEvenAppBridge()
await loadState(bridge)

if (!state.disclaimerAccepted) {
  screen = 'disclaimer'
} else {
  if (rolloverIfNeeded(Date.now())) persistState(bridge)
  if (state.pendingPenalty) screen = 'penalty'
  else if (state.pendingClear) screen = 'clear'
  else screen = 'quest'
}

// Single text container, left-anchored, full safe width.
const mainContainer = new TextContainerProperty({
  xPosition: 0, yPosition: 0,
  width: SCREEN_W, height: SCREEN_H,
  borderWidth: 0, borderColor: 5, paddingLength: PAD,
  containerID: CID_MAIN, containerName: 'main',
  content: renderScreen(),
  isEventCapture: 1,
})

const created = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({
    containerTotalNum: 1,
    textObject: [mainContainer],
  }),
)
if (created !== 0) console.error('createStartUpPageContainer failed:', created)

// ─── Render queue ────────────────────────────────────────────────────────────
let rendering: Promise<unknown> = Promise.resolve()

function refresh(): void {
  rendering = rendering.then(async () => {
    await bridge.textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: CID_MAIN,
        containerName: 'main',
        content: renderScreen(),
      }),
    )
  })
}

// Tick countdown + rollover check every 5s while on quest screen.
setInterval(() => {
  if (screen === 'quest') {
    if (rolloverIfNeeded(Date.now())) {
      persistState(bridge)
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

  if (hasSys && sysType === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
    if (rolloverIfNeeded(Date.now())) persistState(bridge)
    if (state.pendingPenalty) screen = 'penalty'
    refresh()
    return
  }

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
      state.pendingClear = true
      persistState(bridge)
      screen = 'clear'
    }
    refresh()
    return
  }
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
      tap: progress . swipe up/down: select . double-tap: status
    </footer>
  </main>
`

function mirrorCompanion(): void {
  const mirror = document.getElementById('mirror')
  const meta = document.getElementById('meta')
  if (mirror) mirror.textContent = renderScreen()
  if (meta) meta.textContent = `screen: ${screen} . rank: ${rankFor(state.streak)} . streak: ${state.streak}`
}
setInterval(mirrorCompanion, 1000)
mirrorCompanion()
