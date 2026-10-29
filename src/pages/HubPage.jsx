import { memo } from 'react'
import { files, artifacts, seedGate, seedEpochs, PIVOTS } from '../data.js'
import { fmtTokens, escalationLevel } from '../derive.js'

/* Hub pivot: telemetry tiles, the subagent pipeline, and the mutation stream. */
function HubPage({
  active, tiledThreads, threadTiles, effectivePolicy, gateBlocking, gateResolved, idleThreads,
  turnsByThread, thread, threads, runningAgents, sendingRef, runProgress, runLabel, agents, activity,
  fleetCounts, suitesPass, suitesTotal, allTurnsCount, tokVelocity, fleetSpent, derivedEpochs, tiltSpot, motion, actions,
}) {
  return (
    <section className={active ? 'page isactive' : 'page'} aria-label="hub">
      <div className="hub" data-cascade>
        <div>
          <p className="label">active workstreams <span className="n">{tiledThreads.length} tiles · cap 8</span></p>
          {/* polymorphic telemetry tiles: only active / staged / blocked workstreams earn a square.
              the big numeral changes meaning by phase; blocked goes solid accent with inline [y]/[n]. */}
          <div className="tilegrid">
            {tiledThreads.map((t) => {
              const tile = threadTiles.get(t.id)
              const level = escalationLevel(tile, effectivePolicy)
              const blocked = tile.phase === 'blocked'
              return (
                <div key={t.id} className={`tile tile-${level === 'accent' ? 'blocked' : level === 'amber' ? 'amber' : tile.phase} tiltcard spotcard`} {...tiltSpot}>
                  <button className="tileface" data-cursor={`hub-pin:${t.id}`} onClick={() => actions.openThread(t.id)}>
                    <span className="tiletop"><span>{blocked ? `${t.scope} · ${level === 'accent' ? 'BLOCK' : 'GATE'}` : t.scope}</span><span>{blocked ? seedGate.age : tile.phase === 'ready' ? 'READY' : t.age}</span></span>
                    <span className="tilebig">{tile.big}</span>
                    <span className="tilesub">{tile.sub}</span>
                    <span className="tiletitle">{t.title.replace(/ UI Enhancement| Verification/g, '')}</span>
                    <span className="tiletail">{tile.tail}</span>
                    <span className="tileprog"><i style={{ width: `${tile.progress}%` }} /></span>
                  </button>
                  {blocked && (
                    <span className="tileyn">
                      <button onClick={() => actions.resolveGate('yes')}>[y] yes</button>
                      <button onClick={() => actions.resolveGate('no')}>[n] no</button>
                      <button onClick={() => { actions.openThread(t.id); actions.setZoom(3) }}>[enter]</button>
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
              <button key={t.id} data-cursor={`hub-thread:${t.id}`} onClick={() => actions.openThread(t.id)}>
                {t.title}{t.unread > 0 && <span className="unread"> {t.unread}</span>}
                <span className="meta"> · {t.age} · {t.project}</span>
              </button>
            ))}
          </div>
          <p className="label" style={{ marginTop: 30 }}>conversation epochs <span className="n">z jump grid</span></p>
          <div className="rows">
            <button data-cursor={`hub-epoch:${thread.id}`} onClick={() => { actions.openThread(thread.id); actions.setEpochGrid(true) }}>
              {thread.title} {thread.id === 'board' && <span className="unread">3</span>}<span className="meta"> · {thread.age} · {(turnsByThread[thread.id] || []).length} turns · {(derivedEpochs || seedEpochs).length} epochs</span>
            </button>
            {thread.id !== 'board' && (
              <button data-cursor="hub-epoch:board" onClick={() => { actions.openThread('board'); actions.setEpochGrid(true) }}>
                Board of Directors <span className="unread">3</span><span className="meta"> · now · {(turnsByThread.board || []).length} turns · {seedEpochs.length} epochs</span>
              </button>
            )}
          </div>
        </div>

        <div>
          <p className="label">subagent pipeline <span className="n">now focused · {thread.title.toLowerCase()}</span></p>
          <p className="huge">{runningAgents[0]?.name || 'idle'}</p>
          <p className="big dim" style={{ marginTop: 8 }}>{runningAgents[0]?.task || 'no agent is running'}</p>
          <div className="progress"><i style={{ width: `${sendingRef.current ? runProgress : (runningAgents[0]?.progress ?? 0)}%` }} /></div>
          <p className="dim" style={{ fontWeight: 300 }}>{sendingRef.current ? runLabel : runningAgents[0] ? `${runningAgents[0].name} · ${runningAgents[0].phase} · ${fmtTokens(runningAgents[0].tokens)} tokens` : 'fleet idle'}</p>
          <div style={{ marginTop: 26 }}>
            {agents.map((a) => (
              <button key={a.id} className="rowbtn" data-cursor={`hub-agent:${a.id}`} onClick={() => { actions.setSelectedAgentId(a.id); actions.setAgentsLevel(1); actions.goPivot(PIVOTS.indexOf('agents')) }}>
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
              <button key={a} data-cursor={`hub-artifact:${a}`} onClick={() => { const f = files.find((x) => x.name === a); if (f) actions.openFile(f); else actions.openThread('board') }}>{a}</button>
            ))}
          </div>
          <p className="label" style={{ marginTop: 34 }}>session metrics <span className="n">active pool</span></p>
          <div style={{ display: 'flex', gap: 44, alignItems: 'baseline' }}>
            <span><span className="bignum">{String(agents.length).padStart(2, '0')}</span><span className="dim"> subagents · {fleetCounts.running} running</span></span>
            <span><span className="bignum">{suitesPass} / {suitesTotal}</span><span className="dim"> suites green{gateBlocking ? ' · gate holding' : ''}</span></span>
          </div>
          <p className="dim" style={{ fontWeight: 300, marginTop: 10 }}>{allTurnsCount} turns across {threads.length} sessions · {fmtTokens(fleetSpent)} tokens burned · {tokVelocity} tok/s</p>
        </div>
      </div>
    </section>
  )
}

export default memo(HubPage)
