import { memo } from 'react'
import { folders, files } from '../data.js'

/* Collection pivot: folders · files · code. */
function CollectionPage({ active, narrow, colLevel, setColLevel, folder, setFolder, fileName, setFileName, focusTick, file, threadId, actions }) {
  return (
    <section className={active ? 'page isactive' : 'page'} aria-label="collection">
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
            <button className="solid" onClick={() => { actions.setDraft(`explain ${file.name} and suggest the smallest safe refactor`); actions.openThread(threadId); actions.setPromptOpen(true) }}>ask about this file</button>
            <button className="ghostbtn" onClick={() => actions.setZoom(0)}>zoom out to map</button>
          </div>
        </div>
      </div>
    </section>
  )
}

export default memo(CollectionPage)
