import { memo, useMemo } from 'react'
import { PIVOTS, files, seedEpochs, seedGate, seedInvariants } from '../data.js'
import { segmentGroundedText, cleanDisplayText, deriveSessionConcepts } from '../derive.js'

/* GroundedText: renders text with character-offset-grounded LangExtract spans
   ([start, end) offsets for files, file:line hunks, code symbols, decisions, metrics). */
function GroundedText({ text, workspace, activeHotWord, onSpanClick }) {
  if (!text) return null
  const segments = segmentGroundedText(text, workspace)
  return (
    <>
      {segments.map((seg, idx) => {
        if (!seg.span) return <span key={idx}>{seg.text}</span>
        const s = seg.span
        const isHot = activeHotWord && s.key === activeHotWord
        const isWorkspaceLink = s.target?.type === 'hunk' || s.target?.type === 'file'
        const cls = `gspan g-${s.cls}${isHot ? ' grounded-active' : ''}${isWorkspaceLink ? ' g-link' : ''}`
        const title = s.target?.type === 'hunk'
          ? `jump to review diff · ${s.target.file}:${s.target.line || ''}`
          : s.target?.type === 'file'
            ? `open in collection · ${s.target.file}`
            : `filter concept · ${s.label} [${s.start}..${s.end})`
        return (
          <span
            key={idx}
            className={cls}
            data-span-cls={s.cls}
            data-span-key={s.key}
            data-span-range={`${s.start}:${s.end}`}
            title={title}
            onClick={onSpanClick ? (e) => { e.stopPropagation(); onSpanClick(s) } : undefined}
          >
            {seg.text}
          </span>
        )
      })}
    </>
  )
}

/* Composer affix hints: the command registry under a "/ …" draft, and the
   resolved references under an "@name" mention. */
function ComposerHints({ cmdMode, cmdHits, runCommand, mentions }) {
  if (!cmdMode && !mentions.length) return null
  return (
    <>
      {cmdMode && (
        <div className="cmdpalette" role="listbox" aria-label="commands">
          {cmdHits.length === 0 && <p className="faint" style={{ margin: 0 }}>no matching command</p>}
          {cmdHits.map((c, i) => (
            <button key={c.id} role="option" aria-selected={i === 0} className={i === 0 ? 'cmdrow on' : 'cmdrow'} onClick={() => runCommand(c)}>
              <span className="faint">{c.group} · </span>{c.label}
            </button>
          ))}
        </div>
      )}
      {mentions.length > 0 && (
        <p className="dim" style={{ marginTop: 8, fontWeight: 300 }}>
          referencing {mentions.map((m) => `${m.kind}:${m.name}`).join(' · ')}
        </p>
      )}
    </>
  )
}

/* Persistent 3-Column Zune Workbench:
   The 3-column page layout (Col 1: Sessions, Files & Prompts | Col 2: Session History | Col 3: Live Diff & Inspector)
   NEVER changes when zooming. Holding Ctrl+Scroll (or Ctrl+Shift+Scroll) strictly changes the semantic resolution
   inside Column 2 across 4 stops:
     - Z3 (All the way in): Full verbatim message & tool stream
     - Z2 (1 notch out): 1-line-per-turn semantic ledger (prompts, decisions, mutations, steps)
     - Z1 (2 notches out): Chronological Epoch Chapters (human prompts + outcomes per chapter)
     - Z0 (Ctrl+Shift+Scroll out / top): Concepts & Decisions Throughout History */
