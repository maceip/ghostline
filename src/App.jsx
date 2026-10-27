import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  PIVOTS, ACCENTS, seedThreads, seedAgents, folders, files,
  seedActivity, artifacts, seedTerminal, agentReply, seedTurns, seedChangeSets,
  seedEpochs, seedGate, seedInvariants,
} from './data.js'
import { loadConfig, saveConfig } from './llm/config.js'
import { runTurn, historyFromTurns } from './llm/router.js'
import { buildRunners, maybePreloadLocal } from './llm/engines.js'
import { onLocalStatus, getLocalStatus, ensureLocal } from './llm/litert.js'
import { bridgeHealthy } from './llm/bridge.js'
import { useTiltSpotlight } from './motion.jsx'

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

export default function App() {
  const [pivot, setPivot] = useState(() => Math.max(0, PIVOTS.indexOf(location.hash.replace('#', '')))) // deep-link: #collection etc.
  /* four-stop semantic zoom: Z0 macro fleet map · Z1 3-column workbench ·
     Z2 decisions & mutations ledger · Z3 full-bleed focus. font size never shrinks. */
  const [zoom, setZoom] = useState(() => (location.hash === '#map' ? 0 : 1))
  const [savedSession] = useState(loadSession)
  /* a saved session from an older build must not lose fields added since (tile telemetry, scope) */
  const [threads, setThreads] = useState(() => (savedSession?.threads || seedThreads).map((t) => {
    const seed = seedThreads.find((s) => s.id === t.id)
    return seed ? { ...t, scope: t.scope || seed.scope, tile: t.tile || seed.tile } : t
  }))
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
  const motion = { tilt: true, spotlight: true, glow: true, shimmer: true, cascade: true, ...(config.motion || {}) }
  const tiltSpot = useTiltSpotlight({ tilt: motion.tilt, spotlight: motion.spotlight })
  const [localStatus, setLocalStatus] = useState(getLocalStatus)
  const [bridgeStatus, setBridgeStatus] = useState('not checked')
  useEffect(() => onLocalStatus(setLocalStatus), [])
  useEffect(() => { saveConfig(config) }, [config])
  const setCfg = (patch) => setConfig((c) => ({ ...c, ...patch }))
  const engineSummary = config.mode === 'demo' ? 'demo · simulated'
    : config.mode === 'local' ? 'litert-lm · local'
    : config.bridgeUrl ? 'native bridge'
    : config.apiKey ? (config.provider === 'openai' ? config.openaiModel : config.model)
    : 'litert-lm · local (no key set)'
  const [runProgress, setRunProgress] = useState(41)
  const [runLabel, setRunLabel] = useState('m1_worker_1 · implementing fragments.auth in :ui')
  const [accent, setAccent] = useState(ACCENTS[0])
  const [theme, setTheme] = useState('dark')
  const [density, setDensity] = useState(1) // high-DPI type scale
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false) // active pivot word morphs into the search cursor
  const [altHeld, setAltHeld] = useState(false) // key hints exist only while Alt is held…
  const [helpOn, setHelpOn] = useState(false) // …or after ?
  const [cursorId, setCursorId] = useState(null) // spatial keyboard cursor: data-cursor id in the active page
  const [selectedAgentId, setSelectedAgentId] = useState('a1')
  const [turnsByThread, setTurnsByThread] = useState(() => savedSession?.turnsByThread || seedTurns)
  /* sessions are durable: threads + turns survive reload (pi gets the same transcript as history) */
  useEffect(() => {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify({ threads, turnsByThread, threadId })) } catch { /* quota */ }
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
  const [epochGrid, setEpochGrid] = useState(false) // z — 2D epoch jump grid
  const [gateResolved, setGateResolved] = useState(null) // null | 'yes' | 'no' — the [y]/[n] arbitration
  const [jumpHint, setJumpHint] = useState(null) // f — two-letter gutter jump badges (string prefix while armed)
  const [splitTurn, setSplitTurn] = useState(null) // v — Z3 pin split: turn index pinned beside the active one
  const [setDomain, setSetDomain] = useState(0) // settings col 1 selection
  const tilePolicy = { onFail: true, onAmbiguity: true, onBigDiff: true, bigDiffLines: 250, autoApproveUnder: 0, ...(config.tilePolicy || {}) }
  const gates = { strictPcr: true, haltOnMismatch: true, advTests: true, ...(config.gates || {}) }
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
  const runningAgents = agents.filter((a) => a.state === 'running')

  /* ---- pivots: active header sits on the left margin, the rest bleed off-edge ---- */
  const [pivotShift, setPivotShift] = useState(0)
  useEffect(() => {
    const el = pivotRefs.current[pivot]
    if (el) setPivotShift(el.offsetLeft - (pivotTrackRef.current?.offsetLeft || 0) - 0)
  }, [pivot, density])

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
    setSelectedTurn(ri >= 0 ? ri : Math.max(0, ts.length - 1))
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
    setAgents((as) => as.map((x) => x.id === id
      ? { ...x, state: x.state === 'running' ? 'queued' : 'running', progress: x.state === 'running' ? x.progress : Math.max(x.progress, 5) } : x))
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
  function cursorNodes() {
    const scope = cursorScope(); if (!scope) return []
    /* drilled-away columns are display:none on phones — the cursor must never land in them */
    return [...scope.querySelectorAll('[data-cursor]')].filter((el) => el.getBoundingClientRect().width > 0)
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
    setAgents((as) => as.map((a) => (a.id === 'a6' ? { ...a, state: 'running', phase: answer === 'yes' ? 'rerunning :dev suite' : 'strict rerun' } : a)))
    pushActivity(answer === 'yes' ? 'gate resolved · MockPcr0Provider injected in :dev only' : 'gate resolved · strict PCR0 kept, dev suite stays red')
    return true
  }
  function jumpToEpoch(ep) {
    setEpochGrid(false)
    if (threadId !== 'board') { setThreadId('board') }
    setSelectedTurn(ep.anchor)
    setCursorId(`conv-turn:${ep.anchor}`)
    setPivot(PIVOTS.indexOf('conversation'))
    if (zoom === 0) setZoom(1)
    pushActivity(`epoch jump · E${String(ep.n).padStart(2, '0')} ${ep.name}`)
  }
  /* hunk triage: mutate exactly one hunk's review state */
  function setHunkState(state, comment) {
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
      if (setDomain === 1) setCfg({ tilePolicy: { onFail: true, onAmbiguity: true, onBigDiff: true, bigDiffLines: 250, autoApproveUnder: 0 } })
      else if (setDomain === 2) setCfg({ gates: { strictPcr: true, haltOnMismatch: true, advTests: true } })
      else if (setDomain === 4) setCfg({ motion: { tilt: true, spotlight: true, glow: true, shimmer: true, cascade: true } })
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
    document.querySelectorAll('.cursorfocus').forEach((el) => el.classList.remove('cursorfocus'))
    if (!cursorId) return
    const scope = zoom === 0 ? document.querySelector('.zoommap') : document.querySelectorAll('.page')[pivot]
    scope?.querySelector(`[data-cursor="${CSS.escape(cursorId)}"]`)?.classList.add('cursorfocus')
    const t = /-agent:(.+)$/.exec(cursorId)
    if (t) setSelectedAgentId(t[1])
    /* resting the cursor IS the selection in the two matrix pivots — cols 2/3 follow instantly */
    if (cursorId.startsWith('conv-thread:')) {
      const id = cursorId.slice('conv-thread:'.length)
      if (id !== threadId) { setThreadId(id); setThreads((ts) => ts.map((x) => (x.id === id ? { ...x, unread: 0 } : x))) }
    }
    if (cursorId.startsWith('conv-turn:')) setSelectedTurn(Number(cursorId.slice('conv-turn:'.length)))
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
  /* land the cursor on the first node whenever the pivot changes */
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const scope = zoom === 0 ? document.querySelector('.zoommap') : document.querySelectorAll('.page')[pivot]
      const first = [...(scope?.querySelectorAll('[data-cursor]') || [])].find((el) => el.getBoundingClientRect().width > 0)
      setCursorId(first ? first.dataset.cursor : null)
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

  /* ---- trackpad: horizontal swipe pans pivots; ctrl+wheel is semantic zoom ---- */
  const onWheel = (e) => {
    if (e.ctrlKey || e.metaKey) {
      if (Date.now() - wheelLock.current < 350) return
      wheelLock.current = Date.now()
      setZoom((z) => (e.deltaY > 0 ? Math.max(0, z - 1) : Math.min(3, z + 1)))
      return
    }
    if (Math.abs(e.deltaX) < 24 || Math.abs(e.deltaX) < Math.abs(e.deltaY)) return
    if (Date.now() - wheelLock.current < 650) return
    wheelLock.current = Date.now()
    goPivot(pivot + (e.deltaX > 0 ? 1 : -1))
  }

  /* ---- simulated run progress for the hub's now-running column ---- */
  useEffect(() => {
    const id = setInterval(() => setRunProgress((p) => (p >= 99 ? p : p + 1)), 900)
    return () => clearInterval(id)
  }, [])
  useEffect(() => () => timers.current.forEach(clearTimeout), [])

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
    sendingRef.current = true
    setDraft('')
    setPromptOpen(false)
    const id = thread.id
    const existing = turnsByThread[id] || []
    const history = historyFromTurns(existing)
    const titleFromDraft = existing.length === 0 ? text.slice(0, 44) : thread.title
    setThreads((ts) => ts.map((t) => (t.id === id ? { ...t, title: titleFromDraft, status: 'agent running' } : t)))
    const userTurn = { actor: 'user', age: 'now', summary: `"${text.slice(0, 52)}${text.length > 52 ? '…' : ''}"`, intent: text, synthesis: text, stats: [], artifacts: [], full: text, trace: [], stdout: [] }
    const agentTurn = { actor: 'agent', engine: engineSummary, age: 'running', state: 'running', progress: 2, summary: 'working…', intent: text, synthesis: '', stats: [], artifacts: [], full: '', trace: [], stdout: [] }
    setTurnsByThread((m) => ({ ...m, [id]: [...(m[id] || []), userTurn, agentTurn] }))
    setSelectedTurn(existing.length + 1)
    setCursorId(`conv-turn:${existing.length + 1}`)
    setRunProgress(3); setRunLabel(`${engineSummary} · ${text.slice(0, 52)}`)
    pushActivity(`you asked: ${text.slice(0, 48)}`)
    const patchTurn = (patch) => setTurnsByThread((m) => {
      const ts = [...(m[id] || [])]
      if (!ts.length) return m
      ts[ts.length - 1] = { ...ts[ts.length - 1], ...(typeof patch === 'function' ? patch(ts[ts.length - 1]) : patch) }
      return { ...m, [id]: ts }
    })
    try {
      const runners = buildRunners(config, { files, folders, changeSets }, agentReply)
      const result = await runTurn({
        config, prompt: text, history, runners,
        hooks: {
          sessionId: id,
          onEngine: (name) => patchTurn({ engine: name }),
          onToken: (soFar) => { patchTurn({ synthesis: soFar, full: soFar }); setRunProgress(Math.min(96, 4 + Math.ceil(soFar.length / 14))) },
          onTrace: (line) => patchTurn((t) => ({ trace: [...(t.trace || []), line] })),
          onStatus: (line) => patchTurn((t) => ({ trace: [...(t.trace || []), line] })),
        },
      })
      const firstLine = result.text.split('\n').find((l) => l.trim()) || 'complete'
      patchTurn({
        actor: result.label, engine: result.label, synthesis: result.text, full: result.text,
        summary: firstLine.slice(0, 72), age: 'now', state: undefined, progress: 100,
        ...(result.fallbackFrom ? { fallbackFrom: result.fallbackFrom } : {}),
      })
      setRunProgress(100)
      setThreads((ts) => ts.map((t) => (t.id === id ? { ...t, status: 'complete' } : t)))
      pushActivity(`${result.label} finished${result.fallbackFrom ? ' (remote failed, answered locally)' : ''}`)
      maybePreloadLocal(config, result.engine)
    } catch (e) {
      const msg = String(e?.message || e)
      patchTurn({
        actor: 'engine error', engine: 'error', synthesis: `No engine could answer.\n${msg}\n\nFix it in settings: add an API key (anthropic / openai), start the native bridge, or load the local LiteRT-LM model. Mode is currently "${config.mode}".`,
        full: msg, summary: 'engine error — see payload', age: 'now', state: undefined, progress: 100,
      })
      setThreads((ts) => ts.map((t) => (t.id === id ? { ...t, status: 'engine error' } : t)))
      pushActivity(`engine error: ${msg.slice(0, 60)}`)
    } finally {
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

  const style = { '--accent': accent.value, '--accent-hover': accent.hover, '--accent-pressed': accent.pressed, '--scale': density }

  const unreviewed = changeSets.reduce((n, cs) => n + cs.files.reduce((m, f) => m + f.hunks.filter((h) => h.state === 'UNREVIEWED').length, 0), 0)
  const pivotCounts = { conversation: threads.reduce((n, t) => n + t.unread, 0), agents: runningAgents.length, review: unreviewed }

  /* matrix selections, shared by render + baseline */
  const turns = turnsByThread[threadId] || []
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
      ? `${thread.title} · turn ${String(selectedTurn + 1).padStart(2, '0')}`
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

  /* ---- spec derivations: facets, fleet heartbeat, tiles, sessions ---- */
  const promptTurns = turns.map((t, i) => ({ ...t, i })).filter((t) => t.actor === 'user' || t.kind === 'prompt')
  const decisionTurns = turns.map((t, i) => ({ ...t, i })).filter((t) => t.kind === 'decision' || t.decision)
  const mutationTurns = turns.map((t, i) => ({ ...t, i })).filter((t) => t.kind === 'mutation')
  const sessionChangeSet = changeSets.find((cs) => cs.task.startsWith(thread.title.split(' UI')[0])) || reviewSet
  const sessionHunks = sessionChangeSet.files.flatMap((f) => f.hunks.map((h) => ({ ...h, file: f.name })))
  const facetCounts = {
    all: seedEpochs.reduce((n, e) => n + e.turns, 0),
    prompts: promptTurns.length,
    decisions: decisionTurns.length,
    mutations: sessionHunks.length,
    pty: agents.filter((a) => a.state === 'running').length,
    artifacts: [...new Set(turns.flatMap((t) => t.artifacts || []))].length,
  }
  const fleetCounts = {
    running: agents.filter((a) => a.state === 'running').length,
    verified: agents.filter((a) => a.state === 'complete').length,
    queued: agents.filter((a) => a.state === 'queued' || a.state === 'stopped').length,
    blocked: agents.filter((a) => a.state === 'blocked').length + (gateOpen ? 0 : 0),
  }
  const fleetTotal = Math.max(1, fleetCounts.running + fleetCounts.verified + fleetCounts.queued + fleetCounts.blocked)
  const fleetSegs = [
    { k: 'running', n: fleetCounts.running, c: 'var(--accent)' },
    { k: 'verified', n: fleetCounts.verified, c: 'var(--add)' },
    { k: 'queued', n: fleetCounts.queued, c: 'color-mix(in srgb, var(--fg) 28%, transparent)' },
    { k: 'blocked', n: fleetCounts.blocked, c: '#f09609' },
  ]
  const tokVelocity = (38 + (runProgress % 17) * 0.3).toFixed(1) + 'k'
  const sessionTag = (t) => (t.id === seedGate.threadId && gateOpen) ? '[1 BLOCKED]' : t.tile?.phase === 'ready' ? '[READY]' : /running|writing/.test(t.status) ? '[RUN]' : /review/.test(t.status) ? '[REVIEW]' : '[IDLE]'
  const tiledThreads = threads.filter((t) => t.tile && (t.tile.phase !== 'blocked' || gateOpen)).slice(0, 8)
  const idleThreads = threads.filter((t) => !tiledThreads.includes(t))
  const activeEpoch = seedEpochs.find((e) => e.n === (activeTurn?.epoch || 6)) || seedEpochs[seedEpochs.length - 1]
  const facetTurns = facet === 'prompts' ? promptTurns : facet === 'decisions' ? decisionTurns : facet === 'mutations' ? mutationTurns
    : facet === 'pty' ? turns.map((t, i) => ({ ...t, i })).filter((t) => (t.stdout || []).length > 0)
      : facet === 'artifacts' ? turns.map((t, i) => ({ ...t, i })).filter((t) => (t.artifacts || []).length > 0)
        : turns.map((t, i) => ({ ...t, i }))

  return (
    <div className={`app ${motion.cascade ? "" : "m-nocascade "}${motion.shimmer ? "" : "m-noshimmer "}${motion.glow ? "" : "m-noglow "}${motion.tilt ? "" : "m-notilt"}`} style={style} data-theme={theme} onWheel={onWheel} onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={(e) => { onTouchDone(e); onTouchEnd(e) }} onTouchCancel={onTouchDone}
      onMouseOver={(e) => { const n = e.target.closest?.('[data-cursor]'); if (n && n.dataset.cursor !== cursorId) setCursorId(n.dataset.cursor) }}
      onFocusCapture={(e) => { const n = e.target.closest?.('[data-cursor]'); if (n) setCursorId(n.dataset.cursor) }}>
      <div className="topline" data-drag-zone="true" title="double-click to fill"
        onDoubleClick={(e) => { if (e.target.closest('button,input,a')) return; if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); else document.documentElement.requestFullscreen?.().catch(() => {}) }}>
        <img className="brandmark" src="/zode-mark.svg" alt="zode mark" />
        <span className="wordmark">zune <b>code</b></span>
        {/* Tier 1 · horizontal session strip (Cmd+1..9) — replaces vertical browser tabs */}
        {zoom === 3 && PIVOTS[pivot] === 'conversation'
          ? <button className="sessiontab back" onClick={() => setZoom(1)}>← hub <span className="faint">[esc]</span></button>
          : <span className="faint" aria-hidden="true">│</span>}
        <span className="sessionstrip" role="tablist" aria-label="sessions">
          {threads.slice(0, 4).map((t, i) => (
            <button key={t.id} className={t.id === threadId ? 'sessiontab on' : 'sessiontab'} onClick={() => openThread(t.id)} title={`⌘${i + 1}`}>
              {String(i + 1).padStart(2, '0')} {t.title.toUpperCase().replace(/ UI ENHANCEMENT| VERIFICATION/g, '')} <span className={t.id === seedGate.threadId && gateOpen ? 'sessiontag blocked' : 'sessiontag'}>{sessionTag(t)}</span>
            </button>
          ))}
        </span>
        <span className="spacer" />
        {showHints && <span className="kbd">⌘1–9 sessions · [ ] pivots · h j k l move · f jump · z epochs · ctrl+scroll zoom Z0–Z3 · ? hide</span>}
        <span className="zoomstops" aria-label={`semantic zoom Z${zoom}`}>{[0, 1, 2, 3].map((z) => (
          <button key={z} className={z === zoom ? 'zstop on' : 'zstop'} onClick={() => setZoom(z)}>{z === zoom ? `■ Z${z}` : `Z${z}`}</button>
        )).reduce((acc, el, i) => (i ? [...acc, <span key={'d' + i} className="faint">─</span>, el] : [el]), [])}</span>
        <button className="toplink" onClick={() => setZoom(0)}>map −</button>
        <button className="toplink" onClick={newThread}><span className="onlywide">+ new conversation</span><span className="onlynarrow">+ new</span></button>
      </div>

      {/* 1 · typographic pivots — navigation is the header; no left sidebar exists.
             / or ctrl+k morphs the active 42pt word itself into the search cursor. */}
      <nav className="pivotrail" aria-label="pivots">
        {zoom === 3 && PIVOTS[pivot] === 'conversation' ? (
          /* Degree 2 · segmented session facet bar: the 42pt header re-scopes to this session */
          <div className="pivottrack facetrack">
            {[['all', 'all turns'], ['prompts', 'my prompts'], ['decisions', 'decisions'], ['mutations', 'mutations'], ['pty', 'live pty'], ['artifacts', 'artifacts']].map(([k, label]) => (
              <button key={k} className={facet === k ? 'pivot active' : 'pivot'} data-cursor={`conv-facet:${k}`} onClick={() => setFacet(k)}>
                {label}<span className="count">{facetCounts[k]}</span>
              </button>
            ))}
          </div>
        ) : (
        <div className="pivottrack" ref={pivotTrackRef} style={{ transform: `translateX(${(window.innerWidth <= 1100 ? 24 : 48) - pivotShift}px)` }}>
          {PIVOTS.map((p, i) => searchOpen && i === pivot ? (
            <input key={p} ref={(el) => (pivotRefs.current[i] = el)} className="pivot searchmorph" autoFocus
              style={{ width: `${Math.max(p.length, query.length) + 2}ch` }}
              value={query} placeholder={p} aria-label="search threads, files, agents"
              onChange={(e) => setQuery(e.target.value)}
              onBlur={() => setTimeout(() => { setSearchOpen(false); setQuery('') }, 160)}
              onKeyDown={(e) => { if (e.key === 'Enter' && searchHits[0]) { searchHits[0].go(); setSearchOpen(false); setQuery('') } }} />
          ) : (
            <button key={p} ref={(el) => (pivotRefs.current[i] = el)} className={i === pivot && zoom !== 0 ? 'pivot active' : 'pivot'} onClick={() => goPivot(i)} aria-current={i === pivot}>
              {p}{pivotCounts[p] > 0 && <span className="count">{pivotCounts[p]}</span>}
            </button>
          ))}
        </div>
        )}
        {searchOpen && zoom !== 3 && (
          <div className="searchresults">
            {searchHits.length === 0 && <p className="dim" style={{ fontWeight: 300, margin: 0 }}>{query ? 'nothing matches' : 'type to search threads, files, agents · esc closes'}</p>}
            {searchHits.map((h, i) => (
              <button key={i} onClick={() => { h.go(); setSearchOpen(false); setQuery('') }}><span className="faint">{h.kind} · </span>{h.label}</button>
            ))}
          </div>
        )}
      </nav>

      <div className="viewport">
        <div className="canvas" style={{ transform: `translateX(${-pivot * 100}%)` }}>
          {/* ============ HUB ============ */}
          <section className={pivot === 0 ? "page isactive" : "page"} aria-label="hub">
            <div className="hub" data-cascade>
              <div>
                <p className="label">active workstreams <span className="n">{tiledThreads.length} tiles · cap 8</span></p>
                {/* polymorphic telemetry tiles: only active / staged / blocked workstreams earn a square.
                    the big numeral changes meaning by phase; blocked goes solid accent with inline [y]/[n]. */}
                <div className="tilegrid">
                  {tiledThreads.map((t) => {
                    const tile = t.tile
                    const blocked = tile.phase === 'blocked' && gateOpen
                    return (
                      <div key={t.id} className={`tile tile-${blocked ? 'blocked' : tile.phase} tiltcard spotcard`} {...tiltSpot}>
                        <button className="tileface" data-cursor={`hub-pin:${t.id}`} onClick={() => openThread(t.id)}>
                          <span className="tiletop"><span>{blocked ? `${t.scope} · BLOCK` : t.scope}</span><span>{blocked ? seedGate.age : tile.phase === 'ready' ? 'READY' : t.age}</span></span>
                          <span className="tilebig">{blocked ? 'FAIL :142' : tile.big}</span>
                          <span className="tilesub">{tile.sub}</span>
                          <span className="tiletitle">{t.title.replace(/ UI Enhancement| Verification/g, '')}</span>
                          <span className="tiletail">{blocked ? seedGate.question.replace('Inject MockPcr0Provider for local :dev test profile only?', '? Allow legacy fallback in dev') : tile.tail}</span>
                          <span className="tileprog"><i style={{ width: `${tile.progress}%` }} /></span>
                        </button>
                        {blocked && (
                          <span className="tileyn">
                            <button onClick={() => resolveGate('yes')}>[y] yes</button>
                            <button onClick={() => resolveGate('no')}>[n] no</button>
                            <button onClick={() => { openThread(t.id); setZoom(3) }}>[enter]</button>
                          </span>
                        )}
                      </div>
                    )
                  })}
                </div>
                {gateResolved && <p className="dim" style={{ fontWeight: 300 }}>gate resolved · {gateResolved === 'yes' ? 'mock PCR0 in :dev only' : 'strict kept'} — verifier rerunning</p>}
                <p className="label" style={{ marginTop: 30 }}>idle conversations <span className="n">no tile</span></p>
                <div className="rows">
                  {idleThreads.map((t) => (
                    <button key={t.id} data-cursor={`hub-thread:${t.id}`} onClick={() => openThread(t.id)}>
                      {t.title}{t.unread > 0 && <span className="unread"> {t.unread}</span>}
                      <span className="meta"> · {t.age} · {t.project}</span>
                    </button>
                  ))}
                </div>
                <p className="label" style={{ marginTop: 30 }}>conversation epochs <span className="n">z jump grid</span></p>
                <div className="rows">
                  <button data-cursor="hub-epoch:board" onClick={() => { openThread('board'); setEpochGrid(true) }}>
                    Board of Directors <span className="unread">3</span><span className="meta"> · now · {seedEpochs.reduce((n, e) => n + e.turns, 0)} turns · {seedEpochs.length} epochs</span>
                  </button>
                </div>
              </div>

              <div>
                <p className="label">subagent pipeline <span className="n">now focused · {thread.title.toLowerCase()}</span></p>
                <p className="huge">{runningAgents[0]?.name || 'idle'}</p>
                <p className="big dim" style={{ marginTop: 8 }}>{runningAgents[0]?.task || 'no agent is running'}</p>
                <div className="progress"><i style={{ width: `${runProgress}%` }} /></div>
                <p className="dim" style={{ fontWeight: 300 }}>{runLabel}</p>
                <div style={{ marginTop: 26 }}>
                  {agents.map((a) => (
                    <button key={a.id} className="rowbtn" data-cursor={`hub-agent:${a.id}`} onClick={() => { setSelectedAgentId(a.id); setAgentsLevel(1); goPivot(PIVOTS.indexOf('agents')) }}>
                      <span className={a.state === 'running' && motion.shimmer ? 'shimmer' : `state-${a.state}`}>{a.name}</span>
                      <span className="meta faint"> · {a.phase || a.state} · {a.progress}%</span>
                      <span className="progress thin compact" style={{ display: 'block' }}><i style={{ width: `${a.progress}%`, background: a.state === 'running' ? 'var(--accent)' : 'color-mix(in srgb, var(--fg) 45%, transparent)' }} /></span>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <p className="label">recent mutation stream</p>
                <div className="activity">
                  {activity.map((a, i) => <div key={i}><span className="when">{a.when}</span>{a.what}</div>)}
                </div>
                <p className="label" style={{ marginTop: 34 }}>staged artifacts <span className="n">({artifacts.length})</span></p>
                <div className="rows">
                  {artifacts.slice(0, 4).map((a) => (
                    <button key={a} data-cursor={`hub-artifact:${a}`} onClick={() => { const f = files.find((x) => x.name === a); if (f) openFile(f); else openThread('board') }}>{a}</button>
                  ))}
                </div>
                <p className="label" style={{ marginTop: 34 }}>session metrics <span className="n">active pool</span></p>
                <div style={{ display: 'flex', gap: 44, alignItems: 'baseline' }}>
                  <span><span className="bignum">{String(agents.length).padStart(2, '0')}</span><span className="dim"> active subagents</span></span>
                  <span><span className="bignum">29 / 31</span><span className="dim"> suites green{gateOpen ? ' · 1 PCR0 block' : ''}</span></span>
                </div>
                <p className="dim" style={{ fontWeight: 300, marginTop: 10 }}>35 background tasks · {tokVelocity} tok/s</p>
              </div>
            </div>
          </section>

          {/* ============ CONVERSATION — spatial turn matrix. no bubbles, no scroll-of-death. ============ */}
          <section className={pivot === 1 ? "page isactive" : "page"} aria-label="conversation">
            <div key={focusTick} className="focusenter">
              {zoom === 2 && activeTurn ? (
                /* Z2 · decisions & mutations ledger: no conversational filler, no raw stdout —
                   user prompts, architectural decisions, and AST hunks side-by-side */
                <div>
                  <p className="label">decisions & mutations ledger · {thread.title} <span className="n">Z2 · enter Z3 · esc Z1</span></p>
                  <div className="swiss3" data-cascade>
                    <div data-col="1">
                      <p className="label">my prompts <span className="n">{promptTurns.length}</span></p>
                      {promptTurns.map((t) => (
                        <button key={t.i} className={t.i === selectedTurn ? 'turnrow sel' : 'turnrow'} data-cursor={`conv-turn:${t.i}`} onClick={() => setSelectedTurn(t.i)} onDoubleClick={() => setZoom(3)}>
                          <span className="turnhead"><span className="turnnum">{String(t.i + 1).padStart(2, '0')}</span> you <span className="faint">· E{String(t.epoch || activeEpoch.n).padStart(2, '0')}</span></span>
                          <span className="turnsummary">{t.intent}</span>
                        </button>
                      ))}
                      {promptTurns.length === 0 && <p className="faint" style={{ fontWeight: 300 }}>no prompts yet</p>}
                    </div>
                    <div data-col="2">
                      <p className="label">decisions <span className="n">{decisionTurns.length}</span></p>
                      {decisionTurns.map((t) => (
                        <button key={t.i} className={t.i === selectedTurn ? 'turnrow sel' : 'turnrow'} data-cursor={`conv-turn:${t.i}`} onClick={() => setSelectedTurn(t.i)} onDoubleClick={() => setZoom(3)}>
                          <span className="turnhead"><span className="turnnum">{String(t.i + 1).padStart(2, '0')}</span> {t.actor}</span>
                          <span className="turnsummary">{t.decision || t.summary}</span>
                        </button>
                      ))}
                      {threadId === seedGate.threadId && (
                        <div className={`gateblock ${gateOpen ? 'open' : 'resolved'}`} data-cursor="conv-gate:board" tabIndex={-1}>
                          <p className="label" style={{ margin: 0 }}>interrupt gate · {seedGate.by}</p>
                          <p className="prose" style={{ margin: '6px 0' }}>{gateOpen ? seedGate.question : `resolved · ${gateResolved === 'yes' ? seedGate.yes : seedGate.no}`}</p>
                          {gateOpen && <span className="tileyn"><button onClick={() => resolveGate('yes')}>[y] {seedGate.yes}</button><button onClick={() => resolveGate('no')}>[n] {seedGate.no}</button></span>}
                        </div>
                      )}
                    </div>
                    <div data-col="3">
                      <p className="label">file mutations <span className="n">{sessionHunks.length} hunks · {sessionChangeSet.task}</span></p>
                      {sessionHunks.map((h, hi) => (
                        <button key={hi} className="turnrow" data-cursor={`conv-artifact:${h.file}`} onClick={() => { setReviewSetId(sessionChangeSet.id); setReviewFile(h.file); goPivot(PIVOTS.indexOf('review')) }}>
                          <span className="turnhead">{h.file} <span className="faint">· {h.range} · {h.fn}</span></span>
                          <span className="turnsummary"><span style={{ color: 'var(--add)' }}>+{h.adds}</span> / <span style={{ color: 'var(--del)' }}>−{h.dels}</span> · {h.tag} · <span className={`hunkstate state-${h.state}`}>{h.state}</span></span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ) : zoom === 3 && activeTurn ? (
                /* Z3 · full-bleed session: 60% structured stream / 40% pinned context.
                   Tier-2 header above is the facet bar; epochs sit directly under it. */
                <div>
                  <div className="epochstrip" aria-label="epochs">
                    <span className="label" style={{ margin: 0 }}>epochs [z]:</span>
                    {seedEpochs.map((ep) => (
                      <button key={ep.n} className={ep.n === activeEpoch.n ? 'epochchip on' : 'epochchip'} data-cursor={`conv-epoch:${ep.n}`} onClick={() => jumpToEpoch(ep)}>
                        {ep.n === activeEpoch.n ? '■ ' : ''}[E{String(ep.n).padStart(2, '0')} {ep.name}]
                      </button>
                    ))}
                    <button className="ghostbtn" onClick={() => setEpochGrid(true)}>jump grid</button>
                  </div>
                  <div className={splitTurn !== null ? 'z3grid split' : 'z3grid'}>
                    <div>
                      <p className="label">{facet === 'all' ? `active stream · epoch ${String(activeEpoch.n).padStart(2, '0')}` : `facet · ${facet}`} <span className="n">{thread.title}</span></p>
                      {facetTurns.map((t, fi) => (
                        <div key={t.i}>
                          {(fi === 0 || facetTurns[fi - 1].epoch !== t.epoch) && t.epoch && (
                            <button className="milestone" onClick={() => setEpochGrid(true)}>[ E{String(t.epoch).padStart(2, '0')} · {(seedEpochs.find((e) => e.n === t.epoch) || {}).name || 'SESSION'} · {(seedEpochs.find((e) => e.n === t.epoch) || {}).turns || ''} turns ]</button>
                          )}
                          <button className={t.i === selectedTurn ? 'streamturn sel' : 'streamturn'} data-cursor={`conv-turn:${t.i}`} onClick={() => setSelectedTurn(t.i)}>
                            <span className="streamhead">{t.actor === 'user' ? 'YOU' : t.actor} <span className="faint">[{t.kind ? t.kind.toUpperCase() : 'TURN'} #{String(t.i + 1).padStart(2, '0')} · {t.age}]</span>{splitTurn === t.i && <span className="accent"> · pinned (v)</span>}</span>
                            <span className="prose" style={{ display: 'block' }}>{t.full || t.synthesis}</span>
                            {(t.stdout || []).length > 0 && <span className="stdout mono" style={{ display: 'block' }}>{t.stdout.map((l, li) => <span key={li} style={{ display: 'block' }}>{l}</span>)}</span>}
                            {t.state === 'running' && <span className="progress thin compact" style={{ display: 'block' }}><i style={{ width: `${t.progress || 0}%` }} /></span>}
                          </button>
                        </div>
                      ))}
                      {facetTurns.length === 0 && <p className="faint" style={{ fontWeight: 300 }}>nothing in this facet yet</p>}
                      {threadId === seedGate.threadId && (facet === 'all' || facet === 'decisions') && (
                        <div className={`gateblock ${gateOpen ? 'open' : 'resolved'}`} data-cursor="conv-gate:board" tabIndex={-1}>
                          <p className="label" style={{ margin: 0 }}>interrupt gate [{seedGate.by} · {seedGate.kind}]</p>
                          <p className="prose" style={{ margin: '8px 0' }}>{seedGate.text}</p>
                          <p className="prose accent" style={{ margin: '4px 0' }}>? {seedGate.question}</p>
                          {gateOpen
                            ? <span className="tileyn"><button onClick={() => resolveGate('yes')}>[y] {seedGate.yes}</button><button onClick={() => resolveGate('no')}>[n] {seedGate.no}</button><button onClick={() => { setPromptOpen(true) }}>[c] custom</button></span>
                            : <p className="prose dim">resolved · {gateResolved === 'yes' ? seedGate.yes : seedGate.no} — verifier rerunning</p>}
                        </div>
                      )}
                      {promptOpen ? (
                        <>
                          <p className="label" style={{ marginTop: 26 }}>prompt · {engineSummary} <span className="n">enter send · esc close</span></p>
                          <textarea ref={promptRef} className="inlineprompt" rows={3} placeholder="instruct swarm, : for command, ! for raw shell" value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} />
                        </>
                      ) : (
                        <button className="promptcue" onClick={() => setPromptOpen(true)}>&gt; _ <span className="faint">[i] instruct swarm or type raw shell command into pty…</span></button>
                      )}
                    </div>
                    <div>
                      {splitTurn !== null && turns[splitTurn] ? (
                        <>
                          <p className="label">pinned · turn {String(splitTurn + 1).padStart(2, '0')} <span className="n">v unpin · 50/50 split</span></p>
                          <p className="big" style={{ marginBottom: 10 }}>{turns[splitTurn].actor}</p>
                          <p className="prose">{turns[splitTurn].full || turns[splitTurn].synthesis}</p>
                          <p className="label" style={{ marginTop: 22 }}>trace</p>
                          {(turns[splitTurn].trace || []).map((l, i) => <p key={i} className="prose dim">{l}</p>)}
                        </>
                      ) : (
                        <>
                          <p className="label">pinned context · live diff <span className="n">{reviewFileObj?.name}:{activeHunk?.line}</span></p>
                          {activeHunk && activeHunk.lines.map(([sign, line], i) => (
                            <div key={i} className={`diffline ${sign === '+' ? 'add' : sign === '-' ? 'del' : ''}`}>{sign} {line}</div>
                          ))}
                          <p className="label" style={{ marginTop: 26 }}>contract & invariant gates <span className="n">epoch {String(activeEpoch.n).padStart(2, '0')}</span></p>
                          {seedInvariants.map((g) => (
                            <p key={g.name} className="prose" style={{ margin: '2px 0' }}><span className={`invstate inv-${g.state}`}>{g.state === 'FAIL' && !gateOpen && gateResolved === 'yes' ? 'RUN' : g.state}</span> {g.name} <span className="faint">({g.detail})</span></p>
                          ))}
                          <p className="label" style={{ marginTop: 26 }}>spawned workers in this epoch</p>
                          {agents.slice(0, 4).map((a, i) => (
                            <p key={a.id} className="prose" style={{ margin: '2px 0' }}><span className="turnnum">{String(i + 1).padStart(2, '0')}</span> {a.name} <span className="faint">· {a.phase || a.state} · {a.progress}%</span></p>
                          ))}
                          <p className="label" style={{ marginTop: 26 }}>active turn trace</p>
                          {(activeTurn.trace || []).map((l, i) => <p key={i} className="prose dim">{l}</p>)}
                          {(activeTurn.artifacts || []).length > 0 && (
                            <>
                              <p className="label" style={{ marginTop: 22 }}>emitted artifacts</p>
                              {activeTurn.artifacts.map((a) => (
                                <button key={a} className="artifactlink" data-cursor={`conv-artifact:${a}`} onClick={() => { const f = files.find((x) => x.name === a); if (f) openFile(f) }}>→ {a}</button>
                              ))}
                            </>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <>
                {narrow && convLevel > 0 && (
                  <button className="drillhead" onClick={() => setConvLevel(convLevel - 1)} aria-label="back">
                    <span className="drillarrow">‹</span> {convLevel === 1 ? 'active threads' : thread.title.toLowerCase()}
                  </button>
                )}
                <div className="swiss3" data-cascade data-level={convLevel}>
                  <div data-col="1">
                    <p className="label">active threads</p>
                    {threads.map((t) => (
                      <button key={t.id} className={t.id === threadId ? 'threadblock sel' : 'threadblock'} data-cursor={`conv-thread:${t.id}`} onClick={() => { setThreadId(t.id); setThreads((ts) => ts.map((x) => (x.id === t.id ? { ...x, unread: 0 } : x))); setConvLevel(1) }}>
                        <span className={t.unread > 0 ? 'threadtitle urgent' : 'threadtitle'}>{t.title}{t.unread > 0 && <sup className="unread"> {t.unread}</sup>}</span>
                        <span className="threadsub">{t.status}</span>
                        <span className="threadsub faint">{t.age} · {t.project}</span>
                      </button>
                    ))}
                    <button className="ghostbtn" style={{ marginTop: 14 }} onClick={() => togglePin(thread.id)}>{thread.pinned ? 'unpin thread · p' : 'pin thread · p'}</button>
                  </div>
                  <div data-col="2">
                    <p className="label">turn timeline ({thread.title})</p>
                    {turns.length === 0 && <p className="huge faint" style={{ marginTop: 18 }}>ask anything.</p>}
                    {turns.map((tn, i) => (
                      <button key={i} className={i === selectedTurn ? 'turnrow sel' : 'turnrow'} data-cursor={`conv-turn:${i}`} onClick={() => { setSelectedTurn(i); setConvLevel(2); scrollPayloadIntoView() }} onDoubleClick={() => setZoom(3)}>
                        <span className="turnhead"><span className="turnnum">{String(i + 1).padStart(2, '0')}</span> <span className={tn.state === 'running' ? (motion.shimmer ? 'shimmer' : 'accent') : ''}>{tn.actor}</span><span className="faint"> · {tn.age}</span></span>
                        <span className="turnsummary">{tn.summary}</span>
                        {tn.state === 'running'
                          ? <span className="progress thin compact" style={{ display: 'block' }}><i style={{ width: `${tn.progress || 0}%` }} /></span>
                          : <span className="turnmeta">{tn.state === 'queued' ? 'queued' : tn.artifacts?.length ? `${tn.artifacts.length} artifact${tn.artifacts.length > 1 ? 's' : ''}` : ''}</span>}
                      </button>
                    ))}
                  </div>
                  <div data-col="3" data-payload>
                    {promptOpen ? (
                      <>
                        <p className="label">prompt · {engineSummary} <span className="n">enter send · esc close</span></p>
                        <textarea ref={promptRef} className="inlineprompt" rows={4} placeholder="ask anything. @ to mention, / for actions" value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} />
                        <div style={{ marginTop: 10, display: 'flex', gap: 22, alignItems: 'baseline' }}>
                          <button className="solid" onClick={send}>send</button>
                          <button className="ghostbtn" onClick={() => goPivot(PIVOTS.indexOf('settings'))}>engine settings</button>
                          <span className="dim" style={{ fontWeight: 300 }}>{config.mode} · local: {localStatus.state}</span>
                        </div>
                      </>
                    ) : activeTurn ? (
                      <>
                        <p className="label">active turn [{String(selectedTurn + 1).padStart(2, '0')}] · artifacts</p>
                        <p className="label">prompt intent</p>
                        <p className="prose">{activeTurn.intent}</p>
                        <p className="label" style={{ marginTop: 24 }}>synthesis{activeTurn.engine ? ` · ${activeTurn.engine}` : ''}</p>
                        <p className="prose">{activeTurn.synthesis || '…'}</p>
                        {activeTurn.fallbackFrom && <p className="prose accent">remote failed ({activeTurn.fallbackFrom}) — answered locally</p>}
                        {activeTurn.stats?.length > 0 && (
                          <>
                            <p className="label" style={{ marginTop: 24 }}>spawned subagents & outputs</p>
                            <div style={{ display: 'flex', gap: 40, alignItems: 'baseline', flexWrap: 'wrap' }}>
                              {activeTurn.stats.map((s) => <span key={s.l}><span className="bignum">{s.v}</span><span className="dim"> {s.l}</span></span>)}
                            </div>
                          </>
                        )}
                        {activeTurn.artifacts?.length > 0 && (
                          <>
                            <p className="label" style={{ marginTop: 24 }}>emitted artifacts</p>
                            {activeTurn.artifacts.map((a) => (
                              <button key={a} className="artifactlink" data-cursor={`conv-artifact:${a}`} onClick={() => { const f = files.find((x) => x.name === a); if (f) openFile(f); else if (a === 'Prompt Draft') { pushActivity('you proceeded with Prompt Draft'); setRunProgress(8); setRunLabel('teamwork_preview · iteration 6') } }}>→ {a}</button>
                            ))}
                          </>
                        )}
                      </>
                    ) : <p className="dim" style={{ fontWeight: 300 }}>press i to start this thread</p>}
                  </div>
                </div>
                </>
              )}
            </div>
          </section>

          {/* ============ COLLECTION (folders / files / code) ============ */}
          <section className={pivot === 2 ? "page isactive" : "page"} aria-label="collection">
            {narrow && colLevel > 0 && (
              <button className="drillhead" onClick={() => setColLevel(colLevel - 1)} aria-label="back">
                <span className="drillarrow">‹</span> {colLevel === 1 ? 'folders' : folder}
              </button>
            )}
            <div className="collection" data-cascade data-level={colLevel} key={'c' + focusTick}>
              <div data-col="1">
                <p className="label">folders</p>
                <div className="collist">
                  {folders.map((f) => <button key={f} className={f === folder ? 'on' : ''} data-cursor={`col-folder:${f}`} onClick={() => { setFolder(f); const first = files.find((x) => x.folder === f); if (first) setFileName(first.name); setColLevel(1) }}>{f}</button>)}
                </div>
              </div>
              <div data-col="2">
                <p className="label">files</p>
                <div className="collist">
                  {files.filter((f) => f.folder === folder).map((f) => (
                    <button key={f.name} className={f.name === fileName ? 'on' : ''} data-cursor={`col-file:${f.name}`} onClick={() => { setFileName(f.name); setColLevel(2) }}>
                      {f.name}<div className="meta">{f.lines} lines · {f.lang}</div>
                    </button>
                  ))}
                  {files.filter((f) => f.folder === folder).length === 0 && <p className="faint" style={{ fontWeight: 300 }}>nothing here yet</p>}
                </div>
              </div>
              <div data-col="3">
                <p className="label">{file.folder} / {file.name}</p>
                <p className="big" style={{ marginBottom: 16 }}>{file.name}</p>
                <code className="codeview">{file.body.map((l, i) => <span key={i}><span className="ln">{i + 1}</span>{l}{'\n'}</span>)}</code>
                <div style={{ marginTop: 22, display: 'flex', gap: 26 }}>
                  <button className="solid" onClick={() => { setDraft(`explain ${file.name} and suggest the smallest safe refactor`); openThread(threadId); setPromptOpen(true) }}>ask about this file</button>
                  <button className="ghostbtn" onClick={() => setZoom(0)}>zoom out to map</button>
                </div>
              </div>
            </div>
          </section>

          {/* ============ REVIEW — hunk-level triage. never scroll a raw file to review a mutation. ============ */}
          <section className={pivot === 3 ? "page isactive" : "page"} aria-label="review">
            {zoom === 2 && reviewFileObj ? (
              /* Z2 in review · the same ledger discipline: prompts + decisions + hunks, no file scroll */
              <div>
                <p className="label">decisions & mutations ledger · {reviewSet.task} <span className="n">Z2 · enter full file (Z3) · esc Z1</span></p>
                <div className="swiss3" data-cascade>
                  <div data-col="1">
                    <p className="label">my prompts</p>
                    {promptTurns.map((t) => (
                      <button key={t.i} className="turnrow" data-cursor={`conv-turn:${t.i}`} onClick={() => { setSelectedTurn(t.i); goPivot(PIVOTS.indexOf('conversation')) }}>
                        <span className="turnhead"><span className="turnnum">{String(t.i + 1).padStart(2, '0')}</span> you</span>
                        <span className="turnsummary">{t.intent}</span>
                      </button>
                    ))}
                  </div>
                  <div data-col="2">
                    <p className="label">decisions</p>
                    {decisionTurns.map((t) => (
                      <button key={t.i} className="turnrow" data-cursor={`conv-turn:${t.i}`} onClick={() => { setSelectedTurn(t.i); goPivot(PIVOTS.indexOf('conversation')) }}>
                        <span className="turnhead"><span className="turnnum">{String(t.i + 1).padStart(2, '0')}</span> {t.actor}</span>
                        <span className="turnsummary">{t.decision || t.summary}</span>
                      </button>
                    ))}
                  </div>
                  <div data-col="3">
                    <p className="label">mutation hunks · {reviewFileObj.name}</p>
                    {reviewFileObj.hunks.map((h, i) => (
                      <button key={i} className={i === selectedHunk ? 'hunkrow sel' : 'hunkrow'} data-cursor={`rev-hunk:${i}`} onClick={() => setSelectedHunk(i)} onDoubleClick={() => setZoom(3)}>
                        <span className="turnhead"><span className="turnnum">{String(i + 1).padStart(2, '0')}</span> {h.range} · {h.fn}</span>
                        <span className="turnsummary"><span style={{ color: 'var(--add)' }}>+{h.adds}</span> / <span style={{ color: 'var(--del)' }}>−{h.dels}</span> · {h.tag}</span>
                        <span className={`hunkstate state-${h.state}`}>{h.state}</span>
                      </button>
                    ))}
                    {activeHunk && <p className="prose" style={{ marginTop: 16 }}>{activeHunk.rationale}</p>}
                  </div>
                </div>
              </div>
            ) : zoom === 3 && reviewFileObj ? (
              /* Z3 · full file, centered on the hunk's line */
              <div>
                <p className="label">{reviewSet.task} / {reviewFileObj.name} · hunk {selectedHunk + 1} at line {activeHunk?.line} <span className="n">esc back</span></p>
                <p className="big" style={{ marginBottom: 16 }}>{reviewFileObj.name}</p>
                {(() => {
                  const src = files.find((f) => f.name === reviewFileObj.name)
                  if (src) return <code className="codeview">{src.body.map((l, i) => <span key={i}><span className="ln">{i + 1}</span>{l}{'\n'}</span>)}</code>
                  return activeHunk.lines.map(([sign, line], i) => (
                    <div key={i} className={`diffline ${sign === '+' ? 'add' : sign === '-' ? 'del' : ''}`}>{sign} {line}</div>
                  ))
                })()}
                <p className="dim" style={{ fontWeight: 300, marginTop: 20 }}>full-file context for hunk {selectedHunk + 1} · {activeHunk?.range} · {activeHunk?.fn}</p>
              </div>
            ) : (
              <>
              {narrow && revLevel > 0 && (
                <button className="drillhead" onClick={() => setRevLevel(revLevel - 1)} aria-label="back">
                  <span className="drillarrow">‹</span> {revLevel === 1 ? 'change sets' : reviewFileObj?.name.toLowerCase()}
                </button>
              )}
              <div className="swiss3" data-cascade data-level={revLevel}>
                <div data-col="1">
                  <p className="label">change sets</p>
                  {changeSets.map((cs) => (
                    <div key={cs.id}>
                      <button className={cs.id === reviewSetId ? 'setblock sel' : 'setblock'} data-cursor={`rev-set:${cs.id}`} onClick={() => { setReviewSetId(cs.id); setReviewFile(cs.files[0].name); setSelectedHunk(0) }}>
                        <span className="settitle">{cs.task}</span>
                        <span className="setsub">{cs.files.length} files · {cs.files.reduce((n, f) => n + f.hunks.filter((h) => h.state === 'UNREVIEWED').length, 0)} unreviewed</span>
                      </button>
                      {cs.id === reviewSetId && cs.files.map((f) => (
                        <button key={f.name} className={f.name === reviewFile ? 'revfile sel' : 'revfile'} data-cursor={`rev-file:${f.name}`} onClick={() => { setReviewFile(f.name); setSelectedHunk(0); setRevLevel(1) }}>
                          <span className="revfilename">{f.name}</span>
                          <span className="setsub"><span style={{ color: 'var(--add)' }}>+{f.adds}</span> / <span style={{ color: 'var(--del)' }}>−{f.dels}</span> · {f.hunks.length} hunk{f.hunks.length > 1 ? 's' : ''}</span>
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
                <div data-col="2">
                  <p className="label">mutation hunks ({reviewFileObj?.name})</p>
                  {(reviewFileObj?.hunks || []).map((h, i) => (
                    <button key={i} className={i === selectedHunk ? 'hunkrow sel' : 'hunkrow'} data-cursor={`rev-hunk:${i}`} onClick={() => { setSelectedHunk(i); setRevLevel(2); scrollPayloadIntoView() }} onDoubleClick={() => setZoom(3)}>
                      <span className="turnhead"><span className="turnnum">{String(i + 1).padStart(2, '0')}</span> {h.range} · {h.fn}</span>
                      <span className="turnsummary"><span style={{ color: 'var(--add)' }}>+{h.adds}</span> / <span style={{ color: 'var(--del)' }}>−{h.dels}</span> · {h.tag}</span>
                      <span className={`hunkstate state-${h.state}`}>{h.state}</span>
                    </button>
                  ))}
                </div>
                <div data-col="3" data-payload>
                  {activeHunk && (
                    <>
                      <p className="label">hunk diff [{String(selectedHunk + 1).padStart(2, '0')}/{String(reviewFileObj.hunks.length).padStart(2, '0')}] · line {activeHunk.line}</p>
                      {activeHunk.lines.map(([sign, line], i) => (
                        <div key={i} className={`diffline ${sign === '+' ? 'add' : sign === '-' ? 'del' : ''}`}>{sign} {line}</div>
                      ))}
                      <p className="label" style={{ marginTop: 26 }}>agent rationale ({activeHunk.by})</p>
                      <p className="prose">{activeHunk.rationale}</p>
                      {activeHunk.comment && <p className="prose accent">you → {activeHunk.by}: {activeHunk.comment}</p>}
                      <p className="label" style={{ marginTop: 24 }}>verification status</p>
                      <p className="prose">{activeHunk.verification}</p>
                      <p className="prose" style={{ marginTop: 14 }}><span className={`hunkstate state-${activeHunk.state}`}>{activeHunk.state}</span></p>
                      {instructOpen && (
                        <>
                          <p className="label" style={{ marginTop: 24 }}>instruct {activeHunk.by} <span className="n">enter send · esc close</span></p>
                          <textarea ref={instructRef} className="inlineprompt" rows={3} placeholder="rewrite this hunk without throwing an exception" value={instructDraft}
                            onChange={(e) => setInstructDraft(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendInstruction() } }} />
                        </>
                      )}
                      <div style={{ display: 'flex', gap: 26, marginTop: 22 }}>
                        <button className="ghostbtn" onClick={() => setHunkState('STAGED')}>approve · a</button>
                        <button className="ghostbtn" onClick={() => setHunkState('REJECTED')}>reject · x</button>
                        <button className="ghostbtn" onClick={() => setInstructOpen(true)}>instruct · c</button>
                      </div>
                    </>
                  )}
                </div>
              </div>
              </>
            )}
          </section>

          {/* ============ TERMINAL ============ */}
          <section className={pivot === 4 ? "page isactive" : "page"} aria-label="terminal">
            <p className="label">terminal · fragments</p>
            <div className="term">
              {termLines.map((l, i) => <div key={i}>{l}</div>)}
              <div className="promptline"><span className="accent">$</span>
                <input value={termInput} placeholder="type help" aria-label="terminal input" onChange={(e) => setTermInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') runTerm(termInput) }} />
              </div>
            </div>
          </section>

          {/* ============ AGENTS — same 3-column Swiss grid as the hub, never full-width rows ============ */}
          <section className={pivot === 5 ? "page isactive" : "page"} aria-label="agents">
            {narrow && agentsLevel > 0 && (
              <button className="drillhead" onClick={() => setAgentsLevel(0)} aria-label="back">
                <span className="drillarrow">‹</span> agents
              </button>
            )}
            <div className="agentsgrid" data-cascade data-level={agentsLevel}>
              <div data-col="1">
                <p className="label">running <span className="n">{runningAgents.length}</span></p>
                {runningAgents.length === 0 && <p className="faint" style={{ fontWeight: 300 }}>nothing running</p>}
                {agents.filter((a) => a.state === 'running').map((a) => (
                  <button key={a.id} className="agentblock tiltcard spotcard" {...tiltSpot} data-cursor={`agents-agent:${a.id}`} onClick={() => { setSelectedAgentId(a.id); setAgentsLevel(1); scrollPayloadIntoView() }}>
                    <span className={`agentname ${motion.shimmer ? 'shimmer' : 'state-running'}`}>{a.name}</span>
                    <span className="agenttask">{a.task}</span>
                    <span className="progress thin compact" style={{ display: 'block' }}><i style={{ width: `${a.progress}%` }} /></span>
                    <span className="agentmeta">running · {a.progress}% · {a.elapsed}</span>
                  </button>
                ))}
              </div>
              <div data-col="1">
                <p className="label">queued / complete</p>
                {agents.filter((a) => a.state !== 'running').map((a) => (
                  <button key={a.id} className="agentblock tiltcard spotcard" {...tiltSpot} data-cursor={`agents-agent:${a.id}`} onClick={() => { setSelectedAgentId(a.id); setAgentsLevel(1); scrollPayloadIntoView() }}>
                    <span className={`agentname state-${a.state}`}>{a.name}</span>
                    <span className="agenttask dim">{a.task}</span>
                    <span className={`agentmeta state-${a.state}`}>{a.state} · {a.progress}%</span>
                  </button>
                ))}
                <p className="label" style={{ marginTop: 34 }}>background tasks</p>
                <span className="bignum">35</span><span className="dim" style={{ fontWeight: 300 }}> · {agents.length} subagents · {runningAgents.length} running</span>
                <p className="dim" style={{ fontWeight: 300, marginTop: 14 }}>artifacts {artifacts.length} · workflow teamwork_preview</p>
              </div>
              <div data-col="2" data-payload>
                <p className="label">selected · telemetry</p>
                {telemetryAgent && (
                  <>
                    <p className="big" style={{ marginBottom: 4 }}>{telemetryAgent.name}</p>
                    <p className="dim" style={{ fontWeight: 300, margin: '0 0 18px 0' }}>{telemetryAgent.task} · <span className={`state-${telemetryAgent.state}`}>{telemetryAgent.state}</span></p>
                    <div style={{ display: 'flex', gap: 40, alignItems: 'baseline', marginBottom: 20 }}>
                      <span><span className="bignum">{telemetryAgent.tokens}</span><span className="dim"> tokens</span></span>
                      <span><span className="bignum">{telemetryAgent.tools}</span><span className="dim"> tools</span></span>
                      <span><span className="bignum">{telemetryAgent.progress}%</span></span>
                    </div>
                    <p className="label">stdout</p>
                    <div className="stdout mono">
                      {telemetryAgent.log.map((l, i) => <div key={i}>{l}</div>)}
                      {telemetryAgent.state === 'running' && <div className="accent">▌</div>}
                    </div>
                    <div style={{ display: 'flex', gap: 26, marginTop: 20 }}>
                      <button className="ghostbtn" onClick={() => toggleAgent(telemetryAgent.id)}>{telemetryAgent.state === 'running' ? 'pause · p' : 'run · p'}</button>
                      <button className="ghostbtn" onClick={() => goPivot(PIVOTS.indexOf('review'))}>diff · d</button>
                      <button className="ghostbtn" onClick={() => killAgent(telemetryAgent.id)}>kill · x</button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </section>

          {/* ============ SETTINGS ============ */}
          <section className={pivot === 6 ? "page isactive" : "page"} aria-label="settings">
            {/* Zune 4.0 configuration matrix: domains -> parameters -> live preview.
                same 25/35/40 borderless grid, no toggle pills, no dropdown boxes. */}
            <div className="swiss3" data-cascade>
              <div data-col="1">
                <p className="label">configuration domains</p>
                {[
                  ['01 agent pool & routing', `${agents.length} active · ${config.maxParallel ?? 10} max subagents`],
                  ['02 telemetry tile thresholds', `${accent.value} on gate fail only`],
                  ['03 sandbox & enclave gates', gates.strictPcr ? 'PCR0 strict · auto-test' : 'PCR0 relaxed'],
                  ['04 keyboard & semantic zoom', 'vim hjkl · 4-stop Z-axis'],
                  ['05 typography & swiss grid', `${theme} swiss · ${accent.name} accent`],
                  ['06 daemons & local endpoints', `bridge ${bridgeStatus} · local ${localStatus.state}`],
                ].map(([name, sub], i) => (
                  <button key={name} className={i === setDomain ? 'threadblock sel' : 'threadblock'} data-cursor={`set-domain:${i}`} onClick={() => setSetDomain(i)}>
                    <span className="threadtitle" style={{ textTransform: 'uppercase', fontSize: 'calc(15px * var(--scale))' }}>{name}</span>
                    <span className="threadsub">{sub}</span>
                  </button>
                ))}
                <p className="dim" style={{ fontWeight: 300, marginTop: 18 }}>[j/k] domain · [h/l] parameters · [r] reset domain</p>
              </div>
              <div data-col="2">
                {setDomain === 0 && (<>
                  <p className="label">swarm & model routing <span className="n">{engineSummary}</span></p>
                  <p className="label">primary orchestrator</p>
                  <div className="optrow" style={{ marginBottom: 14 }}>
                    {['auto', 'remote', 'local', 'demo'].map((m) => <button key={m} className={config.mode === m ? 'on' : ''} onClick={() => setCfg({ mode: m })}>{m}</button>)}
                  </div>
                  <p className="dim" style={{ fontWeight: 300, lineHeight: 1.55, margin: '0 0 18px 0' }}>
                    auto tries the native bridge, then your remote provider; on any remote error the on-device LiteRT-LM model answers and helps diagnose the failure. Keys live only in this browser's localStorage.
                  </p>
                  <div className="optrow" style={{ marginBottom: 14 }}>
                    <button className={config.provider === 'anthropic' ? 'on' : ''} onClick={() => setCfg({ provider: 'anthropic' })}>anthropic</button>
                    <button className={config.provider === 'openai' ? 'on' : ''} onClick={() => setCfg({ provider: 'openai' })}>openai-compatible</button>
                  </div>
                  <div className="setgrid">
                    <label>api key<input className="setinput" type="password" placeholder="sk-…" value={config.apiKey} onChange={(e) => setCfg({ apiKey: e.target.value })} /></label>
                    {config.provider === 'anthropic'
                      ? <label>model<input className="setinput" value={config.model} onChange={(e) => setCfg({ model: e.target.value })} /></label>
                      : <>
                          <label>model<input className="setinput" value={config.openaiModel} onChange={(e) => setCfg({ openaiModel: e.target.value })} /></label>
                          <label>base url<input className="setinput" value={config.baseUrl} onChange={(e) => setCfg({ baseUrl: e.target.value })} /></label>
                        </>}
                  </div>
                  <p className="label" style={{ marginTop: 26 }}>concurrency & worker budget</p>
                  {[['max parallel subagents', 'maxParallel', 10, 1, 200], ['max pty test runners', 'maxPty', 4, 1, 16]].map(([label, k, def, lo, hi]) => (
                    <div key={k} className="paramrow"><span>{label}</span><span className="optrow">
                      <button onClick={() => setCfg({ [k]: Math.max(lo, (config[k] ?? def) - 1) })}>−</button>
                      <b className="paramval">{config[k] ?? def}</b>
                      <button onClick={() => setCfg({ [k]: Math.min(hi, (config[k] ?? def) + 1) })}>+</button>
                    </span></div>
                  ))}
                  <div className="paramrow"><span>token ceiling per epoch</span><span className="optrow">{['250k', '500k', '2.5M'].map((v) => <button key={v} className={(config.tokenCeiling || '500k') === v ? 'on' : ''} onClick={() => setCfg({ tokenCeiling: v })}>{v}</button>)}</span></div>
                </>)}
                {setDomain === 1 && (<>
                  <p className="label">live tile escalation rules <span className="n">{accent.value}</span></p>
                  {[['onFail', 'escalate on test assertion fail'], ['onAmbiguity', 'escalate on contract ambiguity'], ['onBigDiff', `escalate on diff > ${tilePolicy.bigDiffLines} lines`]].map(([k, label]) => (
                    <div key={k} className="paramrow"><span>{label}</span><span className="optrow">
                      <button className={tilePolicy[k] ? 'on' : ''} onClick={() => setCfg({ tilePolicy: { ...tilePolicy, [k]: true } })}>YES</button>
                      <button className={!tilePolicy[k] ? 'on' : ''} onClick={() => setCfg({ tilePolicy: { ...tilePolicy, [k]: false } })}>NO</button>
                    </span></div>
                  ))}
                  <div className="paramrow"><span>big-diff threshold (lines)</span><span className="optrow">
                    <button onClick={() => setCfg({ tilePolicy: { ...tilePolicy, bigDiffLines: Math.max(50, tilePolicy.bigDiffLines - 50) } })}>−</button>
                    <b className="paramval">{tilePolicy.bigDiffLines}</b>
                    <button onClick={() => setCfg({ tilePolicy: { ...tilePolicy, bigDiffLines: tilePolicy.bigDiffLines + 50 } })}>+</button>
                  </span></div>
                  <div className="paramrow"><span>auto-approve hunks &lt; 20 lines</span><span className="optrow">
                    <button className={tilePolicy.autoApproveUnder > 0 ? 'on' : ''} onClick={() => setCfg({ tilePolicy: { ...tilePolicy, autoApproveUnder: 20 } })}>YES</button>
                    <button className={tilePolicy.autoApproveUnder === 0 ? 'on' : ''} onClick={() => setCfg({ tilePolicy: { ...tilePolicy, autoApproveUnder: 0 } })}>NO</button>
                  </span></div>
                  <p className="dim" style={{ fontWeight: 300, lineHeight: 1.55 }}>Tiles stay muted during autonomous execution. A tile only earns the solid accent when a YES rule fires — then it binds [y]/[n] right on the hub.</p>
                </>)}
                {setDomain === 2 && (<>
                  <p className="label">sandbox & enclave gates</p>
                  {[['strictPcr', 'enclave PCR0 attestation · STRICT'], ['haltOnMismatch', 'halt on enclave PCR mismatch'], ['advTests', 'require adversarial test green to merge']].map(([k, label]) => (
                    <div key={k} className="paramrow"><span>{label}</span><span className="optrow">
                      <button className={gates[k] ? 'on' : ''} onClick={() => setCfg({ gates: { ...gates, [k]: true } })}>YES</button>
                      <button className={!gates[k] ? 'on' : ''} onClick={() => setCfg({ gates: { ...gates, [k]: false } })}>NO</button>
                    </span></div>
                  ))}
                  <p className="label" style={{ marginTop: 26 }}>local · litert-lm <span className="n">{localStatus.state}</span></p>
                  <div className="setgrid">
                    <label>model url (.litertlm)<input className="setinput" value={config.localModelUrl} onChange={(e) => setCfg({ localModelUrl: e.target.value })} /></label>
                  </div>
                  <p className="dim" style={{ fontWeight: 300, margin: '8px 0' }}>{localStatus.detail} · nothing bundled: downloads on first chat, then browser-cached.</p>
                  <div style={{ display: 'flex', gap: 26, alignItems: 'baseline' }}>
                    <button className="ghostbtn" onClick={() => ensureLocal(config.localModelUrl).catch(() => {})}>load local model now</button>
                    <span className="dim" style={{ fontWeight: 300 }}>background preload</span>
                    <span className="optrow">
                      <button className={config.bgPreload ? 'on' : ''} onClick={() => setCfg({ bgPreload: true })}>on</button>
                      <button className={!config.bgPreload ? 'on' : ''} onClick={() => setCfg({ bgPreload: false })}>off</button>
                    </span>
                  </div>
                </>)}
                {setDomain === 3 && (<>
                  <p className="label">keyboard & semantic zoom</p>
                  {coarse ? (
                    <p style={{ fontWeight: 300, lineHeight: 1.9, margin: 0 }}>
                      flick ← →&ensp;pan pivots&emsp;tap a cropped pivot word&ensp;jump there<br />
                      tap a row&ensp;drill in&emsp;tap the ‹ parent header or flick right&ensp;back<br />
                      pinch&ensp;step the 4-stop semantic zoom&emsp;bottom baseline&ensp;actions for what you tapped
                    </p>
                  ) : (
                    <p style={{ fontWeight: 300, lineHeight: 1.9, margin: 0 }}>
                      ⌘ + 1–9&ensp;sessions&emsp;[ ] / alt + ← →&ensp;pivots&emsp;tab&ensp;facet in Z3<br />
                      h j k l&ensp;2D spatial cursor&emsp;f + two letters&ensp;gutter jump badges<br />
                      ctrl + scroll / enter / esc&ensp;Z0–Z3 semantic zoom stops<br />
                      z&ensp;epoch jump grid&emsp;v&ensp;pin split in Z3&emsp;: or ctrl + k&ensp;command ribbon (morphs header)<br />
                      y / n&ensp;resolve a gate from its tile&emsp;? or hold alt&ensp;key hints
                    </p>
                  )}
                  <p className="label" style={{ marginTop: 26 }}>session epoch auto-segmentation</p>
                  {[['onCommit', 'slice new epoch on git commit'], ['compressZ2', 'compress stdout in Z-Level 2 ledger']].map(([k, label]) => {
                    const ep = { onCommit: true, compressZ2: true, everyTurns: 15, ...(config.epochs || {}) }
                    return (
                      <div key={k} className="paramrow"><span>{label}</span><span className="optrow">
                        <button className={ep[k] ? 'on' : ''} onClick={() => setCfg({ epochs: { ...ep, [k]: true } })}>YES</button>
                        <button className={!ep[k] ? 'on' : ''} onClick={() => setCfg({ epochs: { ...ep, [k]: false } })}>NO</button>
                      </span></div>
                    )
                  })}
                  <div className="paramrow"><span>slice new epoch after N turns</span><span className="optrow">{[10, 15, 25].map((v) => <button key={v} className={((config.epochs || {}).everyTurns || 15) === v ? 'on' : ''} onClick={() => setCfg({ epochs: { onCommit: true, compressZ2: true, ...(config.epochs || {}), everyTurns: v } })}>{v}</button>)}</span></div>
                </>)}
                {setDomain === 4 && (<>
                  <p className="label">typography & swiss grid</p>
                  <p className="label">accent</p>
                  <div className="swatches">
                    {ACCENTS.map((a) => (
                      <button key={a.name} className={accent.name === a.name ? 'swatch on' : 'swatch'} style={{ background: a.value }} onClick={() => setAccent(a)}>{a.name}</button>
                    ))}
                  </div>
                  <p className="label">theme</p>
                  <div className="optrow" style={{ marginBottom: 18 }}>
                    <button className={theme === 'dark' ? 'on' : ''} onClick={() => setTheme('dark')}>black</button>
                    <button className={theme === 'light' ? 'on' : ''} onClick={() => setTheme('light')}>white</button>
                  </div>
                  <p className="label">type scale · high-dpi density</p>
                  <div className="optrow" style={{ marginBottom: 18 }}>
                    {[1, 1.25, 1.5].map((d) => <button key={d} className={density === d ? 'on' : ''} onClick={() => setDensity(d)}>{Math.round(d * 100)}%</button>)}
                  </div>
                  <p className="label">motion · cards & panels</p>
                  <p className="dim" style={{ fontWeight: 300, lineHeight: 1.55, margin: '0 0 10px 0' }}>
                    Metro-translated motion: WP press-tilt, hard square spotlight cell, flat offset glow (no blur), shimmer only on running work. Per-card opt-in; these switches kill whole families.
                  </p>
                  {Object.entries({ tilt: 'tilt (press lean)', spotlight: 'spotlight (square cell)', glow: 'glow (offset block)', shimmer: 'text shimmer (running)', cascade: 'panel cascade + fold' }).map(([k, label]) => (
                    <div key={k} className="paramrow"><span>{label}</span><span className="optrow">
                      <button className={motion[k] ? 'on' : ''} onClick={() => setCfg({ motion: { ...motion, [k]: true } })}>on</button>
                      <button className={!motion[k] ? 'on' : ''} onClick={() => setCfg({ motion: { ...motion, [k]: false } })}>off</button>
                    </span></div>
                  ))}
                </>)}
                {setDomain === 5 && (<>
                  <p className="label">daemons & local endpoints</p>
                  <p className="label">native bridge <span className="n">{bridgeStatus}</span></p>
                  <div className="setgrid">
                    <label>bridge url (optional sidecar)<input className="setinput" placeholder="http://127.0.0.1:17861" value={config.bridgeUrl} onChange={(e) => setCfg({ bridgeUrl: e.target.value })} /></label>
                  </div>
                  <div style={{ marginBottom: 22 }}>
                    <button className="ghostbtn" onClick={async () => setBridgeStatus((await bridgeHealthy(config.bridgeUrl)) ? 'reachable' : 'unreachable')}>ping bridge</button>
                    <span className="dim" style={{ fontWeight: 300, marginLeft: 22 }}>per-platform sidecar speaking BRIDGE.md — local claude/codex wire in later with zero UI changes</span>
                  </div>
                  <p className="label">endpoints</p>
                  <p className="prose">:9379 model-serving workers · <span className="accent">active</span></p>
                  <p className="prose">litert-lm local · {localStatus.state}</p>
                  <p className="prose">native bridge · {config.bridgeUrl || 'not configured'} · {bridgeStatus}</p>
                </>)}
              </div>
              <div data-col="3" data-payload>
                <p className="label">live quota & policy telemetry</p>
                <p className="label">active compute velocity</p>
                <div style={{ display: 'flex', gap: 44, alignItems: 'baseline' }}>
                  <span><span className="bignum">{tokVelocity}</span><span className="dim"> tokens / sec</span></span>
                  <span><span className="bignum">194ms</span><span className="dim"> p99 dispatch</span></span>
                </div>
                <p className="label" style={{ marginTop: 26 }}>pool saturation <span className="n">{agents.length} / {config.maxParallel ?? 10} active</span></p>
                <div className="progress"><i style={{ width: `${Math.min(100, (agents.length / (config.maxParallel ?? 10)) * 100)}%` }} /></div>
                <p className="dim" style={{ fontWeight: 300 }}>{fleetCounts.running} running · {fleetCounts.verified} verified · {fleetCounts.blocked} blocked · {fleetCounts.queued} queued</p>
                <p className="label" style={{ marginTop: 26 }}>tile escalation preview <span className="n">live</span></p>
                <div className="tilegrid preview">
                  <div className="tile tile-testing"><span className="tileface">
                    <span className="tiletop"><span>:fragments.auth</span><span>14m</span></span>
                    <span className="tilebig">12 / 14</span><span className="tilesub">nominal running · muted</span>
                    <span className="tiletitle">stays dark while tests pass</span>
                    <span className="tileprog"><i style={{ width: '72%' }} /></span>
                  </span></div>
                  {(tilePolicy.onFail || tilePolicy.onAmbiguity || tilePolicy.onBigDiff)
                    ? <div className="tile tile-blocked"><span className="tileface">
                        <span className="tiletop"><span>human interrupt</span><span>now</span></span>
                        <span className="tilebig">FAIL :142</span><span className="tilesub">solid accent + [y]/[n] bound</span>
                        <span className="tiletitle">fires when a YES rule triggers</span>
                        <span className="tileprog"><i style={{ width: '100%' }} /></span>
                      </span></div>
                    : <p className="dim" style={{ fontWeight: 300 }}>all escalation rules off — interrupts stay muted. the fleet will not tap your shoulder.</p>}
                </div>
                <p className="label" style={{ marginTop: 26 }}>interrupt threshold policy</p>
                <p className="prose dim">escalate only on: AST contract invariant failure · unresolved merge conflict · sandbox / network egress violation{tilePolicy.onBigDiff ? ` · diff > ${tilePolicy.bigDiffLines} lines` : ''}.</p>
                <p className="label" style={{ marginTop: 26 }}>storage & index footprint</p>
                <p className="prose">{folders.length} modules indexed · {facetCounts.all} turns cached · {seedEpochs.length} epochs</p>
                <p className="prose dim">sessions + engine config in localStorage · model browser-cached after first pull</p>
                <p className="label" style={{ marginTop: 26 }}>about</p>
                <p className="prose dim">zune code — the agentic coding desktop rebuilt in pre-Windows-8 desktop Metro. No sidebar. Type is the chrome.</p>
              </div>
            </div>
          </section>
        </div>

        {/* 3 · semantic zoom map */}
        {zoom === 0 && (
          <div className="zoommap" role="dialog" aria-label="semantic zoom map">
            <p className="huge">fragments</p>
            <p className="dim" style={{ fontWeight: 300 }}>{coarse ? 'Z0 · macro fleet map · tap a block to land in it · pinch out to step back in' : 'Z0 · macro fleet map · home-row badge or click lands in the block · ctrl + = steps in'}</p>
            <div className="mapgrid">
              <button className={`mapblock ${gateOpen ? 'blocked' : 'live'} w2 h2 tiltcard`} {...tiltSpot} data-badge="a" data-cursor="zoom-map:board" onClick={() => openThread('board')}><span className="mapbadge">a</span><span className="t">board of directors</span><small>{gateOpen ? '1 BLOCKED GATE · FAIL :142' : 'conversation · 1 subagent running'} · {facetCounts.all} turns · {seedEpochs.length} epochs</small></button>
              <button className="mapblock w2 tiltcard" {...tiltSpot} data-badge="s" data-cursor="zoom-map:auth" onClick={() => openFile(files[0])}><span className="mapbadge">s</span><span className="t">fragments.auth</span><small>{files.filter((f) => f.folder === 'fragments.auth').length} files · jwt + vault</small></button>
              <button className="mapblock tiltcard" {...tiltSpot} data-badge="d" data-cursor="zoom-map:review" onClick={() => { setZoom(1); goPivot(PIVOTS.indexOf('review')) }}><span className="mapbadge">d</span><span className="t">review</span><small>{unreviewed} hunks unreviewed</small></button>
              <button className="mapblock tiltcard" {...tiltSpot} data-badge="f" data-cursor="zoom-map:docs" onClick={() => openFile(files[5])}><span className="mapbadge">f</span><span className="t">docs</span><small>test infra · 29 suites</small></button>
              <button className="mapblock tiltcard" {...tiltSpot} data-badge="g" data-cursor="zoom-map:agents" onClick={() => { setZoom(1); goPivot(PIVOTS.indexOf('agents')) }}><span className="mapbadge">g</span><span className="t">agents</span><small>{agents.length} subagents · {fleetCounts.running} running · {fleetCounts.blocked} blocked</small></button>
              <button className="mapblock tiltcard" {...tiltSpot} data-badge="w" data-cursor="zoom-map:terminal" onClick={() => { setZoom(1); goPivot(PIVOTS.indexOf('terminal')) }}><span className="mapbadge">w</span><span className="t">terminal</span><small>jvmTest green</small></button>
              <button className="mapblock w2 tiltcard" {...tiltSpot} data-badge="e" data-cursor="zoom-map:siem" onClick={() => openThread('siem')}><span className="mapbadge">e</span><span className="t">siem workbench</span><small>conversation · review ready</small></button>
              <button className="mapblock tiltcard" {...tiltSpot} data-badge="r" data-cursor="zoom-map:ui" onClick={() => openFile(files[2])}><span className="mapbadge">r</span><span className="t">ui</span><small>macos chrome · compose</small></button>
              <button className="mapblock tiltcard" {...tiltSpot} data-badge="t" data-cursor="zoom-map:e2e" onClick={() => openThread('e2e')}><span className="mapbadge">t</span><span className="t">e2e demo</span><small>complete · 6d</small></button>
            </div>
          </div>
        )}
        {/* z · epoch jump grid: the whole multi-day session as one screen of squares */}
        {epochGrid && (
          <div className="zoommap epochgrid" role="dialog" aria-label="epoch jump grid">
            <p className="huge">epochs · board of directors</p>
            <p className="dim" style={{ fontWeight: 300 }}>{facetCounts.all} turns across {seedEpochs.length} epochs · click a square to teleport · esc closes · never scroll two days of history</p>
            <div className="mapgrid epochcells">
              {seedEpochs.map((ep, i) => (
                <button key={ep.n} className={`mapblock tiltcard ${ep.n === activeEpoch.n ? 'live' : ''} ${i === seedEpochs.length - 1 ? 'w2' : ''}`} {...tiltSpot} data-cursor={`conv-epoch:${ep.n}`} onClick={() => jumpToEpoch(ep)}>
                  <span className="t">[{String(ep.n).padStart(2, '0')}] {ep.name.toLowerCase()}</span>
                  <small>{ep.when} · {ep.turns} turns{ep.n === activeEpoch.n ? ' · you are here' : ''}</small>
                  <small className="epochsummary">{ep.summary}</small>
                </button>
              ))}
            </div>
            <button className="ghostbtn" style={{ marginTop: 22 }} onClick={() => setEpochGrid(false)}>close · esc</button>
          </div>
        )}
      </div>

      {/* global fleet heartbeat: 2px segmented strip — the whole fleet's state ratio, no transport controls */}
      <div className="fleetstrip" role="img" aria-label={`fleet: ${fleetSegs.map((s) => `${s.n} ${s.k}`).join(', ')}`} title={fleetSegs.map((s) => `${s.n} ${s.k}`).join(' · ')}>
        {fleetSegs.filter((s) => s.n > 0).map((s) => <i key={s.k} style={{ width: `${(s.n / fleetTotal) * 100}%`, background: s.c }} />)}
      </div>
      {/* contextual baseline: 32px of type, lit only by what the cursor rests on. no bar, no line, no transport. */}
      <footer className={cursorId ? 'actionstrip lit' : 'actionstrip'}>
        <span className="striplabel">{jumpHint !== null ? `jump: ${jumpHint}▌` : stripLabel}</span>
        {stripActions.map(([k, label]) => (
          <button key={k + label} className="stripaction" onClick={() => runStripAction(k)}>{coarse ? label : <><b>[{k}]</b> {label}</>}</button>
        ))}
        <span className="spacer" style={{ flex: 1 }} />
        <span className="stripaction faint stripmodel">{tokVelocity} tok/s · {engineSummary}</span>
      </footer>
    </div>
  )
}
