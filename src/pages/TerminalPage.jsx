import { memo } from 'react'

/* Terminal pivot. State lives in App; this component is memoized so the 1.6s
   fleet tick and the per-token stream never re-render it. */
function TerminalPage({ active, termLines, termInput, setTermInput, actions }) {
  return (
    <section className={active ? 'page isactive' : 'page'} aria-label="terminal">
      <p className="label">terminal · fragments</p>
      <div className="term">
        {termLines.map((l, i) => <div key={i}>{l}</div>)}
        <div className="promptline"><span className="accent">$</span>
          <input value={termInput} placeholder="type help" aria-label="terminal input" onChange={(e) => setTermInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') actions.runTerm(termInput) }} />
        </div>
      </div>
    </section>
  )
}

export default memo(TerminalPage)
