import { memo } from 'react'
import { ACCENTS, folders, seedEpochs } from '../data.js'
import { escalationLevel, fmtTokens } from '../derive.js'
import { ensureLocal } from '../llm/litert.js'
import { bridgeHealthy } from '../llm/bridge.js'

/* Settings pivot: Zune 4.0 configuration matrix — domains -> parameters -> live preview.
   Same 25/35/40 borderless grid, no toggle pills, no dropdown boxes. */
function SettingsPage({
  active, setDomain, setSetDomain, config, setCfg, accent, theme, density, setAccent, setTheme, setDensity,
  gates, tilePolicy, effectivePolicy, motion, coarse, localStatus, bridgeStatus, engineSummary,
  agents, fleetCounts, fleetSpent, tokVelocity, threads, threadTiles, allTurnsCount, actions,
}) {
  return (
    <section className={active ? 'page isactive' : 'page'} aria-label="settings">
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
                z&ensp;epoch jump grid&emsp;v&ensp;pin split in Z3&emsp;: or ctrl + k&ensp;search ribbon (morphs header)<br />
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
              <button className="ghostbtn" onClick={async () => actions.setBridgeStatus((await bridgeHealthy(config.bridgeUrl)) ? 'reachable' : 'unreachable')}>ping bridge</button>
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
          <p className="label" style={{ marginTop: 26 }}>pool saturation <span className="n">{fleetCounts.running} running / {config.maxParallel ?? 10} cap · {fmtTokens(fleetSpent)} of {config.tokenCeiling || '500k'} tokens</span></p>
          <div className="progress"><i style={{ width: `${Math.min(100, (agents.length / (config.maxParallel ?? 10)) * 100)}%` }} /></div>
          <p className="dim" style={{ fontWeight: 300 }}>{fleetCounts.running} running · {fleetCounts.verified} verified · {fleetCounts.blocked} blocked · {fleetCounts.queued} queued</p>
          <p className="label" style={{ marginTop: 26 }}>tile escalation preview <span className="n">live · derived from the real fleet</span></p>
          <div className="tilegrid preview">
            {['board', 'siem'].map((id) => {
              const t = threads.find((x) => x.id === id)
              const tile = threadTiles.get(id)
              if (!t || !tile) return <p key={id} className="dim" style={{ fontWeight: 300 }}>{id} · no tile (idle)</p>
              const level = escalationLevel(tile, effectivePolicy)
              return (
                <div key={id} className={`tile tile-${level === 'accent' ? 'blocked' : level === 'amber' ? 'amber' : tile.phase}`}><span className="tileface">
                  <span className="tiletop"><span>{t.scope}</span><span>{level}</span></span>
                  <span className="tilebig">{tile.big}</span><span className="tilesub">{tile.sub}</span>
                  <span className="tiletitle">{level === 'accent' ? 'escalated · [y]/[n] bound' : level === 'amber' ? 'gate warns · not holding' : 'nominal · stays muted'}</span>
                  <span className="tileprog"><i style={{ width: `${tile.progress}%` }} /></span>
                </span></div>
              )
            })}
          </div>
          {!(tilePolicy.onFail || tilePolicy.onAmbiguity || tilePolicy.onBigDiff) && gates.haltOnMismatch && <p className="dim" style={{ fontWeight: 300 }}>all escalation rules off — interrupts stay amber. the fleet will not tap your shoulder.</p>}
          <p className="label" style={{ marginTop: 26 }}>interrupt threshold policy</p>
          <p className="prose dim">escalate only on: AST contract invariant failure · unresolved merge conflict · sandbox / network egress violation{tilePolicy.onBigDiff ? ` · diff > ${tilePolicy.bigDiffLines} lines` : ''}.</p>
          <p className="label" style={{ marginTop: 26 }}>storage & index footprint</p>
          <p className="prose">{folders.length} modules indexed · {allTurnsCount} turns cached · {seedEpochs.length} epochs</p>
          <p className="prose dim">sessions + engine config in localStorage · model browser-cached after first pull</p>
          <p className="label" style={{ marginTop: 26 }}>about</p>
          <p className="prose dim">zune code — the agentic coding desktop rebuilt in pre-Windows-8 desktop Metro. No sidebar. Type is the chrome.</p>
        </div>
      </div>
    </section>
  )
}

export default memo(SettingsPage)
