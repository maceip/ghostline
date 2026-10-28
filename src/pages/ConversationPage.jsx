import { memo } from 'react'
import { PIVOTS, files, seedEpochs, seedGate, seedInvariants } from '../data.js'

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

/* Conversation pivot: spatial turn matrix. No bubbles, no scroll-of-death. */
function ConversationPage({
  active, zoom, focusTick, narrow, convLevel, setConvLevel, thread, threadId, threads, turns,
  selectedTurn, setSelectedTurn, activeTurn, promptTurns, decisionTurns, activeEpoch, epochCounts,
  sessionChangeSet, sessionHunks, facet, facetTurns, splitTurn, promptOpen, engineSummary, draft, setDraft,
  promptRef, gateOpen, gateResolved, reviewFileObj, activeHunk, agents, config, localStatus, motion,
  cmdMode, cmdHits, runCommand, mentions, actions,
}) {
  return (
    <section className={active ? 'page isactive' : 'page'} aria-label="conversation">
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
                  <button key={t.i} className={t.i === selectedTurn ? 'turnrow sel' : 'turnrow'} data-cursor={`conv-turn:${t.i}`} onClick={() => setSelectedTurn(t.i)} onDoubleClick={() => actions.setZoom(3)}>
                    <span className="turnhead"><span className="turnnum">{String(t.i + 1).padStart(2, '0')}</span> you <span className="faint">· E{String(t.epoch || activeEpoch.n).padStart(2, '0')}</span></span>
                    <span className="turnsummary">{t.intent}</span>
                  </button>
                ))}
                {promptTurns.length === 0 && <p className="faint" style={{ fontWeight: 300 }}>no prompts yet</p>}
              </div>
              <div data-col="2">
                <p className="label">decisions <span className="n">{decisionTurns.length}</span></p>
                {decisionTurns.map((t) => (
                  <button key={t.i} className={t.i === selectedTurn ? 'turnrow sel' : 'turnrow'} data-cursor={`conv-turn:${t.i}`} onClick={() => setSelectedTurn(t.i)} onDoubleClick={() => actions.setZoom(3)}>
                    <span className="turnhead"><span className="turnnum">{String(t.i + 1).padStart(2, '0')}</span> {t.actor}</span>
                    <span className="turnsummary">{t.decision || t.summary}</span>
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
                <p className="label">file mutations <span className="n">{sessionHunks.length} hunks · {sessionChangeSet.task}</span></p>
                {sessionHunks.map((h, hi) => (
                  <button key={hi} className="turnrow" data-cursor={`conv-artifact:${h.file}`} onClick={() => { actions.setReviewSetId(sessionChangeSet.id); actions.setReviewFile(h.file); actions.goPivot(PIVOTS.indexOf('review')) }}>
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
                <button key={ep.n} className={ep.n === activeEpoch.n ? 'epochchip on' : 'epochchip'} data-cursor={`conv-epoch:${ep.n}`} onClick={() => actions.jumpToEpoch(ep)}>
                  {ep.n === activeEpoch.n ? '■ ' : ''}[E{String(ep.n).padStart(2, '0')} {ep.name}]
                </button>
              ))}
              <button className="ghostbtn" onClick={() => actions.setEpochGrid(true)}>jump grid</button>
            </div>
            <div className={splitTurn !== null ? 'z3grid split' : 'z3grid'}>
              <div>
                <p className="label">{facet === 'all' ? `active stream · epoch ${String(activeEpoch.n).padStart(2, '0')}` : `facet · ${facet}`} <span className="n">{thread.title}</span></p>
                {facetTurns.map((t, fi) => (
                  <div key={t.i}>
                    {(fi === 0 || facetTurns[fi - 1].epoch !== t.epoch) && t.epoch && (
                      <button className="milestone" onClick={() => actions.setEpochGrid(true)}>[ E{String(t.epoch).padStart(2, '0')} · {(seedEpochs.find((e) => e.n === t.epoch) || {}).name || 'SESSION'} · {epochCounts.get(t.epoch) || ''} turns ]</button>
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
                  <>
                    <p className="label" style={{ marginTop: 26 }}>prompt · {engineSummary} <span className="n">enter send · esc close</span></p>
                    <textarea ref={promptRef} className="inlineprompt" rows={3} placeholder="instruct swarm, / for commands, ! for raw shell" value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => actions.composerKey(e)} />
                    <ComposerHints cmdMode={cmdMode} cmdHits={cmdHits} runCommand={runCommand} mentions={mentions} />
                  </>
                ) : (
                  <button className="promptcue" onClick={() => actions.setPromptOpen(true)}>&gt; _ <span className="faint">[i] instruct swarm or type raw shell command into pty…</span></button>
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
                          <button key={a} className="artifactlink" data-cursor={`conv-artifact:${a}`} onClick={() => { const f = files.find((x) => x.name === a); if (f) actions.openFile(f) }}>→ {a}</button>
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
                <button key={t.id} className={t.id === threadId ? 'threadblock sel' : 'threadblock'} data-cursor={`conv-thread:${t.id}`} onClick={() => { actions.setThreadId(t.id); actions.setThreads((ts) => ts.map((x) => (x.id === t.id ? { ...x, unread: 0 } : x))); setConvLevel(1) }}>
                  <span className={t.unread > 0 ? 'threadtitle urgent' : 'threadtitle'}>{t.title}{t.unread > 0 && <sup className="unread"> {t.unread}</sup>}</span>
                  <span className="threadsub">{t.status}</span>
                  <span className="threadsub faint">{t.age} · {t.project}</span>
                </button>
              ))}
              <button className="ghostbtn" style={{ marginTop: 14 }} onClick={() => actions.togglePin(thread.id)}>{thread.pinned ? 'unpin thread · p' : 'pin thread · p'}</button>
            </div>
            <div data-col="2">
              <p className="label">turn timeline ({thread.title})</p>
              {turns.length === 0 && <p className="huge faint" style={{ marginTop: 18 }}>ask anything.</p>}
              {turns.map((tn, i) => (
                <button key={i} className={i === selectedTurn ? 'turnrow sel' : 'turnrow'} data-cursor={`conv-turn:${i}`} onClick={() => { setSelectedTurn(i); setConvLevel(2); actions.scrollPayloadIntoView() }} onDoubleClick={() => actions.setZoom(3)}>
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
                  <textarea ref={promptRef} className="inlineprompt" rows={4} placeholder="ask anything. @ to mention, / for commands" value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => actions.composerKey(e)} />
                  <ComposerHints cmdMode={cmdMode} cmdHits={cmdHits} runCommand={runCommand} mentions={mentions} />
                  <div style={{ marginTop: 10, display: 'flex', gap: 22, alignItems: 'baseline' }}>
                    <button className="solid" onClick={() => actions.send()}>send</button>
                    <button className="ghostbtn" onClick={() => actions.goPivot(PIVOTS.indexOf('settings'))}>engine settings</button>
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
                        <button key={a} className="artifactlink" data-cursor={`conv-artifact:${a}`} onClick={() => { const f = files.find((x) => x.name === a); if (f) actions.openFile(f); else if (a === 'Prompt Draft') { actions.pushActivity('you proceeded with Prompt Draft'); actions.setRunProgress(8); actions.setRunLabel('teamwork_preview · iteration 6') } }}>→ {a}</button>
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
  )
}

export default memo(ConversationPage)
