import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'

// Background-state migration (setBackgroundState / onBackgroundRestore) is
// available in newer SDKs from the everything-evenhub skill pack but not in
// @evenrealities/even_hub_sdk 0.0.10. setLocalStorage handles cold restart,
// which is the user-facing guarantee. Background→foreground state position
// will fall back to "Today" on resume — acceptable for v1.

// ─── Quest library ───────────────────────────────────────────────────────────
// Display label + default target. User picks 4 at setup and locks them in.
type QuestDef = { id: string; label: string; defaultTarget: number; unit: string }
const QUEST_LIBRARY: QuestDef[] = [
  { id: 'run',        label: 'Run',          defaultTarget: 10,  unit: 'km'     },
  { id: 'pushups',    label: 'Pushups',      defaultTarget: 100, unit: 'reps'   },
  { id: 'situps',     label: 'Situps',       defaultTarget: 100, unit: 'reps'   },
  { id: 'squats',     label: 'Squats',       defaultTarget: 100, unit: 'reps'   },
  { id: 'pullups',    label: 'Pullups',      defaultTarget: 20,  unit: 'reps'   },
  { id: 'plank',      label: 'Plank',        defaultTarget: 5,   unit: 'min'    },
  { id: 'meditate',   label: 'Meditate',     defaultTarget: 10,  unit: 'min'    },
  { id: 'pages',      label: 'Read',         defaultTarget: 30,  unit: 'pages'  },
  { id: 'water',      label: 'Water',        defaultTarget: 8,   unit: 'glasses' },
]

const DEFAULT_QUEST_IDS = ['run', 'pushups', 'situps', 'squats']

// ─── State shape ─────────────────────────────────────────────────────────────
type Quest = { id: string; target: number }
type State = {
  disclaimerAccepted: boolean
  quests: Quest[]            // length 4 once setup complete
  checks: boolean[]          // length 4, aligned with quests
  streak: number
  best: number
  totalDays: number
  lastResetUTC: number       // ms since epoch at the start of the current UTC day
  setupComplete: boolean
}

const INITIAL_STATE: State = {
  disclaimerAccepted: false,
  quests: [],
  checks: [false, false, false, false],
  streak: 0,
  best: 0,
  totalDays: 0,
  lastResetUTC: utcDayStart(Date.now()),
  setupComplete: false,
}

let state: State = { ...INITIAL_STATE }

// ─── Screen / cursor ─────────────────────────────────────────────────────────
type Screen = 'disclaimer' | 'setup-pick' | 'setup-confirm' | 'today' | 'stats' | 'settings' | 'settings-confirm-reset'
let screen: Screen = 'disclaimer'
let cursor = 0                          // highlighted index within screen
let setupPicks: string[] = []           // ids picked during setup-pick (up to 4)

// ─── Persistence ─────────────────────────────────────────────────────────────
const STORAGE_KEY = 'luq.state'

async function loadState(bridge: any): Promise<void> {
  try {
    const raw = await bridge.getLocalStorage(STORAGE_KEY)
    if (raw && typeof raw === 'string' && raw.length > 0) {
      const parsed = JSON.parse(raw) as Partial<State>
      state = { ...INITIAL_STATE, ...parsed }
      if (!Array.isArray(state.checks) || state.checks.length !== 4) {
        state.checks = [false, false, false, false]
      }
    }
  } catch (err) {
    console.error('loadState parse failure, using defaults:', err)
    state = { ...INITIAL_STATE }
  }
}

let savePending: Promise<unknown> = Promise.resolve()
function persistState(bridge: any): void {
  // Serialize writes so rapid input can't interleave.
  savePending = savePending.then(() => bridge.setLocalStorage(STORAGE_KEY, JSON.stringify(state)))
}

// (Background-state migration would go here once SDK exposes it.)

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

// Evaluate yesterday's quest set when the UTC day rolls over.
// All four checked → streak++, totalDays++. Any missed → streak = 0.
function rolloverIfNeeded(now: number): boolean {
  const today = utcDayStart(now)
  if (today <= state.lastResetUTC) return false
  if (state.setupComplete) {
    const allDone = state.checks.every(Boolean)
    if (allDone) {
      state.streak += 1
      state.totalDays += 1
      if (state.streak > state.best) state.best = state.streak
    } else {
      state.streak = 0
    }
  }
  state.checks = [false, false, false, false]
  state.lastResetUTC = today
  return true
}

// ─── Bridge + containers ─────────────────────────────────────────────────────
const SCREEN_W = 576
const SCREEN_H = 288

const bridge = await waitForEvenAppBridge()
await loadState(bridge)

// Initial screen: respect saved state.
if (!state.disclaimerAccepted) screen = 'disclaimer'
else if (!state.setupComplete) screen = 'setup-pick'
else screen = 'today'

// Run rollover BEFORE first render so the user sees a clean board on a new day.
if (rolloverIfNeeded(Date.now())) persistState(bridge)

