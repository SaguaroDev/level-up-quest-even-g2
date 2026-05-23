import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'
import { getTextWidth } from '@evenrealities/pretext'

// ─── Solo Leveling Hunter System ─────────────────────────────────────────────
//
// One repeating Daily Quest set, dictated by the System (canon). Tap on a goal
// adds an increment of progress. Clear all four before UTC midnight to bank a
// streak day. Miss and the System imposes a Penalty — streak resets and a
// Penalty Zone screen greets you next.
//
// Ranks: E → D → C → B → A → S, gated by streak length.
//
// Layout: 576×288 monochrome green, proportional font. Right-aligned values
// (countdown, progress) live in their own pixel-positioned containers because
// LVGL has no textAlign property — single-container char padding drifts.

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
const SCREEN_W = 576
const SCREEN_H = 288
const PAD = 4               // container internal padding
const LINE_H = 27           // LVGL line height
const RIGHT_EDGE = SCREEN_W - PAD   // right pixel edge (reserved for future use)
void RIGHT_EDGE
const COLS = 56             // chars per line for the LEFT background container

// ─── Container IDs ───────────────────────────────────────────────────────────
const CID_LEFT       = 1   // background frame + left-aligned content
const CID_RIGHT_HEAD = 2   // header-right countdown
const CID_RIGHT_Q1   = 3   // progress for quest 1
const CID_RIGHT_Q2   = 4
const CID_RIGHT_Q3   = 5
const CID_RIGHT_Q4   = 6
const CID_RIGHT_EXP  = 7   // status screen: exp number

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

const FRAME_LINE = '+' + '-'.repeat(COLS - 2) + '+'
function framed(line: string): string {
  return `|${pad(line, COLS - 2)}|`
}

// ─── LEFT container content (the bulk of the layout) ─────────────────────────
//
// Right-edge VALUES are NOT in this content — they go in their own pixel-aligned
// containers. To keep the right frame bar `|` aligned, the LEFT container draws
// the FRAME (with the right `|` bar at column COLS-1) and reserves blank space
// where the right-aligned values will overlay.

function renderLeft(): string {
  switch (screen) {
    case 'disclaimer': return renderLeftDisclaimer()
    case 'quest':      return renderLeftQuest()
    case 'status':     return renderLeftStatus()
    case 'penalty':    return renderLeftPenalty()
    case 'clear':      return renderLeftClear()
  }
}

function renderLeftDisclaimer(): string {
  return [
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
    center('-- tap to accept --'),
  ].join('\n')
}

function renderLeftQuest(): string {
  // Header strip: left side only. Right side (countdown) is its own container.
  const rank = rankFor(state.streak)
  const headerLeft = `RANK ${rank}   STREAK ${state.streak}`

  const lines: string[] = []
  lines.push(headerLeft)
  lines.push(FRAME_LINE)
  lines.push(framed('  [!] QUEST INFO - DAILY QUEST'))
  lines.push(framed('  TRAIN TO BECOME A FORMIDABLE COMBATANT'))
  lines.push(FRAME_LINE)

  state.quests.forEach((q, i) => {
    const done = isQuestDone(q)
    const marker = i === cursor ? '>' : ' '
    const def = QUESTS.find(d => d.id === q.id)!
    const check = done ? '[x]' : '[ ]'
    // Just the LABEL side — progress value is its own right-aligned container.
    // Reserve the right portion with blank pad so the closing `|` lines up.
    lines.push(framed(`${marker} ${check} ${def.label}`))
  })

  lines.push(FRAME_LINE)
  if (allDone()) {
    lines.push(center('-- ALL CLEAR - banks at 00:00 UTC --'))
  }
  return lines.join('\n')
}

function renderLeftStatus(): string {
  const { level, expInLevel } = levelFromExp(state.totalExp)
  const rank = rankFor(state.streak)
  const nextRank = nextRankThreshold(state.streak)
  const toNextRank = nextRank == null ? '-- MAX --' : `${nextRank - state.streak} day(s)`

  const barCells = 30
  const filled = Math.round((expInLevel / EXP_PER_LEVEL) * barCells)
  const bar = '#'.repeat(filled) + '.'.repeat(barCells - filled)

  const lines: string[] = []
  lines.push(FRAME_LINE)
  lines.push(framed('  [!]  STATUS'))
  lines.push(FRAME_LINE)
  lines.push(framed(`  HUNTER       LVL ${level}   RANK ${rank}`))
  // EXP number is its own right-aligned container.
  lines.push(framed(`  EXP   ${bar}`))
  lines.push(framed(`  STREAK       ${state.streak}   BEST ${state.best}`))
  lines.push(framed(`  TOTAL DAYS   ${state.totalDays}`))
  lines.push(framed(`  NEXT RANK    ${toNextRank}`))
  lines.push(FRAME_LINE)
  lines.push(center('-- double-tap to return --'))
  return lines.join('\n')
}

