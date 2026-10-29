import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  PIVOTS, ACCENTS, seedThreads, seedAgents, folders, files,
  seedActivity, artifacts, seedTerminal, agentReply, seedTurns, seedChangeSets,
  seedEpochs, seedGate, seedInvariants,
} from './data.js'
import { loadConfig, saveConfig } from './llm/config.js'
import { runTurn, historyFromTurns } from './llm/router.js'
import { defaultCircuitRegistry } from './llm/circuitBreaker.js'
import { buildRunners, maybePreloadLocal } from './llm/engines.js'
import { onLocalStatus, getLocalStatus } from './llm/litert.js'
import { useTiltSpotlight } from './motion.jsx'
import { warmPi, resolveConfiguredModelId } from './llm/pi.js'
import HubPage from './pages/HubPage.jsx'
import ConversationPage from './pages/ConversationPage.jsx'
import CollectionPage from './pages/CollectionPage.jsx'
import ReviewPage from './pages/ReviewPage.jsx'
import TerminalPage from './pages/TerminalPage.jsx'
import AgentsPage from './pages/AgentsPage.jsx'
import SettingsPage from './pages/SettingsPage.jsx'
import {
  fmtTokens, parseCeiling, fleetCounts as deriveFleet, fleetVelocity, epochTurnCounts,
  facetPartition, changeSetForThread, changeSetTotals, tileForThread,
  escalationLevel, applyAutoApprove, applyParallelCap, tickAgents, treemapSpan,
  deriveEpochs, assignTurnEpochs, deriveHotWords, turnMatchesHotWord, enrichTurn,
} from './derive.js'

const SESSION_KEY = 'zunecode.session.v1'
function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const s = JSON.parse(raw)
    if (!Array.isArray(s.threads) || !s.threads.length || typeof s.turnsByThread !== 'object') return null
    return s
  } catch { return null }
}

const PIVOT_ICONS = {
  hub: '⊞',
  conversation: '▤',
  collection: '◫',
  review: '±',
  terminal: '❯_',
  agents: '❖',
  settings: '⚙',
}