const mainBox = new TextContainerProperty({
  xPosition: 0, yPosition: 0, width: SCREEN_W, height: SCREEN_H,
  borderWidth: 0, borderColor: 5, paddingLength: 6,
  containerID: 1, containerName: 'main',
  content: render(),
  isEventCapture: 1,
})

const created = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({ containerTotalNum: 1, textObject: [mainBox] }),
)
if (created !== 0) console.error('createStartUpPageContainer failed:', created)

// ─── Render ──────────────────────────────────────────────────────────────────
// All screens render to a single text container. Keep each line under ~55 chars
// to be safe on LVGL wrap at the chosen font size. Inner width is 576 - 12 = 564 px.
function render(): string {
  switch (screen) {
    case 'disclaimer':           return renderDisclaimer()
    case 'setup-pick':           return renderSetupPick()
    case 'setup-confirm':        return renderSetupConfirm()
    case 'today':                return renderToday()
    case 'stats':                return renderStats()
    case 'settings':             return renderSettings()
    case 'settings-confirm-reset': return renderResetConfirm()
  }
}

function renderDisclaimer(): string {
  return [
    'LEVEL UP QUEST',
    '',
    'A habit-tracking game. The exercises you',
    'choose are your responsibility.',
    '',
    'Consult a physician before any exercise',
    'program. We accept no responsibility for',
    'injury, illness, or any consequence of',
    'following self-selected quests.',
    '',
    '',
    'long-press: I accept     double-tap: exit',
  ].join('\n')
}

function renderSetupPick(): string {
  const lines = ['PICK 4 QUESTS', '']
  QUEST_LIBRARY.forEach((q, i) => {
    const sel = setupPicks.includes(q.id) ? '[X]' : '[ ]'
    const cur = i === cursor ? '> ' : '  '
    lines.push(`${cur}${sel} ${q.label}  (${q.defaultTarget} ${q.unit})`)
  })
  lines.push('')
  lines.push(`picked ${setupPicks.length}/4`)
  lines.push('tap: next  long-press: toggle  swipe-dn: confirm')
  return lines.join('\n')
}

function renderSetupConfirm(): string {
  const lines = ['CONFIRM QUESTS', '']
  setupPicks.forEach(id => {
    const q = QUEST_LIBRARY.find(x => x.id === id)
    if (q) lines.push(`  ${q.label}  ${q.defaultTarget} ${q.unit}`)
  })
  lines.push('')
  lines.push('These lock in. Change only by reset.')
  lines.push('')
  lines.push('long-press: lock in    swipe-up: back')
  return lines.join('\n')
}

function renderToday(): string {
  const lines: string[] = []
  const ms = msUntilNextUtcMidnight(Date.now())
  lines.push(`TODAY    streak ${state.streak}    resets ${formatCountdown(ms)} UTC`)
  lines.push('')
  state.quests.forEach((q, i) => {
    const def = QUEST_LIBRARY.find(x => x.id === q.id)
    if (!def) return
    const mark = state.checks[i] ? '[X]' : '[ ]'
    const cur = i === cursor ? '> ' : '  '
    lines.push(`${cur}${mark} ${def.label}  ${q.target} ${def.unit}`)
  })
  const allDone = state.checks.every(Boolean)
  lines.push('')
  if (allDone) lines.push('All quests cleared. Streak banks at midnight.')
  lines.push('')
  lines.push('tap: next  long-press: toggle  swipe-dn: stats')
  return lines.join('\n')
}

function renderStats(): string {
  return [
    'STATS',
    '',
    `Current streak     ${state.streak}`,
    `Best streak        ${state.best}`,
    `Total days cleared ${state.totalDays}`,
    '',
    '',
    'swipe-up: today    swipe-dn: settings',
  ].join('\n')
}

function renderSettings(): string {
  return [
    'SETTINGS',
    '',
    '> Reset quests (clears streak)',
    '',
    'Resetting lets you re-pick your 4 quests.',
    'Streak, best streak, and total days reset',
    'to zero.',
    '',
    'long-press: reset    swipe-up: stats',
  ].join('\n')
}

function renderResetConfirm(): string {
  return [
    'RESET — ARE YOU SURE?',
    '',
    'Streak, best streak, total days, and your',
    'quest list will all clear.',
    '',
    '',
    'long-press: confirm    swipe-up: cancel',
  ].join('\n')
}

// ─── Render queue (serialize bridge writes) ──────────────────────────────────
let rendering: Promise<unknown> = Promise.resolve()
function refresh(): void {
  rendering = rendering.then(() =>
    bridge.textContainerUpgrade(
      new TextContainerUpgrade({ containerID: 1, containerName: 'main', content: render() }),
    ),
  )
}

// Countdown ticker — only meaningful on Today.
setInterval(() => {
  if (screen === 'today') {
    // Also catch midnight rollover live, in case the user keeps the app open past 00:00 UTC.
    if (rolloverIfNeeded(Date.now())) persistState(bridge)
    refresh()
  }
}, 30_000)