function renderLeftPenalty(): string {
  return [
    FRAME_LINE,
    framed('  [!]  PENALTY ZONE'),
    FRAME_LINE,
    framed('  THE DAILY QUEST REMAINED INCOMPLETE.'),
    framed(''),
    framed('  PENALTIES HAVE BEEN GIVEN'),
    framed('  ACCORDINGLY. STREAK RESET.'),
    FRAME_LINE,
    center('-- tap to continue --'),
  ].join('\n')
}

function renderLeftClear(): string {
  const { level } = levelFromExp(state.totalExp)
  const rank = rankFor(state.streak)
  return [
    FRAME_LINE,
    framed('  [!]  QUEST COMPLETE'),
    FRAME_LINE,
    framed('  ALL GOALS CLEARED.'),
    framed(''),
    framed(`  STREAK   x${state.streak}    RANK   ${rank}`),
    framed(`  LEVEL    ${level}`),
    FRAME_LINE,
    center('-- tap to continue --'),
  ].join('\n')
}

// ─── Right-anchored value containers ─────────────────────────────────────────
//
// Each right-aligned value lives in its own container, positioned at
// x = RIGHT_EDGE - getTextWidth(value). The container width is just wide enough
// for the value, and the content is its only line — so the result is pixel-
// perfect right-alignment regardless of digit count.
//
// We also have to LEAVE ROOM for the frame's right `|` bar — so we anchor to
// (RIGHT_EDGE - frameBarWidth - 2). For the LEFT container, the frame `|`
// already occupies column COLS-1.

// We pre-create containers for every right-value we might ever need (max 4
// quest rows + 1 header + 1 status-exp = 6 right containers). On screen change
// we set unused containers to empty string.

type RightValue = {
  cid: number
  text: string       // value to display ('' = hidden)
  yPosition: number  // top edge in px
}

// Approximate y positions (top of each row) for the Quest screen:
//   row 0 (header):   y=0
//   row 1 (frame):    y=27
//   row 2 (info):     y=54
//   row 3 (info):     y=81
//   row 4 (frame):    y=108
//   row 5 (q1):       y=135
//   row 6 (q2):       y=162
//   row 7 (q3):       y=189
//   row 8 (q4):       y=216
//   row 9 (frame):    y=243
//   row 10 (clear):   y=270
//
// For status screen, EXP value sits on row index 5 (HUNTER LVL+RANK is row 4,
// EXP is row 5).

const Y_HEADER = 0
const Y_Q_BASE = 5 * LINE_H   // first quest row
const Y_EXP = 5 * LINE_H

function rightValuesForScreen(): RightValue[] {
  if (screen === 'quest') {
    const countdown = `[${formatCountdown(msUntilNextUtcMidnight(Date.now()))}]`
    const out: RightValue[] = [
      { cid: CID_RIGHT_HEAD, text: countdown, yPosition: Y_HEADER },
    ]
    state.quests.forEach((q, i) => {
      const cid = [CID_RIGHT_Q1, CID_RIGHT_Q2, CID_RIGHT_Q3, CID_RIGHT_Q4][i]!
      out.push({ cid, text: `[${progressLabel(q)}]`, yPosition: Y_Q_BASE + i * LINE_H })
    })
    out.push({ cid: CID_RIGHT_EXP, text: '', yPosition: Y_EXP })
    return out
  }

  if (screen === 'status') {
    const { expInLevel } = levelFromExp(state.totalExp)
    return [
      { cid: CID_RIGHT_HEAD, text: '', yPosition: Y_HEADER },
      { cid: CID_RIGHT_Q1,   text: '', yPosition: Y_Q_BASE },
      { cid: CID_RIGHT_Q2,   text: '', yPosition: Y_Q_BASE + LINE_H },
      { cid: CID_RIGHT_Q3,   text: '', yPosition: Y_Q_BASE + 2 * LINE_H },
      { cid: CID_RIGHT_Q4,   text: '', yPosition: Y_Q_BASE + 3 * LINE_H },
      { cid: CID_RIGHT_EXP,  text: String(expInLevel), yPosition: Y_EXP },
    ]
  }

  // disclaimer, penalty, clear — hide every right value.
  return [
    { cid: CID_RIGHT_HEAD, text: '', yPosition: Y_HEADER },
    { cid: CID_RIGHT_Q1,   text: '', yPosition: Y_Q_BASE },
    { cid: CID_RIGHT_Q2,   text: '', yPosition: Y_Q_BASE + LINE_H },
    { cid: CID_RIGHT_Q3,   text: '', yPosition: Y_Q_BASE + 2 * LINE_H },
    { cid: CID_RIGHT_Q4,   text: '', yPosition: Y_Q_BASE + 3 * LINE_H },
    { cid: CID_RIGHT_EXP,  text: '', yPosition: Y_EXP },
  ]
}