export default function App() {
  const [pivot, setPivot] = useState(() => {
    const hashIdx = PIVOTS.indexOf(location.hash.replace('#', ''))
    return hashIdx >= 0 ? hashIdx : 1 // default to Conversation 3-pane workbench
  })
  const [colWidths, setColWidths] = useState({ left: 270, right: 420 })
  const startResize = useCallback((side, e) => {
    e.preventDefault()
    const startX = e.clientX
    const startLeft = colWidths.left
    const startRight = colWidths.right
    const onMove = (ev) => {
      const dx = ev.clientX - startX
      if (side === 'left') {
        setColWidths((w) => ({ ...w, left: Math.max(190, Math.min(440, startLeft + dx)) }))
      } else {
        setColWidths((w) => ({ ...w, right: Math.max(260, Math.min(620, startRight - dx)) }))
      }
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [colWidths.left, colWidths.right])
  const resetPaneWidths = useCallback(() => setColWidths({ left: 270, right: 420 }), [])

  /* four-stop semantic zoom: Z0 macro fleet map · Z1 3-column workbench ·
     Z2 decisions & mutations ledger · Z3 full-bleed focus. font size never shrinks. */
  const [zoom, setZoom] = useState(() => (location.hash === '#map' ? 0 : 1))
  const [savedSession] = useState(loadSession)
  /* savedSession may come from before the 200-turn codex thread was added; merge any new seedThreads/seedTurns */
  const [threads, setThreads] = useState(() => {
    const base = (savedSession?.threads || seedThreads).map((t) => {
      const seed = seedThreads.find((s) => s.id === t.id)
      return seed ? { ...t, scope: t.scope || seed.scope } : t
    })
    for (const st of seedThreads) {
      if (!base.some((t) => t.id === st.id)) base.push(st)
    }
    return base
  })
  const [threadId, setThreadId] = useState(() => savedSession?.threadId || 'board')
  const [agents, setAgents] = useState(seedAgents)
  const [activity, setActivity] = useState(seedActivity)
  const [folder, setFolder] = useState('fragments.auth')
  const [fileName, setFileName] = useState('AuthAndVaultStore.kt')
  const [termLines, setTermLines] = useState(seedTerminal)
  const [termInput, setTermInput] = useState('')
  const [draft, setDraft] = useState('')
  const [config, setConfig] = useState(loadConfig)
  /* (tile flip retired: f is the gutter jump now — see SPEC.md §4) */
  const motion = useMemo(() => ({ tilt: true, spotlight: true, glow: true, shimmer: true, cascade: true, ...(config.motion || {}) }), [config.motion])
  const tiltSpot = useTiltSpotlight({ tilt: motion.tilt, spotlight: motion.spotlight })
  const [localStatus, setLocalStatus] = useState(getLocalStatus)
  const [bridgeStatus, setBridgeStatus] = useState('not checked')
  const [circuitStats, setCircuitStats] = useState(() => defaultCircuitRegistry.snapshot())
  useEffect(() => onLocalStatus(setLocalStatus), [])
  useEffect(() => defaultCircuitRegistry.onChange(setCircuitStats), [])
  useEffect(() => { saveConfig(config) }, [config])
  const setCfg = useCallback((patch) => setConfig((c) => ({ ...c, ...patch })), [])
  const resetCircuits = useCallback((key) => {
    defaultCircuitRegistry.reset(key)
    setCircuitStats(defaultCircuitRegistry.snapshot())
  }, [])
  const engineSummary = config.mode === 'demo' ? 'demo · simulated'
    : config.mode === 'local' ? 'litert-lm · local'
    : config.bridgeUrl ? 'native bridge'
    : config.apiKey ? resolveConfiguredModelId(config)
    : 'litert-lm · local (no key set)'
  const [runProgress, setRunProgress] = useState(41)
  const [runLabel, setRunLabel] = useState('m1_worker_1 · implementing fragments.auth in :ui')
  const accent = ACCENTS.find((a) => a.name === config.accentName) || ACCENTS[0]
  const setAccent = useCallback((a) => setCfg({ accentName: a.name }), [setCfg])
  const theme = config.theme || 'dark'
  const setTheme = useCallback((t) => setCfg({ theme: t }), [setCfg])
  const density = config.density || 1
  const setDensity = useCallback((d) => setCfg({ density: d }), [setCfg])
  /* The theme has to reach <html>. body paints the page background and the
     inherited text colour out of --bg/--fg, and body sits outside .app — so with
     the attribute only on .app the light theme rendered black-on-dark. */
  useEffect(() => { document.documentElement.setAttribute('data-theme', theme) }, [theme])
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false) // active pivot word morphs into the search cursor
  const [altHeld, setAltHeld] = useState(false) // key hints exist only while Alt is held…
  const [helpOn, setHelpOn] = useState(false) // …or after ?
  const [cursorId, setCursorId] = useState(null) // spatial keyboard cursor: data-cursor id in the active page
  const [selectedAgentId, setSelectedAgentId] = useState('a1')
  const [turnsByThread, setTurnsByThread] = useState(() => ({ ...seedTurns, ...(savedSession?.turnsByThread || {}) }))
  /* sessions are durable: threads + turns survive reload (pi gets the same transcript as history).
     Written on a debounce, not on every state change: a streamed answer changes state
     once per token, and serialising the whole transcript on each one blocks the main
     thread for the length of the session. Diagnostics are capped so a long run cannot
     grow the payload without bound. */
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        const trimmed = {}
        for (const [tid, ts] of Object.entries(turnsByThread)) {
          trimmed[tid] = ts.map((tn) => (tn.trace || tn.stdout
            ? { ...tn, trace: tn.trace?.slice(-60), stdout: tn.stdout?.slice(-60) }
            : tn))
        }
        localStorage.setItem(SESSION_KEY, JSON.stringify({ threads, turnsByThread: trimmed, threadId }))
      } catch { /* quota */ }
    }, 600)
    return () => clearTimeout(t)
  }, [threads, turnsByThread, threadId])
  const [selectedTurn, setSelectedTurn] = useState(3) // board · turn 04 (the running one)
  const [promptOpen, setPromptOpen] = useState(false) // i — borderless prompt at the top of col 3
  const [changeSets, setChangeSets] = useState(seedChangeSets)
  const [reviewSetId, setReviewSetId] = useState('cs-board')
  const [reviewFile, setReviewFile] = useState('AuthAndVaultStore.kt')
  const [selectedHunk, setSelectedHunk] = useState(1) // hunk 02 · verifyToken()
  const [instructOpen, setInstructOpen] = useState(false) // c — inline instruction back to the agent
  const [instructDraft, setInstructDraft] = useState('')
  const [facet, setFacet] = useState('all') // Z3 segmented facet bar: all | prompts | decisions | mutations | pty | artifacts
  const [hotWordFilter, setHotWordFilter] = useState(null) // Z3 hot-word filter key (LangExtract grounded token filter)
  const [epochGrid, setEpochGrid] = useState(false) // z — 2D epoch jump grid
  const [gateResolved, setGateResolved] = useState(null) // null | 'yes' | 'no' — the [y]/[n] arbitration
  const [jumpHint, setJumpHint] = useState(null) // f — two-letter gutter jump badges (string prefix while armed)
  const [splitTurn, setSplitTurn] = useState(null) // v — Z3 pin split: turn index pinned beside the active one
  const [setDomain, setSetDomain] = useState(0) // settings col 1 selection
  const tilePolicy = useMemo(() => ({ onFail: true, onAmbiguity: true, onBigDiff: true, bigDiffLines: 250, autoApproveUnder: 0, ...(config.tilePolicy || {}) }), [config.tilePolicy])
  const gates = useMemo(() => ({ strictPcr: true, haltOnMismatch: true, advTests: true, ...(config.gates || {}) }), [config.gates])
  /* phone drill-in: at ≤760px each matrix column is its own page (Dorado-HD detail scaffold).
     levels are inert on desktop — the ≤760 CSS is the only thing that reads them. */
  const [narrow, setNarrow] = useState(() => window.innerWidth <= 760)
  const [coarse, setCoarse] = useState(() => window.matchMedia('(pointer: coarse)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(pointer: coarse)')
    const onMq = (e) => setCoarse(e.matches)
    mq.addEventListener('change', onMq)
    return () => mq.removeEventListener('change', onMq)
  }, [])
  const [convLevel, setConvLevel] = useState(0)
  const [revLevel, setRevLevel] = useState(0)
  const [colLevel, setColLevel] = useState(0)
  const [agentsLevel, setAgentsLevel] = useState(0)
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth <= 760)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const drillLevels = { conversation: convLevel, review: revLevel, collection: colLevel, agents: agentsLevel }
  const setDrillLevels = { conversation: setConvLevel, review: setRevLevel, collection: setColLevel, agents: setAgentsLevel }
  const drillLevel = drillLevels[PIVOTS[pivot]] || 0
  /* entering a drill page starts at its top, like any page turn */
  useEffect(() => {
    if (narrow) document.querySelectorAll('.page')[pivot]?.scrollTo(0, 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convLevel, revLevel, colLevel, agentsLevel, narrow])
  const [focusTick, setFocusTick] = useState(0) // retriggers 150ms focus animation

  const pivotRefs = useRef([])
  const pivotTrackRef = useRef(null)
  const jumpMapRef = useRef({}) // two-letter code -> data-cursor id, painted while f is armed
  /* f · gutter jump badges: aa as ad af… painted on every visible cursor node */
  useEffect(() => {
    const clear = () => document.querySelectorAll('[data-jump]').forEach((el) => el.removeAttribute('data-jump'))
    if (jumpHint === null) { clear(); jumpMapRef.current = {}; return }
    const KEYS = 'asdfgwercv'
    const map = {}
    cursorNodes().slice(0, KEYS.length * KEYS.length).forEach((el, i) => {
      const code = KEYS[Math.floor(i / KEYS.length)] + KEYS[i % KEYS.length]
      el.setAttribute('data-jump', code)
      map[code] = el.dataset.cursor
    })
    jumpMapRef.current = map
    return clear
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpHint])
  const promptRef = useRef(null)
  const instructRef = useRef(null)
  const touchRef = useRef(null) // touch flick → pivot pan (the phone form of Alt+←/→)
  const timers = useRef([])
  const wheelLock = useRef(0)
  const thread = threads.find((t) => t.id === threadId) || threads[0]
  const file = files.find((f) => f.name === fileName) || files[0]
  const runningAgents = useMemo(() => agents.filter((a) => a.state === 'running'), [agents])

  /* ---- pivots: active header sits on the left margin, the rest bleed off-edge ---- */
  const [pivotShift, setPivotShift] = useState(0)
  useEffect(() => {
    const el = pivotRefs.current[pivot]
    const track = pivotTrackRef.current
    if (!el || !track) return
    const pad = window.innerWidth <= 1100 ? 24 : 48
    const maxShift = Math.max(0, track.scrollWidth - (window.innerWidth - pad * 2))
    const target = Math.max(0, el.offsetLeft - track.offsetLeft - 120)
    setPivotShift(Math.min(target, maxShift))
  }, [pivot, density, zoom])

  const goPivot = useCallback((i) => {
    setZoom((z) => (z === 0 ? 1 : z))
    setPivot(Math.max(0, Math.min(PIVOTS.length - 1, i)))
  }, [])
  useEffect(() => { history.replaceState(null, '', zoom === 0 ? '#map' : '#' + PIVOTS[pivot]) }, [pivot, zoom])

  /* 2 · hub item → whole window becomes that item (150ms scale-and-fade) */
  const openThread = useCallback((id) => {
    setThreadId(id)
    setThreads((ts) => ts.map((t) => (t.id === id ? { ...t, unread: 0 } : t)))
    setFocusTick((n) => n + 1)
    setZoom(1)
    setPromptOpen(false)
    setConvLevel(1) // a chosen thread lands on its timeline page (inert on desktop)
    setPivot(PIVOTS.indexOf('conversation'))
  }, [])
  /* landing on a thread selects its running turn, else its last */
  useEffect(() => {
    const ts = turnsByThread[threadId] || []
    const ri = ts.findIndex((t) => t.state === 'running')
    const nextIdx = ri >= 0 ? ri : Math.max(0, ts.length - 1)
    setSelectedTurn(nextIdx)
    setCursorId((prev) => (prev && prev.startsWith('conv-turn:') ? `conv-turn:${nextIdx}` : prev))
    setHotWordFilter(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId])
  useEffect(() => { if (promptOpen) promptRef.current?.focus() }, [promptOpen])
  useEffect(() => { if (instructOpen) instructRef.current?.focus() }, [instructOpen])

  const openFile = useCallback((f) => {
    setFolder(f.folder); setFileName(f.name); setFocusTick((n) => n + 1); setZoom(1)
    setColLevel(2) // a chosen file lands on its code page (inert on desktop)
    setPivot(PIVOTS.indexOf('collection'))
  }, [])

  function toggleAgent(id) {
    const a = agents.find((x) => x.id === id)
    if (a && a.state !== 'running') {
      const cap = config.maxParallel ?? 10
      if (agents.filter((x) => x.state === 'running').length >= cap) {
        pushActivity(`${a.name} held · parallel cap ${cap} reached (settings 01)`)
        return
      }
    }
    setAgents((as) => as.map((x) => x.id === id
      ? { ...x, state: x.state === 'running' ? 'queued' : 'running', rate: x.state === 'running' ? 0 : (x.rate || 9000), phase: x.state === 'running' ? 'paused' : (x.phase === 'paused' || x.phase === 'awaiting slot (cap)' ? 'resumed' : x.phase), progress: x.state === 'running' ? x.progress : Math.max(x.progress, 5) } : x))
  }
  function killAgent(id) {
    setAgents((as) => as.map((x) => (x.id === id ? { ...x, state: 'stopped', progress: 0 } : x)))
    const a = agents.find((x) => x.id === id)
    if (a) pushActivity(`you killed worker ${a.name}`)
  }

  /* ---- spatial keyboard cursor: nearest [data-cursor] node by geometry ---- */
  function cursorScope() {
    if (zoom === 0) return document.querySelector('.zoommap')
    return document.querySelectorAll('.page')[pivot] || null
  }
  /* node list is cached per view-key — geometry moves at N=200 must not re-query
     the DOM on every keystroke. Invalidated whenever the rendered set can change. */
  const nodesCacheRef = useRef({ key: '', els: [] })
  useEffect(() => { nodesCacheRef.current.key = '' }, [pivot, zoom, epochGrid, convLevel, revLevel, colLevel, agentsLevel, facet, hotWordFilter, setDomain, agents, threads, changeSets, turnsByThread, gateResolved])
  function cursorNodes() {
    const key = `${pivot}|${zoom}|${epochGrid}|${convLevel}${revLevel}${colLevel}${agentsLevel}|${facet}|${hotWordFilter || ''}|${setDomain}`
    if (nodesCacheRef.current.key === key && nodesCacheRef.current.els.length) return nodesCacheRef.current.els
    const scope = cursorScope(); if (!scope) return []
    /* drilled-away columns are display:none on phones — the cursor must never land in them */
    const els = [...scope.querySelectorAll('[data-cursor]')].filter((el) => el.getBoundingClientRect().width > 0)
    nodesCacheRef.current = { key, els }
    return els
  }
  function moveCursor(dir) {
    const els = cursorNodes(); if (!els.length) return
    const cur = els.find((el) => el.dataset.cursor === cursorId)
    if (!cur) { setCursorId(els[0].dataset.cursor); return }
    const c = cur.getBoundingClientRect(); const cx = c.left + c.width / 2; const cy = c.top + c.height / 2
    let best = null; let bestScore = Infinity
    for (const el of els) {
      if (el === cur) continue
      const r = el.getBoundingClientRect(); const x = r.left + r.width / 2; const y = r.top + r.height / 2
      const dx = x - cx; const dy = y - cy
      const ok = dir === 'j' ? dy > 6 : dir === 'k' ? dy < -6 : dir === 'l' ? dx > 6 : dx < -6
      if (!ok) continue
      const score = (dir === 'j' || dir === 'k') ? Math.abs(dy) * 2 + Math.abs(dx) : Math.abs(dx) * 2 + Math.abs(dy)
      if (score < bestScore) { bestScore = score; best = el }
    }
    if (best) { setCursorId(best.dataset.cursor); best.scrollIntoView({ block: 'nearest' }) }
  }
  function activateCursor() {
    const el = cursorNodes().find((n) => n.dataset.cursor === cursorId)
    el?.click()
  }
  /* cursor id grammar: <scope>-<kind>:<id>  e.g. hub-pin:board, conv-turn:3, rev-hunk:1 */
  function cursorKind() {
    const m = /-(pin|thread|turn|agent|file|folder|set|hunk|artifact|map|epoch|facet|domain|gate):(.+)$/.exec(cursorId || '')
    return m ? { kind: m[1], id: m[2] } : null
  }
  /* the [y]/[n] arbitration: one keystroke unblocks the fleet from hub or session */
  function resolveGate(answer) {
    if (gateResolved) return false
    setGateResolved(answer)
    window.zode?.haptic?.('select')?.catch?.(() => {})
    setAgents((as) => as.map((a) => (a.id === 'a6' ? { ...a, state: 'running', phase: answer === 'yes' ? 'rerunning :dev suite' : 'strict rerun' } : a)))
    pushActivity(answer === 'yes' ? 'gate resolved · MockPcr0Provider injected in :dev only' : 'gate resolved · strict PCR0 kept, dev suite stays red')
    return true
  }
  function jumpToEpoch(ep) {
    setEpochGrid(false)
    setHotWordFilter(null)
    setSelectedTurn(ep.anchor)
    setCursorId(`conv-turn:${ep.anchor}`)
    setPivot(PIVOTS.indexOf('conversation'))
    if (zoom === 0) setZoom(1)
    pushActivity(`epoch jump · E${String(ep.n).padStart(2, '0')} ${ep.name}`)
  }
  function onSpanClick(span) {
    if (!span) return
    if (span.target?.type === 'hunk') {
      const cs = changeSets.find((c) => c.files.some((f) => f.name === span.target.file)) || reviewSet
      if (cs) {
        setReviewSetId(cs.id)
        setReviewFile(span.target.file)
        const fObj = cs.files.find((f) => f.name === span.target.file)
        if (fObj && span.target.line) {
          const hi = fObj.hunks.findIndex((h) => Math.abs((h.line || 0) - span.target.line) <= 30)
          setSelectedHunk(hi >= 0 ? hi : 0)
        } else {
          setSelectedHunk(0)
        }
        setZoom(1)
        goPivot(PIVOTS.indexOf('review'))
        pushActivity(`grounded span · ${span.text} → review`)
        return
      }
    }
    if (span.target?.type === 'file') {
      const f = files.find((x) => x.name === span.target.file)
      if (f) {
        openFile(f)
        pushActivity(`grounded span · ${span.text} → collection`)
        return
      }
    }
    setHotWordFilter((cur) => (cur === span.key ? null : span.key))
    if (PIVOTS[pivot] === 'conversation' && zoom < 3) setZoom(3)
  }
  /* hunk triage: mutate exactly one hunk's review state */
  function setHunkState(state, comment) {
    window.zode?.haptic?.('select')?.catch?.(() => {})
    setChangeSets((css) => css.map((cs) => cs.id !== reviewSetId ? cs : {
      ...cs,
      files: cs.files.map((f) => f.name !== reviewFile ? f : {
        ...f,
        hunks: f.hunks.map((h, i) => (i === selectedHunk ? { ...h, state, ...(comment !== undefined ? { comment } : {}) } : h)),
      }),
    }))
  }
  function cursorAction(key) {
    const t = cursorKind(); if (!t) return false
    const here = PIVOTS[pivot]
    if (here === 'settings' && key === 'r') {
      if (setDomain === 0) {
        setCfg({
          thinkingLevel: 'off',
          circuitBreaker: { enabled: true, failureThreshold: 4, successThreshold: 2, timeoutSeconds: 60 },
          rectifier: { enabled: true, requestThinkingSignature: true, requestThinkingBudget: true, inlineThink: true },
          optimizer: { enabled: true, cacheInjection: true },
          modelMapping: { haikuModel: '', sonnetModel: '', opusModel: '', fableModel: '', subagentModel: '', defaultModel: '' },
        })
        resetCircuits()
      }
      else if (setDomain === 1) setCfg({ tilePolicy: { onFail: true, onAmbiguity: true, onBigDiff: true, bigDiffLines: 250, autoApproveUnder: 0 } })
      else if (setDomain === 2) setCfg({ gates: { strictPcr: true, haltOnMismatch: true, advTests: true } })
      else if (setDomain === 4) setCfg({ accentName: 'magenta', theme: 'dark', density: 1, motion: { tilt: true, spotlight: true, glow: true, shimmer: true, cascade: true } })
      pushActivity('settings domain reset to defaults')
      return true
    }
    if (here === 'review') {
      if (t.kind !== 'hunk') return false
      if (key === 'a') { setHunkState('STAGED'); pushActivity(`hunk ${Number(t.id) + 1} of ${reviewFile} approved · staged`); return true }
      if (key === 'x') { setHunkState('REJECTED'); pushActivity(`hunk ${Number(t.id) + 1} of ${reviewFile} rejected`); return true }
      if (key === 'c') { setInstructOpen(true); return true }
      return false
    }
    if (here === 'conversation') {
      if (key === 'r') { goPivot(PIVOTS.indexOf('review')); return true }
      if (key === 'y') {
        const turn = (turnsByThread[threadId] || [])[selectedTurn]
        const name = t.kind === 'artifact' ? t.id : turn?.artifacts?.[0]
        if (!name) return false
        navigator.clipboard?.writeText(name).catch(() => {})
        pushActivity(`copied artifact ${name}`)
        return true
      }
    }
    if ((key === 'y' || key === 'n') && !gateResolved && ((t.kind === 'pin' && t.id === seedGate.threadId) || t.kind === 'gate' || (here === 'conversation' && threadId === seedGate.threadId && zoom === 3))) {
      return resolveGate(key === 'y' ? 'yes' : 'no')
    }
    if (key === 'p' && (t.kind === 'pin' || t.kind === 'thread')) { togglePin(t.id); return true }
    if (key === 'p' && t.kind === 'agent') { toggleAgent(t.id); return true }
    if (key === 'x' && t.kind === 'agent') { killAgent(t.id); return true }
    if (key === 'd' && t.kind === 'agent') { setSelectedAgentId(t.id); goPivot(PIVOTS.indexOf('review')); return true }
    if (key === ' ' && t.kind === 'agent') { setSelectedAgentId(t.id); goPivot(PIVOTS.indexOf('agents')); return true }
    if (key === 'a' && t.kind === 'file' && here === 'collection') { setDraft(`explain ${t.id} and suggest the smallest safe refactor`); openThread(threadId); setPromptOpen(true); return true }
    return false
  }

  /* paint the cursor: 3px accent bar in the left gutter + full-brightness title */
  useEffect(() => {
    document.querySelectorAll('.cursorfocus').forEach((el) => { el.classList.remove('cursorfocus'); el.removeAttribute('aria-current') })
    if (!cursorId) return
    const scope = zoom === 0 ? document.querySelector('.zoommap') : document.querySelectorAll('.page')[pivot]
    const focusEl = scope?.querySelector(`[data-cursor="${CSS.escape(cursorId)}"]`)
    if (focusEl) { focusEl.classList.add('cursorfocus'); focusEl.setAttribute('aria-current', 'true') }
    const t = /-agent:(.+)$/.exec(cursorId)
    if (t) setSelectedAgentId(t[1])
    /* resting the cursor IS the selection in the two matrix pivots — cols 2/3 follow instantly */
    if (cursorId.startsWith('conv-thread:')) {
      const id = cursorId.slice('conv-thread:'.length)
      if (id !== threadId) { setThreadId(id); setThreads((ts) => ts.map((x) => (x.id === id ? { ...x, unread: 0 } : x))) }
    }
    if (cursorId.startsWith('conv-turn:') && zoom === 1) {
      const idx = Number(cursorId.slice('conv-turn:'.length))
      const maxIdx = Math.max(0, (turnsByThread[threadId]?.length || 1) - 1)
      setSelectedTurn(Math.min(idx, maxIdx))
    }
    if (cursorId.startsWith('rev-set:')) {
      const id = cursorId.slice('rev-set:'.length)
      if (id !== reviewSetId) {
        setReviewSetId(id)
        const cs = changeSets.find((c) => c.id === id)
        if (cs?.files[0]) { setReviewFile(cs.files[0].name); setSelectedHunk(0) }
      }
    }
    if (cursorId.startsWith('rev-file:')) {
      const name = cursorId.slice('rev-file:'.length)
      if (name !== reviewFile) { setReviewFile(name); setSelectedHunk(0) }
    }
    if (cursorId.startsWith('rev-hunk:')) setSelectedHunk(Number(cursorId.slice('rev-hunk:'.length)))
    if (cursorId.startsWith('set-domain:') && /^\d+$/.test(cursorId.slice('set-domain:'.length))) setSetDomain(Number(cursorId.slice('set-domain:'.length)))
  }, [cursorId, pivot, zoom, threads, agents, folder, threadId, reviewSetId, reviewFile, changeSets])
  /* land the cursor on the active selection (or first node) whenever the pivot or zoom changes */
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const scope = zoom === 0 ? document.querySelector('.zoommap') : document.querySelectorAll('.page')[pivot]
      if (!scope) return
      const visible = [...scope.querySelectorAll('[data-cursor]')].filter((el) => el.getBoundingClientRect().width > 0)
      const preferred = PIVOTS[pivot] === 'conversation' && zoom === 1
        ? visible.find((el) => el.dataset.cursor === `conv-thread:${threadId}`) || visible.find((el) => el.dataset.cursor === `conv-turn:${selectedTurn}`)
        : PIVOTS[pivot] === 'conversation' && zoom >= 2
          ? visible.find((el) => el.dataset.cursor === `conv-turn:${selectedTurn}`)
          : PIVOTS[pivot] === 'review' && zoom === 1
            ? visible.find((el) => el.dataset.cursor === `rev-set:${reviewSetId}`)
            : null
      const chosen = preferred || visible[0]
      setCursorId(chosen ? chosen.dataset.cursor : null)
    })
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pivot, zoom, convLevel, revLevel, colLevel, agentsLevel])

  /* ---- keyboard-first ---- */
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Alt') setAltHeld(true)
      const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName || '')
      const onButton = document.activeElement?.tagName === 'BUTTON'
      if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); goPivot(pivot + 1) }
      else if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); goPivot(pivot - 1) }
      else if (e.altKey && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); newThread() }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setSearchOpen(true) }
      else if (e.metaKey && /^[1-9]$/.test(e.key)) { e.preventDefault(); const s = threads[Number(e.key) - 1]; if (s) openThread(s.id) } // Tier-1 sessions: Cmd+1..9
      else if (e.ctrlKey && /^[1-7]$/.test(e.key)) { e.preventDefault(); goPivot(Number(e.key) - 1) }
      else if ((e.ctrlKey || e.metaKey) && (e.key === '-' || e.key === '_')) { e.preventDefault(); setZoom((z) => Math.max(0, z - 1)) } // semantic zoom: one stop out
      else if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) { e.preventDefault(); setZoom((z) => Math.min(3, z + 1)) }
      else if (e.key === 'Escape') {
        if (jumpHint !== null) setJumpHint(null)
        else if (epochGrid) setEpochGrid(false)
        else if (searchOpen) { setSearchOpen(false); setQuery('') }
        else if (promptOpen) { setPromptOpen(false) }
        else if (instructOpen) { setInstructOpen(false); setInstructDraft('') }
        else if (hotWordFilter !== null) setHotWordFilter(null)
        else if (splitTurn !== null) setSplitTurn(null)
        else if (zoom === 1 && narrow && drillLevel > 0) setDrillLevels[PIVOTS[pivot]](drillLevel - 1)
        else { setZoom((z) => Math.max(0, z - 1)); if (typing) document.activeElement.blur() }
      }
      else if (e.key === 'Tab' && !typing) {
        e.preventDefault()
        if (zoom === 3 && PIVOTS[pivot] === 'conversation') {
          const F = ['all', 'prompts', 'decisions', 'mutations', 'pty', 'artifacts']
          setFacet(F[(F.indexOf(facet) + (e.shiftKey ? -1 : 1) + F.length) % F.length])
        } else goPivot((pivot + (e.shiftKey ? -1 : 1) + PIVOTS.length) % PIVOTS.length)
      }
      else if (!typing && jumpHint !== null && /^[a-z]$/.test(e.key)) {
        e.preventDefault()
        const next = jumpHint + e.key
        const hit = jumpMapRef.current[next]
        if (hit) { setCursorId(hit); setJumpHint(null) }
        else if (Object.keys(jumpMapRef.current).some((c) => c.startsWith(next))) setJumpHint(next)
        else setJumpHint(null)
      }
      else if (!typing && zoom === 0 && /^[a-z]$/.test(e.key)) {
        const el = document.querySelector(`.zoommap [data-badge="${e.key}"]`)
        if (el) { e.preventDefault(); el.click() }
        else if (['h', 'j', 'k', 'l'].includes(e.key)) { e.preventDefault(); moveCursor(e.key) }
      }
      else if (!typing && (e.key === '[' || e.key === ']')) { e.preventDefault(); goPivot(pivot + (e.key === ']' ? 1 : -1)) }
      else if (!typing && e.key === 'z' && (PIVOTS[pivot] === 'conversation' || PIVOTS[pivot] === 'hub')) { e.preventDefault(); setEpochGrid((g) => !g) }
      else if (!typing && e.key === 'v' && zoom === 3 && PIVOTS[pivot] === 'conversation') { e.preventDefault(); setSplitTurn((s) => (s === selectedTurn ? null : selectedTurn)) }
      else if (!typing && e.key === 'f') { e.preventDefault(); setJumpHint('') }
      else if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key === '/' || e.key === ':')) { e.preventDefault(); setSearchOpen(true) }
      else if (!typing && e.key === '?') { e.preventDefault(); setHelpOn((h) => !h) }
      else if (!typing && ['h', 'j', 'k', 'l'].includes(e.key)) { e.preventDefault(); moveCursor(e.key) }
      else if (!typing && e.key.startsWith('Arrow')) { e.preventDefault(); moveCursor({ ArrowDown: 'j', ArrowUp: 'k', ArrowRight: 'l', ArrowLeft: 'h' }[e.key]) }
      else if (!typing && e.key === 'i' && PIVOTS[pivot] === 'conversation' && zoom !== 0) { e.preventDefault(); setPromptOpen(true); setConvLevel(2) }
      else if (!typing && !onButton && (e.key === 'Enter')) {
        e.preventDefault()
        /* Enter is the z-axis: Z1 matrix → Z2 ledger → Z3 full-bleed. Esc steps back. */
        if ((PIVOTS[pivot] === 'conversation' || PIVOTS[pivot] === 'review') && (zoom === 1 || zoom === 2) && cursorId) setZoom(zoom + 1)
        else activateCursor()
      }
      else if (!typing && !onButton && e.key === ' ') {
        e.preventDefault()
        if (PIVOTS[pivot] === 'conversation' && zoom === 1) setPromptOpen(true)
        else if (!cursorAction(' ')) activateCursor()
      }
      else if (!typing && ['p', 'd', 'x', 'a', 'c', 'r', 'y', 'n'].includes(e.key)) { if (cursorAction(e.key)) e.preventDefault() }
    }
    const onUp = (e) => { if (e.key === 'Alt') setAltHeld(false) }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onUp)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onUp) }
  })

  /* ---- touch: horizontal flick pans pivots (Zune HD crossbar gesture); vertical stays scroll.
          two-finger pinch is semantic zoom: fingers close -> step out to the map, spread -> step in. ---- */
  const pinchRef = useRef(null)
  const pinchDist = (e) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY)
  const onTouchStart = (e) => {
    if (e.touches.length === 2) { pinchRef.current = pinchDist(e); touchRef.current = null; return }
    const t = e.touches[0]; touchRef.current = { x: t.clientX, y: t.clientY }
  }
  const onTouchMove = (e) => {
    if (e.touches.length !== 2 || pinchRef.current == null) return
    if (/INPUT|TEXTAREA/.test(document.activeElement?.tagName || '')) return
    const d = pinchDist(e)
    if (d < pinchRef.current * 0.72) { setZoom((z) => Math.max(0, z - 1)); pinchRef.current = d }
    else if (d > pinchRef.current * 1.38) { setZoom((z) => Math.min(3, z + 1)); pinchRef.current = d }
  }
  const onTouchDone = (e) => { if (e.touches.length < 2) pinchRef.current = null }
  const onTouchEnd = (e) => {
    const s = touchRef.current; touchRef.current = null
    if (!s || /INPUT|TEXTAREA/.test(document.activeElement?.tagName || '')) return
    const t = e.changedTouches[0]
    const dx = t.clientX - s.x; const dy = t.clientY - s.y
    if (Math.abs(dx) < 64 || Math.abs(dx) < Math.abs(dy) * 1.6) return
    /* drilled in on a phone, a rightward flick is Back (Dorado-HD scaffold), not previous pivot */
    if (dx > 0 && narrow && zoom === 1 && drillLevel > 0) { setDrillLevels[PIVOTS[pivot]](drillLevel - 1); return }
    goPivot(pivot + (dx < 0 ? 1 : -1))
  }
  /* the baseline is tappable: on touch devices it is the application bar, not a keyboard reminder */
  function runStripAction(k) {
    if (k === 'enter') {
      if ((PIVOTS[pivot] === 'conversation' || PIVOTS[pivot] === 'review') && (zoom === 1 || zoom === 2) && cursorId) setZoom(zoom + 1)
      else activateCursor()
    } else if (k === 'i') { setPromptOpen(true); setConvLevel(2) }
    else if (k === 'space') { if (PIVOTS[pivot] === 'conversation') { setPromptOpen(true); setConvLevel(2) } else if (!cursorAction(' ')) activateCursor() }
    else if (k === '/') setSearchOpen(true)
    else if (k === 'z') setEpochGrid(true)
    else if (k === 'tab') { const F = ['all', 'prompts', 'decisions', 'mutations', 'pty', 'artifacts']; setFacet(F[(F.indexOf(facet) + 1) % F.length]) }
    else if (k === 'v') setSplitTurn((s) => (s === selectedTurn ? null : selectedTurn))
    else if (k === 'ctrl + −') setZoom(0)
    else if (k === 'alt + →') goPivot(pivot + 1)
    else cursorAction(k)
  }
  function scrollPayloadIntoView() {
    if (window.innerWidth > 760) return
    requestAnimationFrame(() => document.querySelectorAll('.page')[pivot]?.querySelector('[data-payload]')?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }

  /* ---- trackpad: ctrl+wheel is semantic zoom; horizontal scroll stays inside code/diff panes ---- */
  const onWheel = (e) => {
    if (e.ctrlKey || e.metaKey) {
      if (Date.now() - wheelLock.current < 350) return
      wheelLock.current = Date.now()
      setZoom((z) => (e.deltaY > 0 ? Math.max(0, z - 1) : Math.min(3, z + 1)))
    }
  }

  /* ---- live fleet tick: agents advance, tokens burn, ceilings and caps bite.
        everything downstream (tiles, heartbeat, velocity) derives from this. ---- */
  const ceilingHitRef = useRef(false)
  useEffect(() => {
    const id = setInterval(() => {
      if (document.hidden) return
      setAgents((as) => {
        let { agents: next, events } = tickAgents(as, 1.6)
        next = applyParallelCap(next, config.maxParallel ?? 10).agents
        /* ceiling is per-epoch/session burn, not lifetime: only pause if an explicit ceiling is set */
        const baseline = seedAgents.reduce((n, a) => n + (a.tokens || 0), 0)
        const spent = next.reduce((n, a) => n + (a.tokens || 0), 0) - baseline
        const ceiling = parseCeiling(config.tokenCeiling || 'unlimited')
        if (spent >= ceiling && next.some((a) => a.state === 'running')) {
          next = next.map((a) => (a.state === 'running' ? { ...a, state: 'queued', rate: 0, phase: 'token ceiling reached' } : a))
          if (!ceilingHitRef.current) { ceilingHitRef.current = true; events.push(`token ceiling ${config.tokenCeiling} reached · fleet paused (settings 01)`) }
        } else {
          ceilingHitRef.current = false
          /* keep the active test/mutation worker loop alive if no ceiling is tripped */
          if (!next.some((a) => a.state === 'running')) {
            next = next.map((a) => (a.id === 'a1' ? { ...a, state: 'running', progress: 38, pass: 18, rate: 14800, phase: 'testing' } : a))
          }
        }
        if (events.length) queueMicrotask(() => events.forEach((e) => pushActivity(e)))
        return next
      })
    }, 1600)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.maxParallel, config.tokenCeiling])
  /* the running turn in the timeline mirrors its worker, live */
  useEffect(() => {
    const a1 = agents.find((a) => a.id === 'a1')
    if (!a1) return
    setTurnsByThread((m) => {
      const ts = m.board || []
      const i = ts.findIndex((t) => t.state === 'running')
      if (i < 0) return m
      const done = a1.state !== 'running'
      if (!done && ts[i].progress === a1.progress) return m
      const out = [...ts]
      out[i] = { ...ts[i], progress: a1.progress, ...(done ? { state: undefined, age: 'now', summary: '4-tier test infrastructure · complete' } : {}) }
      return { ...m, board: out }
    })
  }, [agents])
  /* auto-approve policy stages small hunks the moment it is enabled */
  useEffect(() => {
    const { changeSets: next, changed } = applyAutoApprove(changeSets, tilePolicy)
    if (changed) { setChangeSets(next); pushActivity(`auto-approved ${changed} hunk${changed > 1 ? 's' : ''} under ${tilePolicy.autoApproveUnder} lines`) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tilePolicy.autoApproveUnder])
  /* gates are real: dropping strict PCR0 moots the arbitration */
  useEffect(() => {
    if (!gates.strictPcr && !gateResolved) {
      setGateResolved('yes')
      setAgents((as) => as.map((a) => (a.id === 'a6' ? { ...a, state: 'running', phase: 'rerunning :dev suite' } : a)))
      pushActivity('strict PCR0 disabled · gate moot, mock allowed everywhere (settings 03)')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gates.strictPcr])
  useEffect(() => () => timers.current.forEach(clearTimeout), [])
  /* Warm the engine graph while the shell sits idle: the first turn then starts
     streaming instead of downloading and parsing ~1 MB of JS on the critical path. */
  useEffect(() => warmPi(config), [config.provider])
  useEffect(() => {
    const zode = window.zode
    if (!zode) return undefined
    const unsubs = [
      zode.onAttachment?.((att) => {
        const name = att?.name || 'attachment'
        window.zode?.haptic?.('drop')?.catch?.(() => {})
        pushActivity(`attached ${name} (${att?.source || 'drop'})`)
        setDraft((d) => (d ? `${d} @${name}` : `inspect @${name}`))
        setPromptOpen(true)
        setPivot(PIVOTS.indexOf('conversation'))
      }),
      zode.onSearch?.(({ query: q }) => {
        if (q) { setQuery(q); setSearchOpen(true) }
      }),
      zode.onDeepLink?.(({ url }) => {
        const raw = String(url || '').replace(/^zode:\/\//i, '').split(/[/?#]/)[0].toLowerCase()
        const idx = PIVOTS.indexOf(raw === 'agent' ? 'agents' : raw)
        if (idx >= 0) { setZoom(1); setPivot(idx) }
      }),
      zode.onIntent?.(({ intent, payload }) => {
        if (intent === 'zode.search' && payload?.query) { setQuery(String(payload.query)); setSearchOpen(true) }
        else if (intent === 'zode.agent.newTask') {
          if (payload?.prompt) setDraft(String(payload.prompt))
          setPivot(PIVOTS.indexOf('conversation'))
          setPromptOpen(true)
        } else if (intent === 'zode.show' && payload?.view) {
          const v = String(payload.view).toLowerCase()
          const idx = PIVOTS.indexOf(v === 'agent' ? 'agents' : v)
          if (idx >= 0) { setZoom(1); setPivot(idx) }
        }
      }),
    ].filter(Boolean)
    return () => unsubs.forEach((fn) => fn())
  }, [])

  function pushActivity(what) { setActivity((a) => [{ when: 'now', what }, ...a].slice(0, 8)) }

  function newThread() {
    const id = 't' + Date.now()
    const t = { id, title: 'New Conversation', project: 'fragments', age: 'now', pinned: false, unread: 0, status: 'empty', messages: [] }
    setThreads((ts) => [t, ...ts])
    setTurnsByThread((m) => ({ ...m, [id]: [] }))
    openThread(id)
    setPromptOpen(true)
    setConvLevel(2)
  }

  function togglePin(id) {
    setThreads((ts) => ts.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t)))
  }

  const sendingRef = useRef(false)
  /* send: append user + agent TURN rows, then run the real engine chain (router.js):
     bridge -> remote (pi agent loop + workspace tools) -> LiteRT-LM local on error. */
  async function send() {
    const text = draft.trim(); if (!text || sendingRef.current) return
    /* ! escapes to the pty: the rest of the line is a shell command, not a prompt. */
    if (text.startsWith('!')) {
      const cmd = text.slice(1).trim()
      setDraft('')
      if (cmd) { runTerm(cmd); goPivot(PIVOTS.indexOf('terminal')) }
      return
    }
    sendingRef.current = true
    setDraft('')
    setPromptOpen(false)
    const id = thread.id
    const existing = turnsByThread[id] || []
    const history = historyFromTurns(existing)
    const titleFromDraft = existing.length === 0 ? text.slice(0, 44) : thread.title
    setThreads((ts) => ts.map((t) => (t.id === id ? { ...t, title: titleFromDraft, status: 'agent running' } : t)))
    const wsCtx = { files, folders, changeSets }
    const userTurn = enrichTurn({ actor: 'user', kind: 'prompt', age: 'now', intent: text, synthesis: text, stats: [], artifacts: [], full: text, trace: [], stdout: [] }, wsCtx)
    const agentTurn = { actor: 'agent', engine: engineSummary, age: 'running', state: 'running', progress: 2, summary: 'working…', intent: text, synthesis: '', stats: [], artifacts: [], full: '', trace: [], stdout: [] }
    setTurnsByThread((m) => ({ ...m, [id]: [...(m[id] || []), userTurn, agentTurn] }))
    setSelectedTurn(existing.length + 1)
    setCursorId(`conv-turn:${existing.length + 1}`)
    setRunProgress(3); setRunLabel(`${engineSummary} · ${text.slice(0, 52)}`)
    pushActivity(`you asked: ${text.slice(0, 48)}`)
    /* @mentions resolve against the workspace and ride along as engine context. */
    const refs = resolveMentions(text)
    const prompt = refs.length
      ? `${text}\n\n[referenced]\n${refs.map((r) => `- ${r.kind}: ${r.name} — ${r.detail}`).join('\n')}`
      : text
    if (refs.length) pushActivity(`referenced ${refs.map((r) => r.name).join(', ')}`)
    window.zode?.haptic?.('working', { loop: true })?.catch?.(() => {})
    const patchTurn = (patch) => setTurnsByThread((m) => {
      const ts = [...(m[id] || [])]
      if (!ts.length) return m
      ts[ts.length - 1] = { ...ts[ts.length - 1], ...(typeof patch === 'function' ? patch(ts[ts.length - 1]) : patch) }
      return { ...m, [id]: ts }
    })
    /* Coalesce the token stream. The provider emits chunks far faster than anyone
       reads them, and flushing every one of them re-rendered the whole app and
       rewrote the session snapshot. One flush every 50ms reads as smooth and is
       roughly 30x cheaper. */
    let tokenText = ''
    let tokenTimer = 0
    const flushTokens = () => {
      tokenTimer = 0
      if (!tokenText) return
      const text = tokenText
      tokenText = ''
      patchTurn({ synthesis: text, full: text })
      setRunProgress(Math.min(96, 4 + Math.ceil(text.length / 14)))
    }
    const stopTokens = () => { if (tokenTimer) { clearTimeout(tokenTimer); tokenTimer = 0 } tokenText = '' }
    try {
      const runners = buildRunners(config, { files, folders, changeSets }, agentReply)
      const result = await runTurn({
        config, prompt, history, runners,
        hooks: {
          sessionId: id,
          onEngine: (name) => patchTurn({ engine: name }),
          onCircuit: (snap) => setCircuitStats(snap),
          onToken: (soFar) => { tokenText = soFar; if (!tokenTimer) tokenTimer = setTimeout(flushTokens, 50) },
          onThinking: (thought) => patchTurn({ thinking: thought }),
          onTrace: (line) => patchTurn((t) => ({ trace: [...(t.trace || []), line] })),
          onStatus: (line) => patchTurn((t) => ({ trace: [...(t.trace || []), line] })),
        },
      })
      stopTokens()
      const firstLine = result.text.split('\n').find((l) => l.trim()) || 'complete'
      patchTurn((prev) => enrichTurn({
        ...prev,
        actor: result.label, engine: result.label, synthesis: result.text, full: result.text,
        summary: undefined, kind: undefined, decision: undefined,
        age: 'now', state: undefined, progress: 100,
        ...(result.fallbackFrom ? { fallbackFrom: result.fallbackFrom } : {}),
      }, wsCtx))
      setRunProgress(100)
      setThreads((ts) => ts.map((t) => (t.id === id ? { ...t, status: 'complete' } : t)))
      pushActivity(`${result.label} finished${result.fallbackFrom ? ' (remote failed, answered locally)' : ''}`)
      window.zode?.hapticStop?.('working')?.catch?.(() => {})
      window.zode?.haptic?.('done')?.catch?.(() => {})
      window.zode?.notify?.({ title: 'Zode', body: firstLine.slice(0, 72) })?.catch?.(() => {})
      maybePreloadLocal(config, result.engine)
    } catch (e) {
      stopTokens()
      const msg = String(e?.message || e)
      patchTurn({
        actor: 'engine error', engine: 'error', synthesis: `No engine could answer.\n${msg}\n\nFix it in settings: add an API key (anthropic / openai), start the native bridge, or load the local LiteRT-LM model. Mode is currently "${config.mode}".`,
        full: msg, summary: 'engine error — see payload', age: 'now', state: undefined, progress: 100,
      })
      setThreads((ts) => ts.map((t) => (t.id === id ? { ...t, status: 'engine error' } : t)))
      pushActivity(`engine error: ${msg.slice(0, 60)}`)
      window.zode?.hapticStop?.('working')?.catch?.(() => {})
      window.zode?.haptic?.('error')?.catch?.(() => {})
    } finally {
      stopTokens()
      sendingRef.current = false
    }
  }

  /* c in review: send the instruction back to the worker who wrote the hunk */
  function sendInstruction() {
    const text = instructDraft.trim(); if (!text) return
    setHunkState('INSTRUCTED', text)
    setInstructOpen(false); setInstructDraft('')
    pushActivity(`you instructed a rewrite of hunk ${selectedHunk + 1} in ${reviewFile}`)
  }

  function runTerm(cmdRaw) {
    const cmd = cmdRaw.trim()
    const out = {
      help: ['commands: test · build · status · clear · whoami'],
      test: ['29 suites · 0 failures · 41s'],
      build: [':ui:assembleDebug · BUILD SUCCESSFUL in 12s'],
      status: [' M ui/MacosChromeApp.kt', '?? fragments.auth/AuthAndVaultStore.kt'],
      whoami: ['mac · fragments · teamwork_preview'],
    }[cmd] || (cmd ? [`${cmd}: simulated shell — try help`] : [])
    if (cmd === 'clear') { setTermLines([]) } else setTermLines((l) => [...l, `$ ${cmd}`, ...out])
    setTermInput('')
    if (cmd) pushActivity(`terminal · ${cmd}`)
  }

  const searchHits = useMemo(() => {
    const q = query.trim().toLowerCase(); if (!q) return []
    return [
      ...threads.filter((t) => t.title.toLowerCase().includes(q)).map((t) => ({ kind: 'thread', label: t.title, go: () => openThread(t.id) })),
      ...files.filter((f) => f.name.toLowerCase().includes(q)).map((f) => ({ kind: 'file', label: f.name, go: () => openFile(f) })),
      ...agents.filter((a) => a.name.includes(q)).map((a) => ({ kind: 'agent', label: a.name, go: () => { setSelectedAgentId(a.id); goPivot(PIVOTS.indexOf('agents')) } })),
    ].slice(0, 7)
  }, [query, threads, agents, openThread, openFile, goPivot])

  /* command ribbon filters the underlying grid in place: non-matching nodes dim */
  useEffect(() => {
    const q = searchOpen ? query.trim().toLowerCase() : ''
    const scope = zoom === 0 ? document.querySelector('.zoommap') : document.querySelectorAll('.page')[pivot]
    scope?.querySelectorAll('[data-cursor]').forEach((el) => {
      el.classList.toggle('searchdim', !!q && !el.textContent.toLowerCase().includes(q))
    })
  }, [query, searchOpen, pivot, zoom])

  const style = {
    '--accent': accent.value,
    '--accent-hover': accent.hover,
    '--accent-pressed': accent.pressed,
    '--scale': density,
    '--col1-w': `${colWidths.left}px`,
    '--col3-w': `${colWidths.right}px`,
  }

  const unreviewed = changeSets.reduce((n, cs) => n + cs.files.reduce((m, f) => m + f.hunks.filter((h) => h.state === 'UNREVIEWED').length, 0), 0)
  const pivotCounts = { conversation: threads.reduce((n, t) => n + t.unread, 0), agents: runningAgents.length, review: unreviewed }

  /* matrix selections, shared by render + baseline */
  const workspaceCtx = useMemo(() => ({ files, folders, changeSets }), [changeSets])
  const rawTurns = turnsByThread[threadId] || []
  const derivedEpochs = useMemo(
    () => deriveEpochs(rawTurns, seedEpochs, config.epochs, workspaceCtx, threadId),
    [rawTurns, config.epochs, workspaceCtx, threadId],
  )
  const turns = useMemo(
    () => assignTurnEpochs(rawTurns, derivedEpochs, workspaceCtx),
    [rawTurns, derivedEpochs, workspaceCtx],
  )
  const activeTurn = turns[Math.min(selectedTurn, Math.max(0, turns.length - 1))] || null
  const reviewSet = changeSets.find((c) => c.id === reviewSetId) || changeSets[0]
  const reviewFileObj = reviewSet?.files.find((f) => f.name === reviewFile) || reviewSet?.files[0] || null
  const activeHunk = reviewFileObj?.hunks[Math.min(selectedHunk, Math.max(0, (reviewFileObj?.hunks.length || 1) - 1))] || null

  /* contextual baseline: actions belong to the node under the cursor, nothing else */
  const ck = cursorKind()
  const cursorThread = ck && (ck.kind === 'pin' || ck.kind === 'thread') ? threads.find((t) => t.id === ck.id) : null
  const cursorAgent = ck && ck.kind === 'agent' ? agents.find((a) => a.id === ck.id) : null
  const stripLabel = PIVOTS[pivot] === 'review' && activeHunk
    ? `${reviewFileObj.name} · hunk ${selectedHunk + 1}/${reviewFileObj.hunks.length}`
    : PIVOTS[pivot] === 'conversation' && activeTurn
      ? `${thread.title} · turn ${String(Math.min(selectedTurn, Math.max(0, turns.length - 1)) + 1).padStart(2, '0')}`
      : cursorThread ? cursorThread.title
        : cursorAgent ? cursorAgent.name
          : ck && ck.kind === 'domain' ? ['agent pool & routing', 'telemetry tile thresholds', 'sandbox & enclave gates', 'keyboard & semantic zoom', 'typography & swiss grid', 'daemons & local endpoints'][Number(ck.id)] || 'settings'
            : ck ? ck.id : PIVOTS[pivot]
  const gateOpen = !gateResolved
  const stripActions = zoom === 3 && PIVOTS[pivot] === 'conversation'
    ? [['tab', 'slice facet'], ['z', 'epoch jump grid'], ...(gateOpen && threadId === seedGate.threadId ? [['y', seedGate.yes], ['n', seedGate.no]] : []), ['v', splitTurn !== null ? 'unsplit' : 'pin split'], ['i', 'prompt']]
    : zoom === 2 && (PIVOTS[pivot] === 'conversation' || PIVOTS[pivot] === 'review')
      ? [['enter', 'dive to Z3'], ['z', 'epoch jump grid'], ['esc', 'back to matrix']]
      : PIVOTS[pivot] === 'review' && zoom !== 0
        ? [['a', 'approve hunk'], ['x', 'reject'], ['c', 'instruct agent'], ['enter', zoom === 1 ? 'ledger (Z2)' : 'expand full file']]
        : PIVOTS[pivot] === 'conversation' && zoom !== 0
          ? [['i', 'prompt / reply'], ['enter', 'ledger (Z2)'], ['z', 'epochs'], ['r', 'jump to review diff'], ['y', 'copy artifact']]
          : cursorAgent
            ? [['space', 'inspect logs'], ['p', cursorAgent.state === 'running' ? 'pause worker' : 'run worker'], ['d', 'diff'], ['x', 'kill']]
            : cursorThread
              ? [['enter', 'dive into session (Z+)'], ...(gateOpen && cursorThread.id === seedGate.threadId && ck?.kind === 'pin' ? [['y', seedGate.yes], ['n', seedGate.no]] : []), ['p', cursorThread.pinned ? 'unpin' : 'pin to hub'], ['f', 'jump hints']]
              : ck && ck.kind === 'file'
                ? [['enter', 'open'], ['a', 'ask about file']]
                : ck
                  ? [['enter', 'open']]
                  : [['hjkl', 'move 2D grid'], ['enter', 'dive (Z+)'], ['f', 'jump hints'], [':', 'command ribbon']]
  const telemetryAgent = agents.find((a) => a.id === (cursorAgent ? cursorAgent.id : selectedAgentId)) || agents[0]
  const showHints = altHeld || helpOn

  /* ---- derivations: everything below traces to live state via derive.js ---- */
  const facets = useMemo(() => facetPartition(turns), [turns])
  const promptTurns = facets.prompts
  const decisionTurns = facets.decisions
  const sessionChangeSet = useMemo(() => changeSetForThread(thread, changeSets) || reviewSet, [thread, changeSets, reviewSet])
  const sessionHunks = useMemo(() => sessionChangeSet.files.flatMap((f) => f.hunks.map((h) => ({ ...h, file: f.name }))), [sessionChangeSet])
  const facetCounts = {
    all: turns.length,
    prompts: facets.prompts.length,
    decisions: facets.decisions.length,
    mutations: sessionHunks.length,
    pty: facets.pty.length,
    artifacts: [...new Set(turns.flatMap((t) => t.artifacts || []))].length,
  }
  const fleetCounts = useMemo(() => deriveFleet(agents), [agents])
  const fleetTotal = Math.max(1, agents.length)
  const fleetSegs = [
    { k: 'running', n: fleetCounts.running, c: 'var(--accent)' },
    { k: 'verified', n: fleetCounts.verified, c: 'var(--add)' },
    { k: 'queued', n: fleetCounts.queued, c: 'color-mix(in srgb, var(--fg) 28%, transparent)' },
    { k: 'blocked', n: fleetCounts.blocked, c: '#f09609' },
  ]
  const tokVelocity = fmtTokens(fleetVelocity(agents))
  const fleetSpent = agents.reduce((n, a) => n + (a.tokens || 0), 0)
  const suitesPass = agents.reduce((n, a) => n + (a.pass || 0), 0)
  const suitesTotal = agents.reduce((n, a) => n + (a.total || 0), 0)
  const allTurnsCount = Object.values(turnsByThread).reduce((n, ts) => n + ts.length, 0)
  /* halt-on-mismatch off = the gate warns (amber) instead of holding the merge (accent) */
  const effectivePolicy = useMemo(() => (gates.haltOnMismatch ? tilePolicy : { ...tilePolicy, onFail: false, onAmbiguity: false }), [gates.haltOnMismatch, tilePolicy])
  const gateBlocking = gateOpen && gates.haltOnMismatch && gates.advTests
  const tileCtx = useMemo(() => ({ agents, changeSets, gate: seedGate, gateOpen }), [agents, changeSets, gateOpen])
  const threadTiles = useMemo(() => new Map(threads.map((t) => [t.id, tileForThread(t, tileCtx)])), [threads, tileCtx])
  const sessionTag = (t) => {
    const tile = threadTiles.get(t.id)
    if (tile?.phase === 'blocked') return gateBlocking ? '[1 BLOCKED]' : '[GATE · WARN]'
    if (tile?.phase === 'ready') return '[READY]'
    if (tile) return '[RUN]'
    return /review/.test(t.status) ? '[REVIEW]' : '[IDLE]'
  }
  const tiledThreads = useMemo(() => threads.filter((t) => threadTiles.get(t.id)).slice(0, 8), [threads, threadTiles])
  const idleThreads = useMemo(() => threads.filter((t) => !threadTiles.get(t.id)), [threads, threadTiles])
  const epochCounts = useMemo(() => epochTurnCounts(turns), [turns])
  const activeEpoch = derivedEpochs.find((e) => e.n === (activeTurn?.epoch || derivedEpochs[derivedEpochs.length - 1]?.n))
    || derivedEpochs[derivedEpochs.length - 1]
    || { n: 1, name: 'SESSION', anchor: 0, summary: '', hotWords: [] }
  const facetTurns = facets[facet] || facets.all
  const hotWords = useMemo(() => deriveHotWords(facetTurns, workspaceCtx, 10), [facetTurns, workspaceCtx])
  const visibleFacetTurns = useMemo(
    () => (hotWordFilter ? facetTurns.filter((t) => turnMatchesHotWord(t, hotWordFilter, workspaceCtx)) : facetTurns),
    [facetTurns, hotWordFilter, workspaceCtx],
  )
  /* Z0 treemap: block area is proportional to real weight (turns, files, hunks, workers) */
  const mapBlocks = [
    { badge: 'a', id: 'board', title: 'board of directors', weight: (turnsByThread.board || []).length, sub: `${gateBlocking ? '1 BLOCKED GATE · FAIL :142 · ' : gateOpen ? 'gate warning · ' : ''}${(turnsByThread.board || []).length} turns · ${seedEpochs.length} epochs`, blocked: gateBlocking, go: () => openThread('board') },
    { badge: 's', id: 'auth', title: 'fragments.auth', weight: files.filter((f) => f.folder === 'fragments.auth').reduce((n, f) => n + f.lines, 0) / 40, sub: `${files.filter((f) => f.folder === 'fragments.auth').length} files · jwt + vault`, go: () => openFile(files[0]) },
    { badge: 'd', id: 'review', title: 'review', weight: Math.max(2, unreviewed), sub: `${unreviewed} hunks unreviewed`, go: () => { setZoom(1); goPivot(PIVOTS.indexOf('review')) } },
    { badge: 'f', id: 'docs', title: 'docs', weight: files.filter((f) => f.folder === 'docs').length * 2, sub: `test infra · ${suitesPass}/${suitesTotal} suites`, go: () => openFile(files[5]) },
    { badge: 'g', id: 'agents', title: 'agents', weight: agents.length + fleetCounts.running * 2, sub: `${agents.length} subagents · ${fleetCounts.running} running · ${fleetCounts.blocked} blocked`, go: () => { setZoom(1); goPivot(PIVOTS.indexOf('agents')) } },
    { badge: 'w', id: 'terminal', title: 'terminal', weight: termLines.length, sub: `${termLines.length} lines this session`, go: () => { setZoom(1); goPivot(PIVOTS.indexOf('terminal')) } },
    { badge: 'e', id: 'siem', title: 'siem workbench', weight: (turnsByThread.siem || []).length + changeSetTotals(changeSets.find((c) => c.id === 'cs-siem')).hunks, sub: 'conversation · review ready', go: () => openThread('siem') },
    { badge: 'r', id: 'ui', title: 'ui', weight: files.filter((f) => f.folder === 'ui').reduce((n, f) => n + f.lines, 0) / 60, sub: 'macos chrome · compose', go: () => openFile(files[2]) },
    { badge: 't', id: 'e2e', title: 'e2e demo', weight: (turnsByThread.e2e || []).length, sub: 'complete · 6d', go: () => openThread('e2e') },
  ]
  const mapMaxWeight = Math.max(...mapBlocks.map((b) => b.weight), 1)

  /* ---- stable action surface ---------------------------------------------------
     The seven pivot pages are memoized components. Every handler they receive must
     keep its identity across renders, or React re-renders the page anyway — and the
     1.6s fleet tick would take the whole app down with it. These wrappers never
     change identity; the closures behind them read live state through `live`. */
  const live = useRef({})
  live.current = {
    openThread, openFile, goPivot, resolveGate, toggleAgent, killAgent, pushActivity, newThread,
    togglePin, sendInstruction, jumpToEpoch, setHunkState, scrollPayloadIntoView, runTerm, send,
    setPromptOpen, setZoom, setSelectedAgentId, setAgentsLevel, setEpochGrid, setReviewSetId,
    setReviewFile, setSelectedTurn, setThreadId, setThreads, setDraft, setRunProgress, setRunLabel,
    setInstructOpen, setBridgeStatus, composerKey, setConvLevel, setRevLevel, setColLevel,
    setFolder, setFileName, setTermInput, setSearchOpen, setQuery, setFacet, setSplitTurn,
    setSetDomain, setCfg, setAccent, setTheme, setDensity, setGateResolved, setTurnsByThread,
    setAgents, setActivity, setChangeSets, setCursorId, setHotWordFilter, onSpanClick, resetCircuits,
  }
  const actions = useMemo(() => {
    const out = {}
    for (const k of Object.keys(live.current)) out[k] = (...args) => live.current[k]?.(...args)
    return out
  }, [])

  /* ---- composer affixes --------------------------------------------------------
     The composer advertised "@ to mention", "/ for actions", ": for command" and
     "! for raw shell" and implemented none of them. Now it does:
       /   opens the command registry — pty commands and app actions
       !   runs the rest of the line in the pty
       @   mentions a file, an agent or a thread by name                        */
  const CMD_LIST = useMemo(() => [
    { id: 'new', label: 'new conversation', group: 'action', run: () => actions.newThread() },
    { id: 'review', label: 'jump to review diff', group: 'action', run: () => actions.goPivot(PIVOTS.indexOf('review')) },
    { id: 'collection', label: 'open collection', group: 'action', run: () => actions.goPivot(PIVOTS.indexOf('collection')) },
    { id: 'agents', label: 'open agents pivot', group: 'action', run: () => actions.goPivot(PIVOTS.indexOf('agents')) },
    { id: 'terminal', label: 'open terminal', group: 'action', run: () => actions.goPivot(PIVOTS.indexOf('terminal')) },
    { id: 'map', label: 'semantic zoom map · Z0', group: 'action', run: () => actions.setZoom(0) },
    { id: 'gate-yes', label: 'resolve gate · yes', group: 'action', run: () => actions.resolveGate('yes') },
    { id: 'gate-no', label: 'resolve gate · no', group: 'action', run: () => actions.resolveGate('no') },
    { id: 'shell-help', label: 'pty · help', group: 'pty', run: () => { actions.runTerm('help'); actions.goPivot(PIVOTS.indexOf('terminal')) } },
    { id: 'shell-test', label: 'pty · test', group: 'pty', run: () => { actions.runTerm('test'); actions.goPivot(PIVOTS.indexOf('terminal')) } },
    { id: 'shell-build', label: 'pty · build', group: 'pty', run: () => { actions.runTerm('build'); actions.goPivot(PIVOTS.indexOf('terminal')) } },
    { id: 'shell-status', label: 'pty · status', group: 'pty', run: () => { actions.runTerm('status'); actions.goPivot(PIVOTS.indexOf('terminal')) } },
    { id: 'shell-clear', label: 'pty · clear', group: 'pty', run: () => { actions.runTerm('clear'); actions.goPivot(PIVOTS.indexOf('terminal')) } },
    { id: 'shell-whoami', label: 'pty · whoami', group: 'pty', run: () => { actions.runTerm('whoami'); actions.goPivot(PIVOTS.indexOf('terminal')) } },
  ], [actions])

  const cmdMode = /^\s*\//.test(draft)
  const cmdHits = useMemo(() => {
    if (!cmdMode) return []
    const q = draft.replace(/^\s*\//, '').trim().toLowerCase()
    return q ? CMD_LIST.filter((c) => c.label.toLowerCase().includes(q)) : CMD_LIST
  }, [cmdMode, draft, CMD_LIST])
  const mentions = useMemo(() => resolveMentions(draft), [draft, agents, threads])

  function runCommand(cmd) {
    setDraft('')
    cmd.run()
    if (cmd.group !== 'pty') pushActivity(`command · ${cmd.label}`)
  }

  /* @name resolves against the workspace: files first, then agents, then threads. */
  function resolveMentions(text) {
    const out = []
    for (const m of String(text).matchAll(/@([\w.\-/]+)/g)) {
      const tok = m[1].toLowerCase()
      const f = files.find((x) => x.name.toLowerCase() === tok || x.name.toLowerCase().includes(tok))
      if (f) { out.push({ kind: 'file', name: f.name, detail: `${f.folder} · ${f.lines} lines · ${f.lang}` }); continue }
      const a = agents.find((x) => x.name.toLowerCase() === tok || x.name.toLowerCase().includes(tok))
      if (a) { out.push({ kind: 'agent', name: a.name, detail: a.task }); continue }
      const th = threads.find((x) => x.title.toLowerCase().includes(tok))
      if (th) out.push({ kind: 'thread', name: th.title, detail: `${th.project} · ${th.age}` })
    }
    return out
  }

  /* Enter in the composer: a command line runs the top match, anything else goes
     to the engine. The pty escape (!) is handled in send(). */
  function composerKey(e) {
    if (e.key !== 'Enter' || e.shiftKey) return
    e.preventDefault()
    if (cmdMode) {
      if (cmdHits.length) runCommand(cmdHits[0])
      return
    }
    send()
  }

  return (
    <div className={`app ${motion.cascade ? "" : "m-nocascade "}${motion.shimmer ? "" : "m-noshimmer "}${motion.glow ? "" : "m-noglow "}${motion.tilt ? "" : "m-notilt"}`} style={style} data-theme={theme} onWheel={onWheel} onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={(e) => { onTouchDone(e); onTouchEnd(e) }} onTouchCancel={onTouchDone}
      onFocusCapture={(e) => { const n = e.target.closest?.('[data-cursor]'); if (n) setCursorId(n.dataset.cursor) }}>
      {/* 1 · Visual Studio 34px Top Title & Command Bar (78px left macOS traffic-light safe zone) */}
      <div className="topline" data-drag-zone="true" data-zode-drag-zone="true" title="drag to move · double-click to fill"
        onPointerDown={(e) => { if (e.target.closest('button,input,a,[data-zode-drag-ignore]')) return; window.zode?.window?.dragStart?.(e.screenX, e.screenY) }}
        onDoubleClick={(e) => { if (e.target.closest('button,input,a,[data-zode-drag-ignore]')) return; if (window.zode?.window?.toggleFillScreen) window.zode.window.toggleFillScreen().catch(() => {}); else if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); else document.documentElement.requestFullscreen?.().catch(() => {}) }}>
        <img className="brandmark" src="/zode-mark.svg" alt="zode mark" />
        <span className="wordmark">zune <b>code</b></span>
        <span className="topcrumb">
          / <b>{thread.title}</b> · E{String(activeEpoch.n).padStart(2, '0')} {activeEpoch.name.toLowerCase()}
        </span>
        {zoom === 3 && PIVOTS[pivot] === 'conversation' && (
          <button className="ghostbtn" onClick={() => setZoom(1)}>← workbench [esc]</button>
        )}
        <span className="spacer" />

        {/* Center VS Command & Search Bar */}
        <div className="topsearch" data-zode-drag-ignore="true">
          <span className="faint">⌕</span>
          <input
            value={query}
            placeholder="Search threads, files, agents (⌘K or /)"
            aria-label="search threads, files, agents"
            onFocus={() => setSearchOpen(true)}
            onChange={(e) => { setQuery(e.target.value); setSearchOpen(true) }}
            onBlur={() => setTimeout(() => { setSearchOpen(false) }, 180)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && searchHits[0]) {
                searchHits[0].go()
                setSearchOpen(false)
                setQuery('')
                e.currentTarget.blur()
              } else if (e.key === 'Escape') {
                setSearchOpen(false)
                setQuery('')
                e.currentTarget.blur()
              }
            }}
          />
          {searchOpen && (
            <div className="searchresults">
              {searchHits.length === 0 && (
                <p className="dim" style={{ margin: 0, padding: '6px 12px', fontSize: '.9em' }}>
                  {query ? 'nothing matches' : 'type to search threads, files, agents · esc closes'}
                </p>
              )}
              {searchHits.map((h, i) => (
                <button key={i} onMouseDown={() => { h.go(); setSearchOpen(false); setQuery('') }}>
                  <span className="faint">{h.kind} · </span>{h.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <span className="spacer" />
        {showHints && <span className="kbd">⌘1–9 sessions · [ ] views · h j k l move · f jump · z epochs</span>}
        <span className="zoomstops" aria-label={`semantic zoom Z${zoom}`}>
          {[0, 1, 2, 3].map((z) => (
            <button key={z} className={z === zoom ? 'zstop on' : 'zstop'} onClick={() => setZoom(z)}>
              {z === zoom ? `■ Z${z}` : `Z${z}`}
            </button>
          ))}
        </span>
        <button className="toplink" onClick={newThread}>
          <span className="onlywide">+ new conversation</span>
          <span className="onlynarrow">+ new</span>
        </button>
      </div>

      {/* 2 · Main Workbench Shell: Left 56px Activity Bar + 3-Pane Split Viewport */}
      <div className="workbench-shell">
        <nav className="pivotrail activitybar" aria-label="pivots">
          <div className="pivottrack" ref={pivotTrackRef}>
            {PIVOTS.map((p, i) => (
              <button
                key={p}
                ref={(el) => (pivotRefs.current[i] = el)}
                className={i === pivot && zoom !== 0 ? 'pivot active' : 'pivot'}
                onClick={() => goPivot(i)}
                aria-current={i === pivot}
                title={`${p} (Ctrl+${i + 1})`}
              >
                <span className="pivot-icon" aria-hidden="true">{PIVOT_ICONS[p] || '■'}</span>
                <span className="pivot-word">{p}</span>
                {pivotCounts[p] > 0 && <span className="count">{pivotCounts[p]}</span>}
              </button>
            ))}
          </div>
          {zoom === 3 && PIVOTS[pivot] === 'conversation' && (
            <div className="pivottrack" style={{ borderTop: '1px solid var(--border)', paddingTop: 4 }}>
              {[['all', 'all'], ['prompts', 'ask'], ['decisions', 'dec'], ['mutations', 'diff'], ['pty', 'pty'], ['artifacts', 'art']].map(([k, shortLabel]) => (
                <button
                  key={k}
                  className={facet === k ? 'pivot active' : 'pivot'}
                  data-cursor={`conv-facet:${k}`}
                  onClick={() => setFacet(k)}
                  title={`facet: ${k} (${facetCounts[k]})`}
                >
                  <span className="pivot-word">{shortLabel}</span>
                  <span className="count">{facetCounts[k]}</span>
                </button>
              ))}
            </div>
          )}
        </nav>

        <div className="viewport">
          <div className="canvas">
            {/* ============ HUB ============ */}
            <HubPage
              active={pivot === 0}
              tiledThreads={tiledThreads} threadTiles={threadTiles} effectivePolicy={effectivePolicy}
              gateBlocking={gateBlocking} gateResolved={gateResolved} idleThreads={idleThreads}
              turnsByThread={turnsByThread} thread={thread} threads={threads} runningAgents={runningAgents}
              sendingRef={sendingRef} runProgress={runProgress} runLabel={runLabel} agents={agents}
              activity={activity} fleetCounts={fleetCounts} suitesPass={suitesPass} suitesTotal={suitesTotal}
              allTurnsCount={allTurnsCount} tokVelocity={tokVelocity} fleetSpent={fleetSpent}
              derivedEpochs={derivedEpochs}
              tiltSpot={tiltSpot} motion={motion} actions={actions}
            />

            {/* ============ CONVERSATION (3-PANE WORKBENCH) ============ */}
            <ConversationPage
              active={pivot === 1}
              zoom={zoom} focusTick={focusTick} narrow={narrow} convLevel={convLevel} setConvLevel={setConvLevel}
              thread={thread} threadId={threadId} threads={threads} turns={turns}
              selectedTurn={selectedTurn} setSelectedTurn={setSelectedTurn} activeTurn={activeTurn}
              promptTurns={promptTurns} decisionTurns={decisionTurns} activeEpoch={activeEpoch} epochCounts={epochCounts}
              derivedEpochs={derivedEpochs} hotWords={hotWords} hotWordFilter={hotWordFilter}
              visibleFacetTurns={visibleFacetTurns} workspaceCtx={workspaceCtx}
              sessionChangeSet={sessionChangeSet} sessionHunks={sessionHunks} facet={facet} facetTurns={facetTurns}
              splitTurn={splitTurn} promptOpen={promptOpen} engineSummary={engineSummary} draft={draft} setDraft={setDraft}
              promptRef={promptRef} gateOpen={gateOpen} gateResolved={gateResolved}
              reviewFileObj={reviewFileObj} activeHunk={activeHunk} agents={agents} config={config}
              localStatus={localStatus} motion={motion}
              cmdMode={cmdMode} cmdHits={cmdHits} runCommand={runCommand} mentions={mentions}
              termLines={termLines} termInput={termInput} setTermInput={setTermInput}
              startResize={startResize} resetPaneWidths={resetPaneWidths}
              actions={actions}
            />

            {/* ============ COLLECTION (folders / files / code) ============ */}
            <CollectionPage
              active={pivot === 2}
              narrow={narrow} colLevel={colLevel} setColLevel={setColLevel}
              folder={folder} setFolder={setFolder} fileName={fileName} setFileName={setFileName}
              focusTick={focusTick} file={file} threadId={threadId} actions={actions}
            />

            {/* ============ REVIEW — hunk-level triage ============ */}
            <ReviewPage
              active={pivot === 3}
              zoom={zoom} reviewSet={reviewSet} reviewFileObj={reviewFileObj} activeHunk={activeHunk}
              selectedHunk={selectedHunk} setSelectedHunk={setSelectedHunk}
              promptTurns={promptTurns} decisionTurns={decisionTurns}
              changeSets={changeSets} reviewSetId={reviewSetId} setReviewSetId={setReviewSetId}
              reviewFile={reviewFile} setReviewFile={setReviewFile}
              narrow={narrow} revLevel={revLevel} setRevLevel={setRevLevel}
              instructOpen={instructOpen} instructDraft={instructDraft} setInstructDraft={setInstructDraft}
              instructRef={instructRef} actions={actions}
            />

            {/* ============ TERMINAL ============ */}
            <TerminalPage
              active={pivot === 4}
              termLines={termLines} termInput={termInput} setTermInput={setTermInput} actions={actions}
            />

            {/* ============ AGENTS ============ */}
            <AgentsPage
              active={pivot === 5}
              narrow={narrow} agentsLevel={agentsLevel} setAgentsLevel={setAgentsLevel}
              runningAgents={runningAgents} agents={agents} tiltSpot={tiltSpot} motion={motion}
              telemetryAgent={telemetryAgent} fleetSpent={fleetSpent} config={config} actions={actions}
            />

            {/* ============ SETTINGS ============ */}
            <SettingsPage
              active={pivot === 6}
              setDomain={setDomain} setSetDomain={setSetDomain} config={config} setCfg={setCfg}
              accent={accent} theme={theme} density={density} setAccent={setAccent} setTheme={setTheme} setDensity={setDensity}
              gates={gates} tilePolicy={tilePolicy} effectivePolicy={effectivePolicy} motion={motion}
              coarse={coarse} localStatus={localStatus} bridgeStatus={bridgeStatus} circuitStats={circuitStats} engineSummary={engineSummary}
              agents={agents} fleetCounts={fleetCounts} fleetSpent={fleetSpent} tokVelocity={tokVelocity}
              threads={threads} threadTiles={threadTiles} allTurnsCount={allTurnsCount} actions={actions}
            />
          </div>

          {/* 3 · semantic zoom map */}
          {zoom === 0 && (
            <div className="zoommap" role="dialog" aria-label="semantic zoom map">
              <p className="huge">fragments</p>
              <p className="dim pane-pad">{coarse ? 'Z0 · macro fleet map · tap a block to land in it' : 'Z0 · macro fleet map · home-row badge or click lands in the block · ctrl + = steps in'}</p>
              <div className="mapgrid">
                {mapBlocks.map((b) => (
                  <button key={b.id} className={`mapblock ${b.blocked ? 'blocked' : ''} ${treemapSpan(b.weight, mapMaxWeight)} tiltcard`} {...tiltSpot} data-badge={b.badge} data-cursor={`zoom-map:${b.id}`} onClick={b.go}>
                    <span className="mapbadge">{b.badge}</span><span className="t">{b.title}</span><small>{b.sub}</small>
                  </button>
                ))}
              </div>
            </div>
          )}
          {/* z · epoch jump grid */}
          {epochGrid && (
            <div className="zoommap epochgrid" role="dialog" aria-label="epoch jump grid">
              <p className="huge">epochs · {thread.title.toLowerCase()}</p>
              <p className="dim pane-pad">{turns.length} turns across {derivedEpochs.length} epochs · click a square to teleport · esc closes</p>
              <div className="mapgrid epochcells">
                {derivedEpochs.map((ep, i) => (
                  <button key={ep.n} className={`mapblock ${ep.n === activeEpoch.n ? 'live' : ''} ${derivedEpochs.length <= 6 && i === derivedEpochs.length - 1 ? 'w2' : ''}`} data-cursor={`conv-epoch:${ep.n}`} onClick={() => jumpToEpoch(ep)}>
                    <span className="t">[{String(ep.n).padStart(2, '0')}] {ep.name.toLowerCase()}</span>
                    <small>{ep.when} · {epochCounts.get(ep.n) || 0} turns{ep.n === activeEpoch.n ? ' · you are here' : ''}</small>
                    <small className="epochsummary">{ep.summary}</small>
                    {(ep.hotWords || []).length > 0 && (
                      <span className="ephotwords">
                        {ep.hotWords.map((hw) => <span key={hw.key} className="ephw">{hw.label}<sup>{hw.count}</sup></span>)}
                      </span>
                    )}
                  </button>
                ))}
              </div>
              <button className="ghostbtn" style={{ marginTop: 16 }} onClick={() => setEpochGrid(false)}>close · esc</button>
            </div>
          )}
        </div>
      </div>

      {/* global fleet heartbeat: 2px segmented strip */}
      <div className="fleetstrip" role="img" aria-label={`fleet: ${fleetSegs.map((s) => `${s.n} ${s.k}`).join(', ')}`} title={fleetSegs.map((s) => `${s.n} ${s.k}`).join(' · ')}>
        {fleetSegs.filter((s) => s.n > 0).map((s) => <i key={s.k} style={{ width: `${(s.n / fleetTotal) * 100}%`, background: s.c }} />)}
      </div>
      {/* Visual Studio / Zune 24px Status Bar Ribbon: always shows active scope, actions, and telemetry */}
      <footer className={`actionstrip${gateBlocking ? ' gate-active' : ''}`}>
        <span className="striplabel">{jumpHint !== null ? `jump: ${jumpHint}▌` : stripLabel}</span>
        {stripActions.map(([k, label]) => (
          <button key={k + label} className="stripaction" onClick={() => runStripAction(k)}>
            {coarse ? label : <><b>[{k}]</b> {label}</>}
          </button>
        ))}
        <span className="spacer" style={{ flex: 1 }} />
        <span className="sr" aria-live="polite">{activity[0]?.what || ''}</span>
        <span className="stripaction faint stripmodel">
          {fleetCounts.running} run · {suitesPass}/{suitesTotal} suites · {tokVelocity} tok/s · {engineSummary}
        </span>
      </footer>
    </div>
  )
}