// ─── Event handling ──────────────────────────────────────────────────────────
//
// Tap (single click)   → advance cursor within the current screen
// Long press           → primary action on the current screen (toggle / confirm)
// Double-tap           → exit the app (always works, root-level)
// Swipe up             → previous screen
// Swipe down           → next screen
//
// LONG_PRESS event isn't enumerated in our type stub, but the spec lists it.
// For now we treat sysEvent.eventType === 9 as long-press (will adjust once we
// run on real hardware and confirm the enum value).
const LONG_PRESS = 9

const unsubscribe = bridge.onEvenHubEvent((event: any) => {
  const sysType = event.sysEvent?.eventType ?? null
  const textType = event.textEvent?.eventType ?? null

  // Root-level: always allow exit.
  if (sysType === OsEventTypeList.DOUBLE_CLICK_EVENT || textType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    bridge.shutDownPageContainer(1)
    return
  }

  if (sysType === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
    // Coming back from background — check for midnight rollover.
    if (rolloverIfNeeded(Date.now())) persistState(bridge)
    refresh()
    return
  }

  if (textType === OsEventTypeList.SCROLL_TOP_EVENT) {
    onSwipeUp()
    return
  }
  if (textType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
    onSwipeDown()
    return
  }

  if (sysType === OsEventTypeList.CLICK_EVENT) {
    onTap()
    return
  }

  if (sysType === LONG_PRESS) {
    onLongPress()
    return
  }

  if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
    cleanup()
  }
})

function onTap(): void {
  switch (screen) {
    case 'setup-pick':
      cursor = (cursor + 1) % QUEST_LIBRARY.length
      refresh()
      return
    case 'today':
      if (state.quests.length > 0) {
        cursor = (cursor + 1) % state.quests.length
        refresh()
      }
      return
    default:
      return
  }
}

function onLongPress(): void {
  switch (screen) {
    case 'disclaimer':
      state.disclaimerAccepted = true
      persistState(bridge)
      screen = 'setup-pick'
      cursor = 0
      setupPicks = [...DEFAULT_QUEST_IDS]
      refresh()
      return

    case 'setup-pick': {
      const q = QUEST_LIBRARY[cursor]
      if (!q) return
      const idx = setupPicks.indexOf(q.id)
      if (idx >= 0) {
        setupPicks.splice(idx, 1)
      } else if (setupPicks.length < 4) {
        setupPicks.push(q.id)
      }
      refresh()
      return
    }

    case 'setup-confirm':
      if (setupPicks.length !== 4) return
      state.quests = setupPicks.map(id => {
        const def = QUEST_LIBRARY.find(x => x.id === id)!
        return { id, target: def.defaultTarget }
      })
      state.checks = [false, false, false, false]
      state.setupComplete = true
      state.lastResetUTC = utcDayStart(Date.now())
      persistState(bridge)
      screen = 'today'
      cursor = 0
      refresh()
      return

    case 'today':
      if (state.quests[cursor]) {
        state.checks[cursor] = !state.checks[cursor]
        persistState(bridge)
        refresh()
      }
      return

    case 'settings':
      screen = 'settings-confirm-reset'
      refresh()
      return

    case 'settings-confirm-reset':
      // Full reset — preserves disclaimer acceptance only.
      state = { ...INITIAL_STATE, disclaimerAccepted: true }
      persistState(bridge)
      screen = 'setup-pick'
      cursor = 0
      setupPicks = [...DEFAULT_QUEST_IDS]
      refresh()
      return

    default:
      return
  }
}

function onSwipeUp(): void {
  // Backward navigation
  switch (screen) {
    case 'setup-confirm':
      screen = 'setup-pick'
      refresh()
      return
    case 'stats':
      screen = 'today'
      cursor = 0
      refresh()
      return
    case 'settings':
      screen = 'stats'
      refresh()
      return
    case 'settings-confirm-reset':
      screen = 'settings'
      refresh()
      return
    default:
      return
  }
}

function onSwipeDown(): void {
  // Forward navigation
  switch (screen) {
    case 'setup-pick':
      if (setupPicks.length === 4) {
        screen = 'setup-confirm'
        refresh()
      }
      return
    case 'today':
      screen = 'stats'
      refresh()
      return
    case 'stats':
      screen = 'settings'
      refresh()
      return
    default:
      return
  }
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────
let cleanedUp = false
function cleanup(): void {
  if (cleanedUp) return
  cleanedUp = true
  unsubscribe()
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
    <pre id="mirror" style="background:#2E2E2E;border:1px solid #3E3E3E;border-radius:12px;padding:20px;font-size:15px;line-height:1.55;white-space:pre-wrap;word-break:break-word;color:#E5E5E5;margin:0;min-height:288px;"></pre>
    <footer style="font-size:12px;color:#7B7B7B;text-align:center;margin-top:16px;">
      tap: next · long-press: action · swipe up/down: screens · double-tap: exit
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
