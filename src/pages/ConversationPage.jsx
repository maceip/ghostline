import { memo, useState } from 'react'
import { PIVOTS, files, seedEpochs, seedGate, seedInvariants } from '../data.js'
import { segmentGroundedText, cleanDisplayText } from '../derive.js'

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
            : `filter hot word · ${s.label} [${s.start}..${s.end})`
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
        <p className="dim" style={{ marginTop: 6, fontSize: '.85em' }}>
          referencing {mentions.map((m) => `${m.kind}:${m.name}`).join(' · ')}
        </p>
      )}
    </>
  )
}

/* Conversation Workbench: Visual Studio 3-Pane Split Layout
   Left Pane (Col 1): Sessions, Changed Files, & Active Workers
   Center Stage (Col 2): Turn Stream + Persistent Docked Prompt Composer
   Right Inspector (Col 3): Turn Inspector, Live Hunk Diffs, Workspace Files, & PTY */
function ConversationPage({
  active, zoom, focusTick, narrow, convLevel, setConvLevel, thread, threadId, threads, turns,
  selectedTurn, setSelectedTurn, activeTurn, promptTurns, decisionTurns, activeEpoch, epochCounts,
  derivedEpochs, hotWords, hotWordFilter, visibleFacetTurns, workspaceCtx,
  sessionChangeSet, sessionHunks, facet, facetTurns, splitTurn, promptOpen, engineSummary, draft, setDraft,
  promptRef, gateOpen, gateResolved, reviewFileObj, activeHunk, agents, config, localStatus, motion,
  cmdMode, cmdHits, runCommand, mentions, termLines, termInput, setTermInput, startResize, resetPaneWidths, actions,
}) {
  const [inspectorTab, setInspectorTab] = useState('turn') // 'turn' | 'diff' | 'files' | 'pty'
  const [inspectedFileName, setInspectedFileName] = useState(() => reviewFileObj?.name || files[0]?.name)

  const epochs = derivedEpochs || seedEpochs
  const streamTurns = visibleFacetTurns || facetTurns
  const compressOlder = (config?.epochs?.compressZ2 ?? true) && !hotWordFilter
  const hasWorkspaceDiff = threadId === 'board' || threadId === 'siem' || threadId === 'auth'
  const ptyTraceTurns = turns.filter((t) => (t.stdout || []).length > 0 || (t.trace || []).length > 0)
  const inspectedFileObj = files.find((f) => f.name === inspectedFileName) || files[0]

  const activeStreamTurns = compressOlder && epochs.length > 1
    ? streamTurns.filter((t) => !t.epoch || t.epoch === activeEpoch.n || t.i === selectedTurn || t.i === splitTurn)
    : streamTurns
  const olderCompressedTurns = compressOlder && epochs.length > 1
    ? streamTurns.filter((t) => t.epoch && t.epoch !== activeEpoch.n && t.i !== selectedTurn && t.i !== splitTurn)
    : []

  return (
    <section className={active ? 'page isactive' : 'page'} aria-label="conversation">
      <div key={focusTick} className="focusenter">
        {zoom === 2 && activeTurn ? (
          /* Z2 · decisions & mutations ledger: prompts, decisions, and hunks side-by-side */
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
            <p className="label">decisions & mutations ledger · {thread.title} <span className="n">Z2 · enter Z3 · esc Z1</span></p>
            <div className="swiss3" data-cascade style={{ flex: 1 }}>
              <div data-col="1">
                <p className="label">my prompts <span className="n">{promptTurns.length}</span></p>
                {promptTurns.map((t) => (
                  <button key={t.i} className={t.i === selectedTurn ? 'turnrow sel' : 'turnrow'} data-cursor={`conv-turn:${t.i}`} onClick={() => setSelectedTurn(t.i)} onDoubleClick={() => actions.setZoom(3)}>
                    <span className="turnhead"><span className="turnnum">{String(t.i + 1).padStart(2, '0')}</span> you <span className="faint">· E{String(t.epoch || activeEpoch.n).padStart(2, '0')}</span></span>
                    <span className="turnsummary"><GroundedText text={cleanDisplayText(t.intent)} workspace={workspaceCtx} activeHotWord={hotWordFilter} onSpanClick={actions.onSpanClick} /></span>
                  </button>
                ))}
                {promptTurns.length === 0 && <p className="faint pane-pad">no prompts yet</p>}
              </div>
              <div data-col="2">
                <p className="label">decisions <span className="n">{decisionTurns.length}</span></p>
                {decisionTurns.map((t) => (
                  <button key={t.i} className={t.i === selectedTurn ? 'turnrow sel' : 'turnrow'} data-cursor={`conv-turn:${t.i}`} onClick={() => setSelectedTurn(t.i)} onDoubleClick={() => actions.setZoom(3)}>
                    <span className="turnhead"><span className="turnnum">{String(t.i + 1).padStart(2, '0')}</span> {t.actor} <span className="faint">· E{String(t.epoch || activeEpoch.n).padStart(2, '0')}</span></span>
                    <span className="turnsummary"><GroundedText text={cleanDisplayText(t.decision || t.summary)} workspace={workspaceCtx} activeHotWord={hotWordFilter} onSpanClick={actions.onSpanClick} /></span>
                  </button>
                ))}
                {threadId === seedGate.threadId && (
                  <div className={`gateblock ${gateOpen ? 'open' : 'resolved'}`} data-cursor="conv-gate:board" role="group" aria-label="interrupt gate">
                    <p className="label" style={{ margin: 0 }}>interrupt gate · {seedGate.by}</p>
                    <p className="prose" style={{ margin: '6px 0' }}>{gateOpen ? seedGate.question : `resolved · ${gateResolved === 'yes' ? seedGate.yes : seedGate.no}`}</p>
                    {gateOpen && <span className="tileyn"><button onClick={() => actions.resolveGate('yes')}>[y] {seedGate.yes}</button><button onClick={() => actions.resolveGate('no')}>[n] {seedGate.no}</button></span>}
                  </div>
                )}
              </div>
              <div data-col="3">
                {hasWorkspaceDiff ? (
                  <>
                    <p className="label">file mutations <span className="n">{sessionHunks.length} hunks · {sessionChangeSet.task}</span></p>
                    {sessionHunks.map((h, hi) => (
                      <button key={hi} className="turnrow" data-cursor={`conv-artifact:${h.file}`} onClick={() => { actions.setReviewSetId(sessionChangeSet.id); actions.setReviewFile(h.file); actions.goPivot(PIVOTS.indexOf('review')) }}>
                        <span className="turnhead">{h.file} <span className="faint">· {h.range} · {h.fn}</span></span>
                        <span className="turnsummary"><span style={{ color: 'var(--add)' }}>+{h.adds}</span> / <span style={{ color: 'var(--del)' }}>−{h.dels}</span> · {h.tag} · <span className={`hunkstate state-${h.state}`}>{h.state}</span></span>
                      </button>
                    ))}
                  </>
                ) : (
                  <>
                    <p className="label">executed commands & pty <span className="n">{ptyTraceTurns.length} turns</span></p>
                    {ptyTraceTurns.slice(0, 18).map((t) => (
                      <button key={t.i} className={t.i === selectedTurn ? 'turnrow sel' : 'turnrow'} data-cursor={`conv-turn:${t.i}`} onClick={() => setSelectedTurn(t.i)} onDoubleClick={() => actions.setZoom(3)}>
                        <span className="turnhead"><span className="turnnum">{String(t.i + 1).padStart(2, '0')}</span> {t.actor} <span className="faint">· E{String(t.epoch || 1).padStart(2, '0')}</span></span>
                        <span className="turnsummary mono">{(t.trace?.[0] || t.stdout?.[0] || t.summary)}</span>
                      </button>
                    ))}
                  </>
                )}
              </div>
            </div>
          </div>
        ) : zoom === 3 && activeTurn ? (
          /* Z3 · full-bleed session: 60% structured stream / 40% pinned context */
          <div className="z3-container">
            <div className="epochstrip" aria-label="epochs">
              <span className="label" style={{ margin: 0 }}>epochs [z]:</span>
              {epochs.map((ep) => (
                <button key={ep.n} className={ep.n === activeEpoch.n ? 'epochchip on' : 'epochchip'} data-cursor={`conv-epoch:${ep.n}`} onClick={() => actions.jumpToEpoch(ep)}>
                  {ep.n === activeEpoch.n ? '■ ' : ''}[E{String(ep.n).padStart(2, '0')} {ep.name}]
                </button>
              ))}
              <button className="ghostbtn" style={{ flex: 'none' }} onClick={() => actions.setEpochGrid(true)}>jump grid</button>
              {epochs.length > 1 && (
                <button
                  className="ghostbtn"
                  style={{ flex: 'none' }}
                  data-cursor="conv-epoch-compress:toggle"
                  onClick={() => actions.setCfg({ epochs: { onCommit: true, everyTurns: 15, ...(config?.epochs || {}), compressZ2: !(config?.epochs?.compressZ2 ?? true) } })}
                >
                  {(config?.epochs?.compressZ2 ?? true) ? 'older: Z2 ledger' : 'older: expanded'}
                </button>
              )}
            </div>
            {(hotWords || []).length > 0 && (
              <div className="hotwordstrip" role="toolbar" aria-label="extracted hot words">
                <span className="label" style={{ margin: 0 }}>hot words:</span>
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
            <div className={splitTurn !== null ? 'z3grid split' : 'z3grid'}>
              <div>
                <p className="label">
                  {hotWordFilter
                    ? `filtered by hot word · "${hotWordFilter}" (${streamTurns.length}/${facetTurns.length} turns)`
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
                      <button className={t.i === selectedTurn ? 'streamturn sel' : 'streamturn'} data-cursor={`conv-turn:${t.i}`} onClick={() => setSelectedTurn(t.i)}>
                        <span className="streamhead">{t.actor === 'user' ? 'YOU' : t.actor} <span className="faint">[{t.kind ? t.kind.toUpperCase() : 'TURN'} #{String(t.i + 1).padStart(2, '0')} · {t.age}]</span>{splitTurn === t.i && <span className="accent"> · pinned (v)</span>}</span>
                        <span className="prose" style={{ display: 'block' }}><GroundedText text={t.full || t.synthesis} workspace={workspaceCtx} activeHotWord={hotWordFilter} onSpanClick={actions.onSpanClick} /></span>
                        {(t.stdout || []).length > 0 && <span className="stdout mono" style={{ display: 'block' }}>{t.stdout.map((l, li) => <span key={li} style={{ display: 'block' }}>{l}</span>)}</span>}
                        {t.state === 'running' && <span className="progress thin compact" style={{ display: 'block' }}><i style={{ width: `${t.progress || 0}%` }} /></span>}
                      </button>
                    </div>
                  )
                })}
                {streamTurns.length === 0 && <p className="faint pane-pad">nothing in this facet{hotWordFilter ? ` matching "${hotWordFilter}"` : ''} yet</p>}
                {threadId === seedGate.threadId && (facet === 'all' || facet === 'decisions') && (
                  <div className={`gateblock ${gateOpen ? 'open' : 'resolved'}`} data-cursor="conv-gate:board" role="group" aria-label="interrupt gate">
                    <p className="label" style={{ margin: 0 }}>interrupt gate [{seedGate.by} · {seedGate.kind}]</p>
                    <p className="prose" style={{ margin: '8px 0' }}>{seedGate.text}</p>
                    <p className="prose accent" style={{ margin: '4px 0' }}>? {seedGate.question}</p>
                    {gateOpen
                      ? <span className="tileyn"><button onClick={() => actions.resolveGate('yes')}>[y] {seedGate.yes}</button><button onClick={() => actions.resolveGate('no')}>[n] {seedGate.no}</button><button onClick={() => actions.setPromptOpen(true)}>[c] custom</button></span>
                      : <p className="prose dim">resolved · {gateResolved === 'yes' ? seedGate.yes : seedGate.no} — verifier rerunning</p>}
                  </div>
                )}
                {promptOpen ? (
                  <div className="pane-pad">
                    <p className="label" style={{ position: 'static', marginBottom: 6 }}>prompt · {engineSummary} <span className="n">enter send · esc close</span></p>
                    <textarea ref={promptRef} className="inlineprompt" rows={3} placeholder="instruct swarm, / for commands, ! for raw shell" value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => actions.composerKey(e)} />
                    <ComposerHints cmdMode={cmdMode} cmdHits={cmdHits} runCommand={runCommand} mentions={mentions} />
                  </div>
                ) : (
                  <button className="promptcue" onClick={() => actions.setPromptOpen(true)}>&gt; _ <span className="faint">[i] instruct swarm or type raw shell command into pty…</span></button>
                )}

                {olderCompressedTurns.length > 0 && (
                  <div>
                    <p className="label">earlier epochs · Z2 ledger <span className="n">{olderCompressedTurns.length} compressed turns · click any turn or [z] to jump</span></p>
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
                            <span className="turnsummary"><GroundedText text={cleanDisplayText(t.decision || t.summary)} workspace={workspaceCtx} activeHotWord={hotWordFilter} onSpanClick={actions.onSpanClick} /></span>
                          </button>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
              <div>
                {splitTurn !== null && turns[splitTurn] ? (
                  <>
                    <p className="label">pinned · turn {String(splitTurn + 1).padStart(2, '0')} <span className="n">v unpin · 50/50 split</span></p>
                    <p className="big pane-pad">{turns[splitTurn].actor}</p>
                    <p className="prose"><GroundedText text={turns[splitTurn].full || turns[splitTurn].synthesis} workspace={workspaceCtx} activeHotWord={hotWordFilter} onSpanClick={actions.onSpanClick} /></p>
                    <p className="sublabel">trace</p>
                    {(turns[splitTurn].trace || []).map((l, i) => <p key={i} className="prose dim">{l}</p>)}
                  </>
                ) : hasWorkspaceDiff ? (
                  <>
                    <p className="label">pinned context · live diff <span className="n">{reviewFileObj?.name}:{activeHunk?.line}</span></p>
                    {activeHunk && activeHunk.lines.map(([sign, line], i) => (
                      <div key={i} className={`diffline ${sign === '+' ? 'add' : sign === '-' ? 'del' : ''}`}>{sign} {line}</div>
                    ))}
                    <p className="sublabel">contract & invariant gates <span className="n">epoch {String(activeEpoch.n).padStart(2, '0')}</span></p>
                    {seedInvariants.map((g) => (
                      <p key={g.name} className="prose" style={{ padding: '2px 12px' }}><span className={`invstate inv-${g.state}`}>{g.state === 'FAIL' && !gateOpen && gateResolved === 'yes' ? 'RUN' : g.state}</span> {g.name} <span className="faint">({g.detail})</span></p>
                    ))}
                    <p className="sublabel">spawned workers in this epoch</p>
                    {agents.slice(0, 4).map((a, i) => (
                      <p key={a.id} className="prose" style={{ padding: '2px 12px' }}><span className="turnnum">{String(i + 1).padStart(2, '0')}</span> {a.name} <span className="faint">· {a.phase || a.state} · {a.progress}%</span></p>
                    ))}
                    <p className="sublabel">active turn trace</p>
                    {(activeTurn.trace || []).map((l, i) => <p key={i} className="prose dim">{l}</p>)}
                    {(activeTurn.artifacts || []).length > 0 && (
                      <>
                        <p className="sublabel">emitted artifacts</p>
                        {activeTurn.artifacts.map((a) => (
                          <button key={a} className="artifactlink" data-cursor={`conv-artifact:${a}`} onClick={() => { const f = files.find((x) => x.name === a); if (f) actions.openFile(f) }}>→ {a}</button>
                        ))}
                      </>
                    )}
                  </>
                ) : (
                  <>
                    <p className="label">pinned context · epoch {String(activeEpoch.n).padStart(2, '0')} <span className="n">{activeEpoch.name.toLowerCase()}</span></p>
                    <p className="prose dim">{activeEpoch.summary}</p>
                    {(activeEpoch.hotWords || []).length > 0 && (
                      <>
                        <p className="sublabel">epoch hot words</p>
                        <div className="pane-pad" style={{ display: 'flex', gap: 14, alignItems: 'baseline', flexWrap: 'wrap' }}>
                          {activeEpoch.hotWords.map((hw) => (
                            <button key={hw.key} className="hwchip" onClick={() => actions.setHotWordFilter(hotWordFilter === hw.key ? null : hw.key)}>
                              <span className="bignum">{hw.count}</span><span className="dim"> {hw.label}</span>
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                    <p className="sublabel">extracted session decisions <span className="n">{decisionTurns.length}</span></p>
                    {decisionTurns.slice(-4).map((dt) => (
                      <button key={dt.i} className="turnrow" onClick={() => setSelectedTurn(dt.i)}>
                        <span className="turnhead"><span className="turnnum">{String(dt.i + 1).padStart(2, '0')}</span> {dt.actor} <span className="faint">· E{String(dt.epoch || 1).padStart(2, '0')}</span></span>
                        <span className="turnsummary">{cleanDisplayText(dt.decision || dt.summary)}</span>
                      </button>
                    ))}
                    {(activeTurn.trace || []).length > 0 && (
                      <>
                        <p className="sublabel">active turn trace</p>
                        {(activeTurn.trace || []).map((l, i) => <p key={i} className="prose dim mono" style={{ fontSize: '.86em', padding: '2px 12px' }}>{l}</p>)}
                      </>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        ) : (
          /* Z1 · Visual Studio 3-Pane Split Workbench:
             Col 1: Explorer (Threads, Changed Files, Active Subagents)
             Col 2: Turn Timeline + Always-Docked Prompt Composer
             Col 3: Multi-Tab Inspector (Turn Synthesis, Live Diff, Workspace Files, PTY) */
          <>
          {narrow && convLevel > 0 && (
            <button className="drillhead" onClick={() => setConvLevel(convLevel - 1)} aria-label="back">
              <span className="drillarrow">‹</span> {convLevel === 1 ? 'active threads' : thread.title.toLowerCase()}
            </button>
          )}
          <div className="swiss3" data-cascade data-level={convLevel}>
            {/* ======== COL 1: LEFT EXPLORER (THREADS + CHANGED FILES + WORKERS) ======== */}
            <div data-col="1" className="pane-with-resizer">
              <p className="label">
                <span>active threads</span>
                <span className="n">{threads.length}</span>
              </p>
              {threads.map((t) => (
                <button
                  key={t.id}
                  className={t.id === threadId ? 'threadblock sel' : 'threadblock'}
                  data-cursor={`conv-thread:${t.id}`}
                  onClick={() => {
                    actions.setThreadId(t.id)
                    actions.setThreads((ts) => ts.map((x) => (x.id === t.id ? { ...x, unread: 0 } : x)))
                    setConvLevel(1)
                  }}
                >
                  <span className={t.unread > 0 ? 'threadtitle urgent' : 'threadtitle'}>
                    <span>{t.title}</span>
                    {t.unread > 0 && <sup className="unread">{t.unread}</sup>}
                  </span>
                  <span className="threadsub">{t.status} · {t.age} · {t.project}</span>
                </button>
              ))}

              {/* VS Source Control / Modified Files section directly in the Left Sidebar */}
              <p className="sublabel">
                <span>changed files ({sessionChangeSet?.task || 'session'})</span>
                <span className="n">{sessionChangeSet?.files?.length || 0}</span>
              </p>
              {(sessionChangeSet?.files || []).map((f) => (
                <button
                  key={f.name}
                  className={reviewFileObj?.name === f.name && inspectorTab === 'diff' ? 'turnrow sel' : 'turnrow'}
                  onClick={() => {
                    actions.setReviewSetId(sessionChangeSet.id)
                    actions.setReviewFile(f.name)
                    setInspectorTab('diff')
                  }}
                >
                  <span className="turnhead">{f.name}</span>
                  <span className="turnsummary">
                    <span style={{ color: 'var(--add)' }}>+{f.adds}</span>{' '}
                    <span style={{ color: 'var(--del)' }}>−{f.dels}</span> · {f.hunks.length} hunk{f.hunks.length > 1 ? 's' : ''}
                  </span>
                </button>
              ))}

              {/* Active Subagents summary directly in the Left Sidebar */}
              <p className="sublabel">
                <span>subagents</span>
                <span className="n">{agents.filter((a) => a.state === 'running').length} run</span>
              </p>
              {agents.slice(0, 5).map((a) => (
                <button
                  key={a.id}
                  className="turnrow"
                  onClick={() => {
                    actions.setSelectedAgentId(a.id)
                    actions.goPivot(PIVOTS.indexOf('agents'))
                  }}
                >
                  <span className="turnhead">
                    <span className={a.state === 'running' ? 'accent' : 'faint'}>● </span>
                    {a.name} <span className="faint">· {a.progress}%</span>
                  </span>
                  <span className="turnsummary">{a.phase || a.state} · {a.task}</span>
                </button>
              ))}

              <div className="pane-pad">
                <button className="ghostbtn" onClick={() => actions.togglePin(thread.id)}>
                  {thread.pinned ? 'unpin thread · p' : 'pin thread · p'}
                </button>
              </div>
              {startResize && (
                <div
                  className="split-resizer"
                  role="separator"
                  aria-label="resize left sidebar"
                  title="drag to resize · double-click to reset"
                  onMouseDown={(e) => startResize('left', e)}
                  onDoubleClick={resetPaneWidths}
                />
              )}
            </div>

            {/* ======== COL 2: CENTER STAGE (TURN STREAM + ALWAYS-DOCKED COMPOSER) ======== */}
            <div data-col="2" className="col2-workbench">
              <p className="label">
                <span>turn timeline ({thread.title})</span>
                <span className="n">E{String(activeEpoch.n).padStart(2, '0')} · {turns.length} turns</span>
              </p>

              <div className="col2-stream">
                {turns.length === 0 && <p className="huge faint">ask anything.</p>}
                {turns.map((tn, i) => (
                  <button
                    key={i}
                    className={i === selectedTurn ? 'turnrow sel' : 'turnrow'}
                    data-cursor={`conv-turn:${i}`}
                    onClick={() => {
                      setSelectedTurn(i)
                      setConvLevel(2)
                      actions.scrollPayloadIntoView()
                    }}
                    onDoubleClick={() => actions.setZoom(3)}
                  >
                    <span className="turnhead">
                      <span className="turnnum">{String(i + 1).padStart(2, '0')}</span>
                      <span className={tn.state === 'running' ? (motion.shimmer ? 'shimmer' : 'accent') : ''}>
                        {tn.actor === 'user' ? 'you' : tn.actor}
                      </span>
                      <span className="faint"> · {tn.age}</span>
                      {tn.epoch && <span className="faint"> · E{String(tn.epoch).padStart(2, '0')}</span>}
                    </span>
                    <span className="turnsummary">{tn.summary || tn.intent}</span>
                    {tn.state === 'running' ? (
                      <span className="progress thin compact" style={{ display: 'block' }}>
                        <i style={{ width: `${tn.progress || 0}%` }} />
                      </span>
                    ) : (
                      tn.artifacts?.length > 0 && (
                        <span className="turnmeta">
                          {tn.artifacts.length} artifact{tn.artifacts.length > 1 ? 's' : ''}: {tn.artifacts.slice(0, 2).join(', ')}
                        </span>
                      )
                    )}
                  </button>
                ))}
              </div>

              {threadId === seedGate.threadId && gateOpen && (
                <div className="gateblock" style={{ margin: 0, borderLeft: 0, borderRight: 0, background: 'var(--bg-sel)', borderTop: '1px solid var(--accent)' }} data-cursor="conv-gate:board" role="group" aria-label="interrupt gate">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                    <span style={{ fontSize: '.86em', fontWeight: 600 }}><span className="accent">⚠ {seedGate.by}:</span> {seedGate.question}</span>
                    <span className="tileyn" style={{ padding: 0, border: 0, flex: 'none' }}>
                      <button className="accent" style={{ fontWeight: 700 }} onClick={() => actions.resolveGate('yes')}>[y] {seedGate.yes}</button>
                      <button style={{ fontWeight: 600 }} onClick={() => actions.resolveGate('no')}>[n] {seedGate.no}</button>
                    </span>
                  </div>
                </div>
              )}

              {/* Persistent Docked Prompt Composer at the bottom of Col 2 — never hides Col 3! */}
              <div className="col2-composer" role="region" aria-label="prompt composer">
                <textarea
                  ref={promptRef}
                  className="inlineprompt"
                  rows={promptOpen || draft ? 3 : 2}
                  placeholder="Ask agent or instruct swarm… (@ to mention file/agent, / for commands, ! for shell)"
                  value={draft}
                  onFocus={() => actions.setPromptOpen(true)}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => actions.composerKey(e)}
                />
                <ComposerHints cmdMode={cmdMode} cmdHits={cmdHits} runCommand={runCommand} mentions={mentions} />
                <div className="composer-bar">
                  <span className="faint" style={{ fontSize: '.78em' }}>
                    {engineSummary} · {config.mode} · local: {localStatus.state}
                  </span>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <button className="ghostbtn" onClick={() => actions.goPivot(PIVOTS.indexOf('settings'))}>
                      model / router
                    </button>
                    <button className="solid" onClick={() => actions.send()}>
                      send ↵
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* ======== COL 3: RIGHT INSPECTOR (TURN · DIFF · FILES · PTY) ======== */}
            <div data-col="3" data-payload className="pane-with-resizer">
              {startResize && (
                <div
                  className="split-resizer left-edge"
                  role="separator"
                  aria-label="resize right inspector"
                  title="drag to resize · double-click to reset"
                  onMouseDown={(e) => startResize('right', e)}
                  onDoubleClick={resetPaneWidths}
                />
              )}
              {/* Persistent VS Inspector Tab Strip */}
              <div className="inspector-tabs" role="tablist" aria-label="inspector views">
                <button
                  role="tab"
                  aria-selected={inspectorTab === 'turn'}
                  className={inspectorTab === 'turn' ? 'insp-tab on' : 'insp-tab'}
                  onClick={() => setInspectorTab('turn')}
                >
                  turn <span className="n">#{String(selectedTurn + 1).padStart(2, '0')}</span>
                </button>
                <button
                  role="tab"
                  aria-selected={inspectorTab === 'diff'}
                  className={inspectorTab === 'diff' ? 'insp-tab on' : 'insp-tab'}
                  onClick={() => setInspectorTab('diff')}
                >
                  diff <span className="n">{sessionHunks.length}</span>
                </button>
                <button
                  role="tab"
                  aria-selected={inspectorTab === 'files'}
                  className={inspectorTab === 'files' ? 'insp-tab on' : 'insp-tab'}
                  onClick={() => setInspectorTab('files')}
                >
                  files <span className="n">{files.length}</span>
                </button>
                <button
                  role="tab"
                  aria-selected={inspectorTab === 'pty'}
                  className={inspectorTab === 'pty' ? 'insp-tab on' : 'insp-tab'}
                  onClick={() => setInspectorTab('pty')}
                >
                  pty <span className="n">{(termLines || []).length}</span>
                </button>
              </div>

              {inspectorTab === 'turn' ? (
                activeTurn ? (
                  <>
                    <p className="label" style={{ position: 'static' }}>
                      <span>active turn [{String(selectedTurn + 1).padStart(2, '0')}] · {activeTurn.kind || 'turn'}</span>
                      <span className="n">E{String(activeTurn.epoch || activeEpoch.n).padStart(2, '0')}</span>
                    </p>
                    <p className="sublabel">prompt intent</p>
                    <p className="prose">
                      <GroundedText text={cleanDisplayText(activeTurn.intent)} workspace={workspaceCtx} activeHotWord={hotWordFilter} onSpanClick={actions.onSpanClick} />
                    </p>
                    {activeTurn.decision && (
                      <>
                        <p className="sublabel">extracted decision</p>
                        <div className="decision-card">
                          <p className="prose" style={{ padding: 0 }}>
                            <GroundedText text={cleanDisplayText(activeTurn.decision)} workspace={workspaceCtx} activeHotWord={hotWordFilter} onSpanClick={actions.onSpanClick} />
                          </p>
                        </div>
                      </>
                    )}
                    {activeTurn.thinking && (
                      <>
                        <p className="sublabel">reasoning trace</p>
                        <div className="thinking-card">
                          <p className="prose dim" style={{ padding: 0 }}>
                            <GroundedText text={cleanDisplayText(activeTurn.thinking)} workspace={workspaceCtx} activeHotWord={hotWordFilter} onSpanClick={actions.onSpanClick} />
                          </p>
                        </div>
                      </>
                    )}
                    <p className="sublabel">synthesis{activeTurn.engine ? ` · ${activeTurn.engine}` : ''}</p>
                    <p className="prose">
                      <GroundedText text={activeTurn.synthesis || '…'} workspace={workspaceCtx} activeHotWord={hotWordFilter} onSpanClick={actions.onSpanClick} />
                    </p>
                    {activeTurn.fallbackFrom && <p className="prose accent">remote failed ({activeTurn.fallbackFrom}) — answered locally</p>}
                    {activeTurn.stats?.length > 0 && (
                      <>
                        <p className="sublabel">spawned subagents & outputs</p>
                        <div className="pane-pad" style={{ display: 'flex', gap: 24, alignItems: 'baseline', flexWrap: 'wrap' }}>
                          {activeTurn.stats.map((s) => <span key={s.l}><span className="bignum">{s.v}</span><span className="dim"> {s.l}</span></span>)}
                        </div>
                      </>
                    )}
                    {activeTurn.artifacts?.length > 0 && (
                      <>
                        <p className="sublabel">emitted artifacts</p>
                        <div>
                          {activeTurn.artifacts.map((a) => (
                            <button
                              key={a}
                              className="artifactlink"
                              data-cursor={`conv-artifact:${a}`}
                              onClick={() => {
                                const f = files.find((x) => x.name === a)
                                if (f) {
                                  setInspectedFileName(f.name)
                                  setInspectorTab('files')
                                } else if (a === 'Prompt Draft') {
                                  actions.pushActivity('you proceeded with Prompt Draft')
                                  actions.setRunProgress(8)
                                  actions.setRunLabel('teamwork_preview · iteration 6')
                                }
                              }}
                            >
                              → {a}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                    {/* Always show live diff preview at bottom of Turn Inspector when session has mutations */}
                    {hasWorkspaceDiff && activeHunk && (
                      <>
                        <p className="sublabel">
                          <span>live diff · {reviewFileObj?.name}:{activeHunk.line}</span>
                          <button className="accent" style={{ fontSize: '10px' }} onClick={() => setInspectorTab('diff')}>
                            all {sessionHunks.length} hunks →
                          </button>
                        </p>
                        {activeHunk.lines.map(([sign, line], i) => (
                          <div key={i} className={`diffline ${sign === '+' ? 'add' : sign === '-' ? 'del' : ''}`}>{sign} {line}</div>
                        ))}
                      </>
                    )}
                  </>
                ) : (
                  <p className="dim pane-pad">type in the docked composer to start this thread</p>
                )
              ) : inspectorTab === 'diff' ? (
                <>
                  <p className="label" style={{ position: 'static' }}>
                    <span>working tree diff · {sessionChangeSet?.task}</span>
                    <button className="accent" style={{ fontSize: '10px' }} onClick={() => actions.goPivot(PIVOTS.indexOf('review'))}>
                      full review ↗
                    </button>
                  </p>
                  {sessionHunks.map((h, hi) => (
                    <div key={hi} style={{ borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>
                      <div className="turnrow" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span>
                          <b>{h.file}</b> <span className="faint">· {h.range} · {h.fn}</span>
                        </span>
                        <span className={`hunkstate state-${h.state}`}>{h.state}</span>
                      </div>
                      {h.lines.map(([sign, line], li) => (
                        <div key={li} className={`diffline ${sign === '+' ? 'add' : sign === '-' ? 'del' : ''}`}>{sign} {line}</div>
                      ))}
                      <div className="pane-pad" style={{ display: 'flex', gap: 8, paddingTop: 6, paddingBottom: 2 }}>
                        <button
                          className="ghostbtn"
                          onClick={() => {
                            actions.setReviewSetId(sessionChangeSet.id)
                            actions.setReviewFile(h.file)
                            actions.setHunkState('STAGED')
                          }}
                        >
                          approve · a
                        </button>
                        <button
                          className="ghostbtn"
                          onClick={() => {
                            actions.setReviewSetId(sessionChangeSet.id)
                            actions.setReviewFile(h.file)
                            actions.setHunkState('REJECTED')
                          }}
                        >
                          reject · x
                        </button>
                      </div>
                    </div>
                  ))}
                </>
              ) : inspectorTab === 'files' ? (
                <>
                  <div className="pane-pad" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', borderBottom: '1px solid var(--border)' }}>
                    {files.map((f) => (
                      <button
                        key={f.name}
                        className={f.name === inspectedFileObj?.name ? 'ghostbtn accent' : 'ghostbtn'}
                        onClick={() => setInspectedFileName(f.name)}
                      >
                        {f.name}
                      </button>
                    ))}
                  </div>
                  {inspectedFileObj && (
                    <>
                      <p className="label" style={{ position: 'static' }}>
                        <span>{inspectedFileObj.folder} / {inspectedFileObj.name}</span>
                        <span className="n">{inspectedFileObj.lines} lines · {inspectedFileObj.lang}</span>
                      </p>
                      <code className="codeview">
                        {inspectedFileObj.body.map((l, i) => (
                          <span key={i}><span className="ln">{i + 1}</span>{l}{'\n'}</span>
                        ))}
                      </code>
                    </>
                  )}
                </>
              ) : (
                <>
                  <p className="label" style={{ position: 'static' }}>
                    <span>integrated terminal · fragments</span>
                    <span className="n">pty</span>
                  </p>
                  <div className="term">
                    {(termLines || []).map((l, i) => <div key={i}>{l}</div>)}
                    <div className="promptline">
                      <span className="accent">$</span>
                      <input
                        value={termInput || ''}
                        placeholder="type help, test, build, status…"
                        aria-label="inspector terminal input"
                        onChange={(e) => setTermInput?.(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') actions.runTerm(termInput || '') }}
                      />
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
          </>
        )}
      </div>
    </section>
  )
}

export default memo(ConversationPage)
