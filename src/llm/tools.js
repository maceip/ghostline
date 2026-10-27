// Workspace tools the agent loop may call. Plain specs (name/description/JSON-schema/run),
// adapted to pi AgentTools in pi.js. Read-only by design in the webview adapter;
// a native bridge (BRIDGE.md) is where write/bash tools belong.
export function makeWorkspaceTools({ files, folders, changeSets }) {
  const byName = (name) => files.find((f) => f.name.toLowerCase() === String(name || '').toLowerCase())
  return [
    {
      name: 'list_files',
      description: 'List files in the workspace, optionally filtered by folder.',
      parameters: { type: 'object', properties: { folder: { type: 'string', description: `One of: ${folders.join(', ')}` } } },
      run: async ({ folder } = {}) => files
        .filter((f) => !folder || f.folder === folder)
        .map((f) => `${f.folder}/${f.name} (${f.lines} lines, ${f.lang})`).join('\n') || 'no files',
    },
    {
      name: 'read_file',
      description: 'Read a workspace file by name.',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      run: async ({ name }) => {
        const f = byName(name)
        if (!f) throw new Error(`no such file: ${name}. Known: ${files.map((x) => x.name).join(', ')}`)
        return `${f.folder}/${f.name}\n${f.body.map((l, i) => `${i + 1}  ${l}`).join('\n')}`
      },
    },
    {
      name: 'get_diff',
      description: 'Get pending review hunks, optionally for one file. Includes each hunk rationale.',
      parameters: { type: 'object', properties: { file: { type: 'string' } } },
      run: async ({ file } = {}) => {
        const out = []
        for (const cs of changeSets) for (const f of cs.files) {
          if (file && f.name.toLowerCase() !== String(file).toLowerCase()) continue
          f.hunks.forEach((h, i) => out.push(
            `${cs.task} · ${f.name} hunk ${i + 1} (${h.range} ${h.fn}, +${h.adds}/-${h.dels}, ${h.state}) by ${h.by}\n${h.lines.map(([s, l]) => `${s} ${l}`).join('\n')}\nrationale: ${h.rationale}`,
          ))
        }
        return out.join('\n\n') || 'no hunks'
      },
    },
    {
      name: 'search',
      description: 'Search file names and contents for a query string.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      run: async ({ query }) => {
        const q = String(query).toLowerCase()
        const hits = []
        for (const f of files) {
          if (f.name.toLowerCase().includes(q)) hits.push(`${f.folder}/${f.name} (filename)`)
          f.body.forEach((l, i) => { if (l.toLowerCase().includes(q)) hits.push(`${f.name}:${i + 1}  ${l.trim()}`) })
        }
        return hits.slice(0, 30).join('\n') || 'no hits'
      },
    },
  ]
}
