import { memo } from 'react'
import { PIVOTS, artifacts } from '../data.js'
import { fmtTokens } from '../derive.js'

/* Agents pivot: same 3-column Swiss grid as the hub, never full-width rows. */
function AgentsPage({ active, narrow, agentsLevel, setAgentsLevel, runningAgents, agents, tiltSpot, motion, telemetryAgent, fleetSpent, config, actions }) {
  return (
    <section className={active ? 'page isactive' : 'page'} aria-label="agents">
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
            <button key={a.id} className="agentblock tiltcard spotcard" {...tiltSpot} data-cursor={`agents-agent:${a.id}`} onClick={() => { actions.setSelectedAgentId(a.id); setAgentsLevel(1); actions.scrollPayloadIntoView() }}>
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
            <button key={a.id} className="agentblock tiltcard spotcard" {...tiltSpot} data-cursor={`agents-agent:${a.id}`} onClick={() => { actions.setSelectedAgentId(a.id); setAgentsLevel(1); actions.scrollPayloadIntoView() }}>
              <span className={`agentname state-${a.state}`}>{a.name}</span>
              <span className="agenttask dim">{a.task}</span>
              <span className={`agentmeta state-${a.state}`}>{a.state} · {a.progress}%</span>
            </button>
          ))}
          <p className="label" style={{ marginTop: 34 }}>fleet burn</p>
          <span className="bignum">{fmtTokens(fleetSpent)}</span><span className="dim" style={{ fontWeight: 300 }}> tokens · {agents.length} subagents · {runningAgents.length} running · ceiling {config.tokenCeiling || '500k'}</span>
          <p className="dim" style={{ fontWeight: 300, marginTop: 14 }}>artifacts {artifacts.length} · workflow teamwork_preview</p>
        </div>
        <div data-col="2" data-payload>
          <p className="label">selected · telemetry</p>
          {telemetryAgent && (
            <>
              <p className="big" style={{ marginBottom: 4 }}>{telemetryAgent.name}</p>
              <p className="dim" style={{ fontWeight: 300, margin: '0 0 18px 0' }}>{telemetryAgent.task} · <span className={`state-${telemetryAgent.state}`}>{telemetryAgent.state}</span></p>
              <div style={{ display: 'flex', gap: 40, alignItems: 'baseline', marginBottom: 20 }}>
                <span><span className="bignum">{fmtTokens(telemetryAgent.tokens)}</span><span className="dim"> tokens</span></span>
                <span><span className="bignum">{telemetryAgent.tools}</span><span className="dim"> tools</span></span>
                <span><span className="bignum">{telemetryAgent.progress}%</span></span>
              </div>
              <p className="label">stdout</p>
              <div className="stdout mono">
                {telemetryAgent.log.map((l, i) => <div key={i}>{l}</div>)}
                {telemetryAgent.state === 'running' && <div className="accent">▌</div>}
              </div>
              <div style={{ display: 'flex', gap: 26, marginTop: 20 }}>
                <button className="ghostbtn" onClick={() => actions.toggleAgent(telemetryAgent.id)}>{telemetryAgent.state === 'running' ? 'pause · p' : 'run · p'}</button>
                <button className="ghostbtn" onClick={() => actions.goPivot(PIVOTS.indexOf('review'))}>diff · d</button>
                <button className="ghostbtn" onClick={() => actions.killAgent(telemetryAgent.id)}>kill · x</button>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  )
}

export default memo(AgentsPage)