function ConversationPage({
  active, zoom, focusTick, thread, threadId, turns,
  selectedTurn, setSelectedTurn, activeTurn, promptTurns, decisionTurns, activeEpoch, epochCounts,
  derivedEpochs, hotWords, hotWordFilter, visibleFacetTurns, workspaceCtx,
  sessionChangeSet, sessionHunks, facet, facetTurns, splitTurn, promptOpen, engineSummary, draft, setDraft,
  promptRef, gateOpen, gateResolved, reviewFileObj, activeHunk, selectedHunk = 0, setSelectedHunk,
  config,
  cmdMode, cmdHits, runCommand, mentions,
  sessionSignatures = [], activeSignature = null,
  z3InlineFold = 'z2-older', setZ3InlineFold,
  actions,
}) {
  const epochs = derivedEpochs || seedEpochs
  const streamTurns = visibleFacetTurns || facetTurns
  const compressOlder = (config?.epochs?.compressZ2 ?? true) && !hotWordFilter && z3InlineFold !== 'expanded'
  const hasWorkspaceDiff = Boolean(
    sessionChangeSet?.files?.length
      && (sessionChangeSet.task?.toLowerCase().includes(thread?.title?.split(' ')[0]?.toLowerCase() || '')
        || threadId === 'board'
        || threadId === 'siem'
        || threadId === 'auth'),
  )
  const wbFileObj = sessionChangeSet?.files?.find((f) => f.name === reviewFileObj?.name) || sessionChangeSet?.files?.[0] || reviewFileObj
  const wbHunk = wbFileObj?.hunks?.[Math.min(selectedHunk, Math.max(0, (wbFileObj?.hunks?.length || 1) - 1))] || activeHunk

  // Derive Z0 Concepts Throughout History for the active session
  const conceptData = useMemo(
    () => deriveSessionConcepts(turns, epochs, workspaceCtx),
    [turns, epochs, workspaceCtx],
  )
  const rawLinesFmt = conceptData.rawLineEstimate >= 1000
    ? `~${(conceptData.rawLineEstimate / 1000).toFixed(1).replace(/\.0$/, '')}k lines`
    : `${conceptData.rawLineEstimate} lines`

  // In Z3, keep the active epoch at the top of the viewport so the user never lands
  // buried under 190 older turns; earlier epochs sit cleanly below in a compact Z2 ledger.
  const baseActiveTurns = compressOlder && epochs.length > 1
    ? streamTurns.filter((t) => !t.epoch || t.epoch === activeEpoch.n || t.i === selectedTurn || t.i === splitTurn)
    : streamTurns
  const activeStreamTurns = !hotWordFilter && z3InlineFold === 'human-decisions'
    ? streamTurns.filter((t) => t.actor === 'user' || t.kind === 'prompt' || t.kind === 'decision' || Boolean(t.decision) || t.i === selectedTurn)
    : baseActiveTurns
  const olderCompressedTurns = compressOlder && epochs.length > 1 && z3InlineFold !== 'human-decisions'
    ? streamTurns.filter((t) => t.epoch && t.epoch !== activeEpoch.n && t.i !== selectedTurn && t.i !== splitTurn)
    : []

  const zoomMeta = [
    { z: 3, tag: 'Z3 · FULL STREAM', desc: `${turns.length} turns · ${rawLinesFmt} · verbatim messages & tool traces` },
    { z: 2, tag: 'Z2 · TURN LEDGER', desc: `${turns.length} turns → 1-line semantic rows · decisions & mutations ledger` },
    { z: 1, tag: 'Z1 · EPOCH CHAPTERS', desc: `${turns.length} turns → ${epochs.length} chapters · prompts & outcomes per phase` },
    { z: 0, tag: 'Z0 · CONCEPTS IN HISTORY', desc: `${turns.length} turns → ${conceptData.concepts.length} core concepts & ${decisionTurns.length} decisions across history` },
  ]
  const currentZoomMeta = zoomMeta.find((m) => m.z === zoom) || zoomMeta[0]

  return (
    <section className={active ? 'page isactive' : 'page'} aria-label="conversation">
      <div key={focusTick} className="focusenter">
        {/* Top Epoch & Concept Ribbon — stays stationary across all 4 zoom levels */}
        <div className="epochstrip" aria-label="epochs">
          {activeSignature?.landmark && (
            <span className="z3landmark" data-testid="z3-active-landmark">
              ⚑ {activeSignature.landmark} · {activeSignature.age}
            </span>
          )}
          <span className="label" style={{ margin: 0 }}>epochs [z]:</span>
          {epochs.map((ep) => (
            <button
              key={ep.n}
              className={ep.n === activeEpoch.n ? 'epochchip on' : 'epochchip'}
              data-cursor={`conv-epoch:${ep.n}`}
              onClick={() => actions.jumpToEpoch(ep)}
            >
              {ep.n === activeEpoch.n ? '■ ' : ''}[E{String(ep.n).padStart(2, '0')} {ep.name}]
            </button>
          ))}
          <button className="ghostbtn" style={{ flex: 'none' }} onClick={() => actions.setEpochGrid(true)}>jump grid</button>
          {zoom === 3 && epochs.length > 1 && (
            <button
              className="ghostbtn"
              style={{ flex: 'none' }}
              data-cursor="conv-epoch-compress:toggle"
              onClick={() => {
                if (setZ3InlineFold) setZ3InlineFold('z2-older')
                actions.setCfg({ epochs: { onCommit: true, everyTurns: 15, ...(config?.epochs || {}), compressZ2: !(config?.epochs?.compressZ2 ?? true) } })
              }}
            >
              {(config?.epochs?.compressZ2 ?? true) ? 'older: Z2 ledger' : 'older: expanded'}
            </button>
          )}
        </div>

        {(hotWords || []).length > 0 && (
          <div className="hotwordstrip" role="toolbar" aria-label="extracted hot words">
            <span className="label" style={{ margin: 0 }}>concepts:</span>
            {hotWords.map((hw) => (
              <button
                key={hw.key}
                className={`hwchip hw-${hw.cls}${hotWordFilter === hw.key ? ' on' : ''}`}
                data-cursor={`conv-hw:${hw.key}`}
                onClick={() => actions.setHotWordFilter(hotWordFilter === hw.key ? null : hw.key)}
                title={`${hw.cls} · ${hw.count} turn${hw.count === 1 ? '' : 's'}`}
              >
                {hw.label}<sup>{hw.count}</sup>
              </button>
            ))}
            {hotWordFilter && (
              <button className="ghostbtn hwclear" onClick={() => actions.setHotWordFilter(null)}>
                clear [{hotWordFilter}] · esc
              </button>
            )}
          </div>
        )}

        {/* Persistent 3-Column Grid: Col 1 and Col 3 never move when zooming Z3 <-> Z2 <-> Z1 <-> Z0 */}
        <div className={splitTurn !== null ? 'z3grid split' : 'z3grid workbench3'} data-testid="z3-workbench-grid">
          {/* ============ COLUMN 1: SESSIONS, FILES IN SESSION & YOUR HUMAN PROMPTS (FIXED) ============ */}
          {splitTurn === null && (
            <div className="wbcol1" data-wb-col="1" aria-label="session scope, files and human prompts">
              <p className="label">
                sessions <span className="n">{sessionSignatures.length} threads</span>
              </p>
              <div className="wbsessionlist">
                {sessionSignatures.map((sig) => (
                  <button
                    key={sig.id}
                    className={sig.id === threadId ? 'wbrow sel' : 'wbrow'}
                    data-cursor={`conv-thread:${sig.id}`}
                    data-testid={`wb-session-${sig.id}`}
                    onClick={() => {
                      actions.setThreadId(sig.id)
                      actions.setThreads((ts) => ts.map((x) => (x.id === sig.id ? { ...x, unread: 0 } : x)))
                      actions.setSelectedTurn(0)
                    }}
                  >
                    <span className="wbrowtitle">{sig.title}</span>
                    <span className="wbrowmeta">
                      {sig.turnsCount}t · ⚑ {sig.landmark} · {sig.age}
                    </span>
                  </button>
                ))}
              </div>

              {hasWorkspaceDiff && sessionChangeSet?.files?.length > 0 && (
                <div style={{ marginTop: 16 }}>
                  <p className="label">
                    files in session <span className="n">{sessionChangeSet.files.length}</span>
                  </p>
                  {sessionChangeSet.files.map((f) => {
                    const isSel = wbFileObj?.name === f.name
                    return (
                      <button
                        key={f.name}
                        className={isSel ? 'wbrow sel' : 'wbrow'}
                        data-testid={`wb-file-${f.name}`}
                        onClick={() => {
                          actions.setReviewSetId(sessionChangeSet.id)
                          actions.setReviewFile(f.name)
                          if (setSelectedHunk) setSelectedHunk(0)
                        }}
                      >
                        <span className="wbrowtitle">{f.name}</span>
                        <span className="wbrowmeta">
                          <span style={{ color: 'var(--add)' }}>+{f.adds}</span>
                          {' / '}
                          <span style={{ color: 'var(--del)' }}>−{f.dels}</span>
                          {' · '}
                          {f.hunks.length} hunk{f.hunks.length === 1 ? '' : 's'}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}

              <div style={{ marginTop: 16 }}>
                <p className="label">
                  your human prompts <span className="n">{promptTurns.length}</span>
                </p>
                {promptTurns.slice(0, 12).map((pt) => (
                  <button
                    key={pt.i}
                    className={pt.i === selectedTurn ? 'wbrow sel' : 'wbrow'}
                    data-testid={`wb-prompt-${pt.i}`}
                    onClick={() => {
                      setSelectedTurn(pt.i)
                      if (pt.epoch) {
                        const ep = epochs.find((e) => e.n === pt.epoch)
                        if (ep) actions.jumpToEpoch(ep)
                      }
                    }}
                  >
                    <span className="wbrowtitle">
                      <span className="turnnum">{String(pt.i + 1).padStart(2, '0')}</span>
                      “{cleanDisplayText(pt.intent || pt.full || pt.summary).slice(0, 68)}”
                    </span>
                    <span className="wbrowmeta">E{String(pt.epoch || 1).padStart(2, '0')} · {pt.age}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ============ COLUMN 2: IN-PLACE SEMANTIC ZOOM FOR 100K-LINE SESSION HISTORY ============ */}
          <div className="wbcol2" data-wb-col="2" data-testid="col2-history-view" data-zoom-level={zoom}>
            {/* Sticky In-Column Semantic Zoom Controller */}
            <div className="col2zoombox" role="region" aria-label="session history zoom level">
              <div className="col2zoomstops">
                {zoomMeta.map((zm) => (
                  <button
                    key={zm.z}
                    className={zoom === zm.z ? 'col2zbtn on' : 'col2zbtn'}
                    data-testid={`col2-zoom-${zm.z}`}
                    onClick={() => actions.setZoom(zm.z)}
                  >
                    {zoom === zm.z ? `■ ${zm.tag}` : zm.tag}
                  </button>
                ))}
              </div>
              <div className="col2zoommeta">
                <span>{currentZoomMeta.desc}</span>
                <span className="faint">ctrl+scroll step zoom · ctrl+shift+scroll Z0 concepts ↔ Z3 stream</span>
              </div>
            </div>

            {/* Z3 inline fold & facet bar */}
            {zoom === 3 && (
              <div className="foldbar" role="toolbar" aria-label="inline semantic turn folding">
                <span className="label" style={{ margin: 0 }}>stream view:</span>
                {[
                  ['z2-older', 'Z3 active + Z2 older'],
                  ['human-decisions', 'prompts & decisions only'],
                  ['expanded', 'all turns expanded'],
                ].map(([mode, label]) => (
                  <button
                    key={mode}
                    className={z3InlineFold === mode ? 'epochchip on' : 'epochchip'}
                    data-testid={`z3-fold-${mode}`}
                    onClick={() => setZ3InlineFold && setZ3InlineFold(mode)}
                  >
                    {z3InlineFold === mode ? '■ ' : ''}{label}
                  </button>
                ))}
              </div>
            )}

            {/* ---------------- LEVEL Z0: CONCEPTS & DECISIONS THROUGHOUT HISTORY ---------------- */}
            {zoom === 0 && (
              <div className="col2z0" data-testid="col2-z0-concepts">
                <p className="label">
                  concepts throughout history · {thread.title} <span className="n">{conceptData.concepts.length} concepts · {rawLinesFmt} distilled</span>
                </p>

                {/* 1. Chronological Era Spine (Kickoff -> Friction -> Verification) */}
                <div className="z0eragrid">
                  {conceptData.eras.map((era) => (
                    <button
                      key={era.id}
                      className="z0eracard"
                      data-testid={`z0-era-${era.id}`}
                      onClick={() => {
                        setSelectedTurn(era.anchorTurnIndex)
                        actions.setZoom(1)
                      }}
                    >
                      <span className="z0eratop">
                        <span>{era.title}</span>
                        <span className="accent">{era.epochRange} · {era.turnsCount}t</span>
                      </span>
                      <span className="z0eraprompt">“{era.headlinePrompt}”</span>
                      {era.headlineDecision && (
                        <span className="z0eradecision">↳ {era.headlineDecision}</span>
                      )}
                      <span className="z0eraconcepts">
                        {era.concepts.map((c) => (
                          <span key={c.key} className="z0erachip">{c.label}<sup>{c.count}</sup></span>
                        ))}
                      </span>
                    </button>
                  ))}
                </div>

                {/* 2. Ranked Concept Constellation with Chronological Heat Strips across E01..E14 */}
                <p className="label" style={{ marginTop: 16 }}>
                  concept frequency & chronological heat across {epochs.length} epochs <span className="n">click concept to filter · click turn to dive to Z3</span>
                </p>
                <div className="z0conceptlist">
                  {conceptData.concepts.map((c) => {
                    const isFiltered = hotWordFilter === c.key
                    return (
                      <div
                        key={c.key}
                        className={`z0conceptrow ${isFiltered ? 'on' : ''}`}
                        data-testid={`concept-card-${String(c.key).toLowerCase()}`}
                        data-concept-key={c.key}
                      >
                        <div className="z0concepthead">
                          <button
                            className="z0concepttitle"
                            onClick={() => {
                              actions.setHotWordFilter(isFiltered ? null : c.key)
                              setSelectedTurn(c.firstTurnIndex)
                              actions.setZoom(3)
                            }}
                          >
                            <span className="z0conceptname">{c.label}</span>
                            <span className="z0conceptcount">{c.count} turns</span>
                            <span className="faint" style={{ fontSize: '.74em' }}>
                              T{String(c.firstTurnIndex + 1).padStart(3, '0')}→T{String(c.lastTurnIndex + 1).padStart(3, '0')}
                            </span>
                            {c.frictionCount > 0 && (
                              <span className="z0conceptfriction">⚡ {c.frictionCount} friction</span>
                            )}
                          </button>
                          <div className="z0conceptjumps">
                            <button
                              className="z0jumpbtn"
                              onClick={() => {
                                setSelectedTurn(c.firstTurnIndex)
                                actions.setZoom(3)
                              }}
                              title="Jump to first turn where this concept appeared"
                            >
                              [T{String(c.firstTurnIndex + 1).padStart(2, '0')} first]
                            </button>
                            {c.struggleTurnIndex !== null && c.struggleTurnIndex !== c.firstTurnIndex && (
                              <button
                                className="z0jumpbtn fail"
                                onClick={() => {
                                  setSelectedTurn(c.struggleTurnIndex)
                                  actions.setZoom(3)
                                }}
                                title="Jump to failure/friction spike for this concept"
                              >
                                [T{String(c.struggleTurnIndex + 1).padStart(2, '0')} ⚡ spike]
                              </button>
                            )}
                            {c.lastTurnIndex !== c.firstTurnIndex && (
                              <button
                                className="z0jumpbtn"
                                onClick={() => {
                                  setSelectedTurn(c.lastTurnIndex)
                                  actions.setZoom(3)
                                }}
                                title="Jump to latest turn for this concept"
                              >
                                [T{String(c.lastTurnIndex + 1).padStart(2, '0')} latest]
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Chronological Concept Heat Strip across E01..E14 */}
                        <div className="conceptheat" role="img" aria-label={`${c.label} presence across ${epochs.length} epochs`}>
                          {c.epochHeat.map((eh) => (
                            <button
                              key={eh.epoch}
                              className={`heatcell heat-${eh.kind}`}
                              title={`E${String(eh.epoch).padStart(2, '0')} ${eh.name}: ${eh.count} turn${eh.count === 1 ? '' : 's'}`}
                              onClick={() => {
                                setSelectedTurn(eh.firstTurnIndex)
                                if (eh.count > 0) actions.setZoom(2)
                              }}
                            />
                          ))}
                        </div>

                        {c.anchorQuote && (
                          <div className="z0conceptquote">
                            <span className="faint">{c.anchorKind === 'decision' ? 'decision · ' : 'prompt · '}</span>
                            “{c.anchorQuote}”
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>

                {/* 3. Architectural Decision Spine across the entire session */}
                {decisionTurns.length > 0 && (
                  <div style={{ marginTop: 18 }}>
                    <p className="label">
                      architectural decision spine throughout history <span className="n">{decisionTurns.length} decisions</span>
                    </p>
                    {decisionTurns.map((dt) => (
                      <button
                        key={dt.i}
                        className={dt.i === selectedTurn ? 'turnrow sel' : 'turnrow'}
                        data-cursor={`conv-turn:${dt.i}`}
                        onClick={() => {
                          setSelectedTurn(dt.i)
                          actions.setZoom(3)
                        }}
                      >
                        <span className="turnhead">
                          <span className="turnnum">{String(dt.i + 1).padStart(2, '0')}</span>
                          {dt.actor} <span className="faint">· E{String(dt.epoch || 1).padStart(2, '0')} · {dt.age}</span>
                        </span>
                        <span className="turnsummary">
                          <GroundedText text={cleanDisplayText(dt.decision || dt.summary)} workspace={workspaceCtx} activeHotWord={hotWordFilter} onSpanClick={actions.onSpanClick} />
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ---------------- LEVEL Z1: CHRONOLOGICAL EPOCH CHAPTERS ---------------- */}
            {zoom === 1 && (
              <div className="col2z1" data-testid="col2-z1-chapters">
                <p className="label">
                  session chapters · {epochs.length} epochs across {turns.length} turns ({rawLinesFmt}) <span className="n">click any chapter to expand into Z2/Z3</span>
                </p>
                {epochs.map((ep) => {
                  const epTurns = turns
                    .map((t, i) => ({ ...t, i }))
                    .filter((t) => (t.epoch || 1) === ep.n)
                  const epPrompts = epTurns.filter((t) => t.actor === 'user' || t.kind === 'prompt')
                  const epDecisions = epTurns.filter((t) => t.kind === 'decision' || Boolean(t.decision))
                  const epMutations = epTurns.filter((t) => t.kind === 'mutation')
                  const isActiveEp = ep.n === activeEpoch.n
                  const firstIdx = epTurns[0]?.i ?? ep.anchor ?? 0
                  const lastIdx = epTurns[epTurns.length - 1]?.i ?? firstIdx
                  return (
                    <div
                      key={ep.n}
                      className={`z1chapter ${isActiveEp ? 'on' : ''}`}
                      data-testid={`z1-chapter-${ep.n}`}
                    >
                      <div className="z1chaphead">
                        <button
                          className="z1chaptitle"
                          data-cursor={`conv-epoch:${ep.n}`}
                          onClick={() => {
                            actions.jumpToEpoch(ep)
                            actions.setZoom(2)
                          }}
                        >
                          <span className="accent">[E{String(ep.n).padStart(2, '0')}]</span>{' '}
                          <b>{ep.name}</b>{' '}
                          <span className="faint">
                            · Turns {String(firstIdx + 1).padStart(2, '0')}–{String(lastIdx + 1).padStart(2, '0')} ({epTurns.length}t · {ep.when})
                          </span>
                        </button>
                        <button
                          className="z0jumpbtn"
                          onClick={() => {
                            actions.jumpToEpoch(ep)
                            actions.setZoom(3)
                          }}
                        >
                          [dive Z3 →]
                        </button>
                      </div>
                      <p className="z1chapsummary">{ep.summary}</p>
                      {epPrompts.length > 0 && (
                        <div className="z1chapprompts">
                          {epPrompts.slice(0, 2).map((pt) => (
                            <button
                              key={pt.i}
                              className="z1promptrow"
                              data-cursor={`conv-turn:${pt.i}`}
                              onClick={() => {
                                setSelectedTurn(pt.i)
                                actions.setZoom(3)
                              }}
                            >
                              <span className="turnnum">{String(pt.i + 1).padStart(2, '0')}</span>
                              <span className="faint">YOU · </span>
                              “{cleanDisplayText(pt.intent || pt.full || pt.summary).slice(0, 96)}”
                            </button>
                          ))}
                        </div>
                      )}
                      {epDecisions.length > 0 && (
                        <div className="z1chapdecisions">
                          {epDecisions.slice(0, 2).map((dt) => (
                            <button
                              key={dt.i}
                              className="z1decrow"
                              data-cursor={`conv-turn:${dt.i}`}
                              onClick={() => {
                                setSelectedTurn(dt.i)
                                actions.setZoom(3)
                              }}
                            >
                              <span className="turnnum">{String(dt.i + 1).padStart(2, '0')}</span>
                              <span className="accent">DECISION · </span>
                              {cleanDisplayText(dt.decision || dt.summary).slice(0, 96)}
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="z1chapfoot">
                        {(ep.hotWords || []).map((hw) => (
                          <button
                            key={hw.key}
                            className="ephw"
                            onClick={() => {
                              actions.setHotWordFilter(hw.key)
                              actions.setZoom(3)
                            }}
                          >
                            {hw.label}<sup>{hw.count}</sup>
                          </button>
                        ))}
                        {epMutations.length > 0 && (
                          <span className="faint" style={{ fontSize: '.68em', marginLeft: 'auto' }}>
                            {epMutations.length} mutation{epMutations.length === 1 ? '' : 's'}
                          </span>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            {/* ---------------- LEVEL Z2: 1-LINE DECISIONS & MUTATIONS LEDGER ---------------- */}
            {zoom === 2 && (
              <div className="col2z2" data-testid="col2-z2-ledger">
                <div className="foldbar" role="toolbar" aria-label="Z2 ledger filter">
                  <span className="label" style={{ margin: 0 }}>decisions & mutations ledger:</span>
                  {[
                    ['all', `all (${turns.length})`],
                    ['prompts', `my prompts (${promptTurns.length})`],
                    ['decisions', `decisions (${decisionTurns.length})`],
                    ['mutations', `mutations (${sessionHunks.length})`],
                    ['pty', `pty (${turns.filter((t) => (t.stdout || []).length > 0).length})`],
                  ].map(([k, label]) => (
                    <button
                      key={k}
                      className={facet === k ? 'epochchip on' : 'epochchip'}
                      onClick={() => actions.setFacet(k)}
                    >
                      {facet === k ? '■ ' : ''}{label}
                    </button>
                  ))}
                </div>
                {streamTurns.map((t, fi) => {
                  const epObj = epochs.find((e) => e.n === t.epoch) || {}
                  const badgeKind = t.actor === 'user' || t.kind === 'prompt'
                    ? 'YOU'
                    : t.kind === 'decision' || t.decision
                      ? 'DECISION'
                      : t.kind === 'mutation'
                        ? 'MUTATION'
                        : 'STEP'
                  return (
                    <div key={t.i} data-col={t.actor === 'user' || t.kind === 'prompt' ? '1' : (t.kind === 'decision' || t.decision) ? '2' : '3'}>
                      {(fi === 0 || streamTurns[fi - 1].epoch !== t.epoch) && t.epoch && (
                        <button className="milestone" onClick={() => actions.jumpToEpoch(epObj)}>
                          [ E{String(t.epoch).padStart(2, '0')} · {epObj.name || 'SESSION'} · {epochCounts.get(t.epoch) || ''} turns ]
                        </button>
                      )}
                      <button
                        className={t.i === selectedTurn ? 'turnrow z2ledgerrow sel' : 'turnrow z2ledgerrow'}
                        data-cursor={`conv-turn:${t.i}`}
                        onClick={() => setSelectedTurn(t.i)}
                        onDoubleClick={() => actions.setZoom(3)}
                      >
                        <span className="turnnum">{String(t.i + 1).padStart(2, '0')}</span>
                        <span className={`z2kind z2-${badgeKind.toLowerCase()}`}>{badgeKind}</span>
                        <span className="faint" style={{ marginRight: 6 }}>{t.actor === 'user' ? 'you' : t.actor} ·</span>
                        <span className="turnsummary" style={{ display: 'inline' }}>
                          <GroundedText
                            text={cleanDisplayText(t.decision || t.intent || t.summary || t.synthesis)}
                            workspace={workspaceCtx}
                            activeHotWord={hotWordFilter}
                            onSpanClick={actions.onSpanClick}
                          />
                        </span>
                      </button>
                    </div>
                  )
                })}
              </div>
            )}

            {/* ---------------- LEVEL Z3: FULL VERBATIM MESSAGE & TOOL STREAM ---------------- */}
            {zoom === 3 && (
              <div className="col2z3" data-testid="col2-z3-stream">
                <p className="label" style={{ marginTop: 8 }}>
                  {hotWordFilter
                    ? `filtered by concept · "${hotWordFilter}" (${streamTurns.length}/${facetTurns.length} turns)`
                    : z3InlineFold === 'human-decisions'
                      ? `human voice & decisions only · robot filler muted (${activeStreamTurns.length}/${turns.length} turns)`
                      : facet === 'all'
                        ? `active stream · epoch ${String(activeEpoch.n).padStart(2, '0')} (${activeEpoch.name.toLowerCase()})`
                        : `facet · ${facet}`} <span className="n">{thread.title}</span>
                </p>
                {activeStreamTurns.map((t, fi) => {
                  const epObj = epochs.find((e) => e.n === t.epoch) || {}
                  return (
                    <div key={t.i}>
                      {(fi === 0 || activeStreamTurns[fi - 1].epoch !== t.epoch) && t.epoch && (
                        <button className="milestone" onClick={() => actions.setEpochGrid(true)}>
                          [ E{String(t.epoch).padStart(2, '0')} · {epObj.name || 'SESSION'} · {epochCounts.get(t.epoch) || ''} turns ]
                        </button>
                      )}
                      <button
                        className={t.i === selectedTurn ? 'streamturn sel' : 'streamturn'}
                        data-cursor={`conv-turn:${t.i}`}
                        onClick={() => setSelectedTurn(t.i)}
                      >
                        <span className="streamhead">
                          {t.actor === 'user' ? 'YOU' : t.actor}{' '}
                          <span className="faint">[{t.kind ? t.kind.toUpperCase() : 'TURN'} #{String(t.i + 1).padStart(2, '0')} · {t.age}]</span>
                          {splitTurn === t.i && <span className="accent"> · pinned (v)</span>}
                        </span>
                        <span className="prose" style={{ display: 'block' }}>
                          <GroundedText text={t.full || t.synthesis} workspace={workspaceCtx} activeHotWord={hotWordFilter} onSpanClick={actions.onSpanClick} />
                        </span>
                        {(t.stdout || []).length > 0 && (
                          <span className="stdout mono" style={{ display: 'block' }}>
                            {t.stdout.map((l, li) => <span key={li} style={{ display: 'block' }}>{l}</span>)}
                          </span>
                        )}
                        {t.state === 'running' && (
                          <span className="progress thin compact" style={{ display: 'block' }}>
                            <i style={{ width: `${t.progress || 0}%` }} />
                          </span>
                        )}
                      </button>
                    </div>
                  )
                })}
                {streamTurns.length === 0 && (
                  <p className="faint" style={{ fontWeight: 300 }}>
                    nothing in this facet{hotWordFilter ? ` matching "${hotWordFilter}"` : ''} yet
                  </p>
                )}
                {threadId === seedGate.threadId && (facet === 'all' || facet === 'decisions') && (
                  <div className={`gateblock ${gateOpen ? 'open' : 'resolved'}`} data-cursor="conv-gate:board" role="group" aria-label="interrupt gate">
                    <p className="label" style={{ margin: 0 }}>interrupt gate [{seedGate.by} · {seedGate.kind}]</p>
                    <p className="prose" style={{ margin: '8px 0' }}>{seedGate.text}</p>
                    <p className="prose accent" style={{ margin: '4px 0' }}>? {seedGate.question}</p>
                    {gateOpen
                      ? (
                        <span className="tileyn">
                          <button onClick={() => actions.resolveGate('yes')}>[y] {seedGate.yes}</button>
                          <button onClick={() => actions.resolveGate('no')}>[n] {seedGate.no}</button>
                          <button onClick={() => actions.setPromptOpen(true)}>[c] custom</button>
                        </span>
                      )
                      : <p className="prose dim">resolved · {gateResolved === 'yes' ? seedGate.yes : seedGate.no} — verifier rerunning</p>}
                  </div>
                )}

                {olderCompressedTurns.length > 0 && (
                  <div style={{ marginTop: 24 }}>
                    <p className="label">
                      earlier epochs · Z2 ledger <span className="n">{olderCompressedTurns.length} compressed turns · ctrl+scroll out for full Z2/Z1/Z0</span>
                    </p>
                    {olderCompressedTurns.map((t, fi) => {
                      const epObj = epochs.find((e) => e.n === t.epoch) || {}
                      return (
                        <div key={t.i}>
                          {(fi === 0 || olderCompressedTurns[fi - 1].epoch !== t.epoch) && t.epoch && (
                            <button className="milestone" onClick={() => actions.jumpToEpoch(epObj)}>
                              [ E{String(t.epoch).padStart(2, '0')} · {epObj.name || 'SESSION'} · {epochCounts.get(t.epoch) || ''} turns ]
                            </button>
                          )}
                          <button className="streamturn compressed" data-cursor={`conv-turn:${t.i}`} onClick={() => setSelectedTurn(t.i)}>
                            <span className="turnnum">{String(t.i + 1).padStart(2, '0')}</span>
                            <span className="faint">{t.actor === 'user' ? 'you' : t.actor} · </span>
                            <span className="turnsummary">
                              <GroundedText text={cleanDisplayText(t.decision || t.summary)} workspace={workspaceCtx} activeHotWord={hotWordFilter} onSpanClick={actions.onSpanClick} />
                            </span>
                          </button>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Always-ready Composer at the bottom of Column 2 across all zoom levels */}
            <div className="wbcomposer">
              <p className="label" style={{ marginTop: 14 }}>
                talk to robot · {engineSummary} <span className="n">enter send · / commands · @ file</span>
              </p>
              <textarea
                ref={promptRef}
                className="inlineprompt"
                data-testid="z3-composer-input"
                rows={2}
                placeholder={`reply in ${thread.title} while inspecting ${wbFileObj?.name || 'context'} on the right…`}
                value={draft}
                onFocus={() => actions.setPromptOpen(true)}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => actions.composerKey(e)}
              />
              <ComposerHints cmdMode={cmdMode} cmdHits={cmdHits} runCommand={runCommand} mentions={mentions} />
              <div style={{ marginTop: 8, display: 'flex', gap: 18, alignItems: 'baseline' }}>
                <button className="solid" data-testid="z3-composer-send" onClick={() => actions.send()}>send prompt</button>
                {!promptOpen && (
                  <button className="promptcue" style={{ padding: 0 }} onClick={() => actions.setPromptOpen(true)}>
                    &gt; _ <span className="faint">[i] focus composer</span>
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* ============ COLUMN 3: LIVE DIFF, HUNK TRIAGE & PINNED TURN CONTEXT (FIXED) ============ */}
          <div className="wbcol3" data-wb-col="3">
            {splitTurn !== null && turns[splitTurn] ? (
              <>
                <p className="label">pinned · turn {String(splitTurn + 1).padStart(2, '0')} <span className="n">v unpin · 50/50 split</span></p>
                <p className="big" style={{ marginBottom: 10 }}>{turns[splitTurn].actor}</p>
                <p className="prose"><GroundedText text={turns[splitTurn].full || turns[splitTurn].synthesis} workspace={workspaceCtx} activeHotWord={hotWordFilter} onSpanClick={actions.onSpanClick} /></p>
                <p className="label" style={{ marginTop: 22 }}>trace</p>
                {(turns[splitTurn].trace || []).map((l, i) => <p key={i} className="prose dim">{l}</p>)}
              </>
            ) : hasWorkspaceDiff && wbFileObj ? (
              <>
                <p className="label">
                  pinned context · live diff <span className="n" data-testid="z3-diff-header">{wbFileObj.name}:{wbHunk?.line}</span>
                </p>
                {sessionChangeSet?.files?.length > 1 && (
                  <div className="wbfiletabs">
                    {sessionChangeSet.files.map((f) => (
                      <button
                        key={f.name}
                        className={f.name === wbFileObj.name ? 'epochchip on' : 'epochchip'}
                        onClick={() => {
                          actions.setReviewSetId(sessionChangeSet.id)
                          actions.setReviewFile(f.name)
                          if (setSelectedHunk) setSelectedHunk(0)
                        }}
                      >
                        {f.name === wbFileObj.name ? '■ ' : ''}{f.name}
                      </button>
                    ))}
                  </div>
                )}
                {wbFileObj.hunks.map((hk, hi) => (
                  <div key={hi} className="wbhunkcard" data-testid={`z3-hunk-${hi}`}>
                    <div className="wbhunkhead">
                      <span><b>{hk.fn}</b> · <span className="faint">{hk.range}</span></span>
                      <span className={`hunkstate state-${hk.state}`} style={{ display: 'inline', margin: 0 }}>{hk.state}</span>
                    </div>
                    <p className="faint" style={{ fontSize: '.82em', margin: '3px 0 8px 0' }}>{hk.rationale}</p>
                    {hk.lines.map(([sign, line], li) => (
                      <div key={li} className={`diffline ${sign === '+' ? 'add' : sign === '-' ? 'del' : ''}`}>{sign} {line}</div>
                    ))}
                    <div className="wbhunkactions">
                      <button
                        className="ghostbtn"
                        data-testid={`z3-approve-hunk-${hi}`}
                        onClick={() => {
                          actions.setReviewSetId(sessionChangeSet.id)
                          actions.setReviewFile(wbFileObj.name)
                          if (setSelectedHunk) setSelectedHunk(hi)
                          setTimeout(() => actions.setHunkState('STAGED'), 0)
                        }}
                      >
                        [a] stage hunk
                      </button>
                      <button
                        className="ghostbtn"
                        onClick={() => {
                          actions.setReviewSetId(sessionChangeSet.id)
                          actions.setReviewFile(wbFileObj.name)
                          if (setSelectedHunk) setSelectedHunk(hi)
                          actions.goPivot(PIVOTS.indexOf('review'))
                        }}
                      >
                        ↗ full review
                      </button>
                    </div>
                  </div>
                ))}
                {threadId === 'board' && (
                  <>
                    <p className="label" style={{ marginTop: 22 }}>contract & invariant gates <span className="n">epoch {String(activeEpoch.n).padStart(2, '0')}</span></p>
                    {seedInvariants.map((g) => (
                      <p key={g.name} className="prose" style={{ margin: '2px 0' }}>
                        <span className={`invstate inv-${g.state}`}>{g.state === 'FAIL' && !gateOpen && gateResolved === 'yes' ? 'RUN' : g.state}</span> {g.name} <span className="faint">({g.detail})</span>
                      </p>
                    ))}
                  </>
                )}
                {activeTurn && (
                  <>
                    <p className="label" style={{ marginTop: 22 }}>selected turn [{String(selectedTurn + 1).padStart(2, '0')}] trace</p>
                    {(activeTurn.trace || []).map((l, i) => <p key={i} className="prose dim">{l}</p>)}
                    {(activeTurn.artifacts || []).length > 0 && (
                      <>
                        <p className="label" style={{ marginTop: 18 }}>emitted artifacts</p>
                        {activeTurn.artifacts.map((a) => (
                          <button key={a} className="artifactlink" data-cursor={`conv-artifact:${a}`} onClick={() => { const f = files.find((x) => x.name === a); if (f) actions.openFile(f) }}>→ {a}</button>
                        ))}
                      </>
                    )}
                  </>
                )}
              </>
            ) : (
              <>
                <p className="label">pinned context · epoch {String(activeEpoch.n).padStart(2, '0')} <span className="n">{activeEpoch.name.toLowerCase()}</span></p>
                <p className="prose dim" style={{ marginBottom: 14 }}>{activeEpoch.summary}</p>
                {activeTurn && (
                  <div className="wbselectedturn" style={{ marginBottom: 18, paddingBottom: 12, borderBottom: '1px solid color-mix(in srgb, var(--fg) 14%, transparent)' }}>
                    <p className="label">selected turn [{String(selectedTurn + 1).padStart(2, '0')}] · {activeTurn.actor}</p>
                    <p className="prose" style={{ fontSize: '.92em' }}>
                      <GroundedText text={cleanDisplayText(activeTurn.full || activeTurn.synthesis || activeTurn.summary)} workspace={workspaceCtx} activeHotWord={hotWordFilter} onSpanClick={actions.onSpanClick} />
                    </p>
                  </div>
                )}
                {(activeEpoch.hotWords || []).length > 0 && (
                  <>
                    <p className="label">epoch concepts</p>
                    <div style={{ display: 'flex', gap: 22, alignItems: 'baseline', flexWrap: 'wrap', marginBottom: 18 }}>
                      {activeEpoch.hotWords.map((hw) => (
                        <button key={hw.key} className="hwchip" onClick={() => actions.setHotWordFilter(hotWordFilter === hw.key ? null : hw.key)}>
                          <span className="bignum">{hw.count}</span><span className="dim"> {hw.label}</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
                <p className="label" style={{ marginTop: 16 }}>extracted session decisions <span className="n">{decisionTurns.length}</span></p>
                {decisionTurns.slice(-5).map((dt) => (
                  <button key={dt.i} className="turnrow" onClick={() => setSelectedTurn(dt.i)}>
                    <span className="turnhead"><span className="turnnum">{String(dt.i + 1).padStart(2, '0')}</span> {dt.actor} <span className="faint">· E{String(dt.epoch || 1).padStart(2, '0')}</span></span>
                    <span className="turnsummary">{cleanDisplayText(dt.decision || dt.summary)}</span>
                  </button>
                ))}
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}

export default memo(ConversationPage)