// Approximate text width when the SDK's pretext isn't available (rare edge).
function approxWidth(s: string): number {
  // Fall back to ~10px per char. Will look off but at least visible.
  return s.length * 10
}

function measureWidth(s: string): number {
  if (!s) return 0
  try {
    return getTextWidth(s)
  } catch {
    return approxWidth(s)
  }
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

// Reserve room on the right for the value containers; the LEFT container still
// spans the full screen so the frame's `|` bar lives at column COLS-1.
const leftContainer = new TextContainerProperty({
  xPosition: 0, yPosition: 0, width: SCREEN_W, height: SCREEN_H,
  borderWidth: 0, borderColor: 5, paddingLength: PAD,
  containerID: CID_LEFT, containerName: 'left',
  content: renderLeft(),
  isEventCapture: 1,
})

// Right containers are created with placeholder widths; we resize implicitly by
// changing xPosition via... wait, container geometry is set at create-time and
// not re-settable from textContainerUpgrade. Strategy: make each right container
// FIXED WIDTH (just wide enough for the widest expected value) and update its
// CONTENT padded on the LEFT with spaces so the visible end of the text sits
// at the same right pixel. Spaces in a left-aligned container push content
// rightward by a known pixel amount per space.
//
// We use pretext.getTextWidth to compute, per update, how many leading spaces
// the value needs to right-align inside the container's fixed inner width.

const RIGHT_INNER_W = 110   // max pixel budget for a right-aligned value (12 chars * ~9px)
const RIGHT_OUTER_W = RIGHT_INNER_W + 2 * PAD
// Anchor right edge of these containers to the screen's right edge minus the
// LEFT container's frame `|` bar (~9 px) and a small gutter.
const RIGHT_GUTTER = 12  // space for `|` frame bar + margin
const RIGHT_X = SCREEN_W - RIGHT_OUTER_W - RIGHT_GUTTER

function makeRightContainer(cid: number, y: number, name: string): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: RIGHT_X, yPosition: y,
    width: RIGHT_OUTER_W, height: LINE_H,
    borderWidth: 0, borderColor: 0, paddingLength: PAD,
    containerID: cid, containerName: name,
    content: '',
    isEventCapture: 0,
  })
}

const initialRightValues = rightValuesForScreen()
const rightContainers = initialRightValues.map(rv =>
  makeRightContainer(rv.cid, rv.yPosition, `r${rv.cid}`)
)

// Right-align a value within RIGHT_INNER_W by prepending the right number of
// leading spaces. measureWidth(' ') gives us per-space cost.
const SPACE_W = Math.max(1, measureWidth(' ') || 5)
function rightAlignedContent(value: string): string {
  if (!value) return ''
  const valueW = measureWidth(value)
  const gap = RIGHT_INNER_W - valueW
  if (gap <= 0) return value
  const spaces = Math.max(0, Math.floor(gap / SPACE_W))
  return ' '.repeat(spaces) + value
}

// Populate right containers with their initial values.
initialRightValues.forEach((rv, i) => {
  rightContainers[i]!.content = rightAlignedContent(rv.text)
})

const created = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({
    containerTotalNum: 1 + rightContainers.length,
    textObject: [leftContainer, ...rightContainers],
  }),
)
if (created !== 0) console.error('createStartUpPageContainer failed:', created)

// ─── Render queue ────────────────────────────────────────────────────────────
let rendering: Promise<unknown> = Promise.resolve()

function refresh(): void {
  rendering = rendering.then(async () => {
    // Update LEFT first so the frame is in place before values appear.
    await bridge.textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: CID_LEFT,
        containerName: 'left',
        content: renderLeft(),
      }),
    )
    // Then each right-aligned value in sequence.
    for (const rv of rightValuesForScreen()) {
      await bridge.textContainerUpgrade(
        new TextContainerUpgrade({
          containerID: rv.cid,
          containerName: `r${rv.cid}`,
          content: rightAlignedContent(rv.text),
        }),
      )
    }
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
//
// The browser companion uses a monospace font, so it'll show alignment
// differently from the glasses. Keep it for state debugging, not visual fidelity.

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
  if (mirror) {
    // Overlay right values onto the left content using char-padding (approx).
    const lines = renderLeft().split('\n')
    const rvs = rightValuesForScreen()
    const out = lines.map((line, idx) => {
      const y = idx * LINE_H
      const rv = rvs.find(r => r.yPosition === y)
      if (!rv || !rv.text) return line
      // strip last 14 chars of line and replace with right-padded value
      const trimmed = line.length > 14 ? line.slice(0, line.length - 14) : line
      return trimmed + rv.text.padStart(14, ' ')
    })
    mirror.textContent = out.join('\n')
  }
  if (meta) meta.textContent = `screen: ${screen} . rank: ${rankFor(state.streak)} . streak: ${state.streak}`
}
setInterval(mirrorCompanion, 1000)
mirrorCompanion()
