import { memo } from 'react'
import { PIVOTS, files } from '../data.js'

/* Review pivot: hunk-level triage. Never scroll a raw file to review a mutation. */
function ReviewPage({
  active, zoom, reviewSet, reviewFileObj, activeHunk, selectedHunk, setSelectedHunk,
  promptTurns, decisionTurns, changeSets, reviewSetId, setReviewSetId, reviewFile, setReviewFile,
  narrow, revLevel, setRevLevel, instructOpen, instructDraft, setInstructDraft, instructRef, actions,
}) {
  return (
    <section className={active ? 'page isactive' : 'page'} aria-label="review">
      {zoom === 2 && reviewFileObj ? (
        /* Z2 in review · the same ledger discipline: prompts + decisions + hunks, no file scroll */
        <div>
          <p className="label">decisions & mutations ledger · {reviewSet.task} <span className="n">Z2 · enter full file (Z3) · esc Z1</span></p>
          <div className="swiss3" data-cascade>
            <div data-col="1">
              <p className="label">my prompts</p>
              {promptTurns.map((t) => (
                <button key={t.i} className="turnrow" data-cursor={`conv-turn:${t.i}`} onClick={() => { actions.setSelectedTurn(t.i); actions.goPivot(PIVOTS.indexOf('conversation')) }}>
                  <span className="turnhead"><span className="turnnum">{String(t.i + 1).padStart(2, '0')}</span> you</span>
                  <span className="turnsummary">{t.intent}</span>
                </button>
              ))}
            </div>
            <div data-col="2">
              <p className="label">decisions</p>
              {decisionTurns.map((t) => (
                <button key={t.i} className="turnrow" data-cursor={`conv-turn:${t.i}`} onClick={() => { actions.setSelectedTurn(t.i); actions.goPivot(PIVOTS.indexOf('conversation')) }}>
                  <span className="turnhead"><span className="turnnum">{String(t.i + 1).padStart(2, '0')}</span> {t.actor}</span>
                  <span className="turnsummary">{t.decision || t.summary}</span>
                </button>
              ))}
            </div>
            <div data-col="3">
              <p className="label">mutation hunks · {reviewFileObj.name}</p>
              {reviewFileObj.hunks.map((h, i) => (
                <button key={i} className={i === selectedHunk ? 'hunkrow sel' : 'hunkrow'} data-cursor={`rev-hunk:${i}`} onClick={() => setSelectedHunk(i)} onDoubleClick={() => actions.setZoom(3)}>
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
              <button key={i} className={i === selectedHunk ? 'hunkrow sel' : 'hunkrow'} data-cursor={`rev-hunk:${i}`} onClick={() => { setSelectedHunk(i); setRevLevel(2); actions.scrollPayloadIntoView() }} onDoubleClick={() => actions.setZoom(3)}>
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
                      onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); actions.sendInstruction() } }} />
                  </>
                )}
                <div style={{ display: 'flex', gap: 26, marginTop: 22 }}>
                  <button className="ghostbtn" onClick={() => actions.setHunkState('STAGED')}>approve · a</button>
                  <button className="ghostbtn" onClick={() => actions.setHunkState('REJECTED')}>reject · x</button>
                  <button className="ghostbtn" onClick={() => actions.setInstructOpen(true)}>instruct · c</button>
                </div>
              </>
            )}
          </div>
        </div>
        </>
      )}
    </section>
  )
}

export default memo(ReviewPage)
