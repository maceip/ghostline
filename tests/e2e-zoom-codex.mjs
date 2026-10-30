import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const { chromium } = await import('playwright').catch(
  () => import('/Users/mac/.npm/_npx/31e32ef8478fbf80/node_modules/playwright/index.mjs'),
)
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const PORT = 5188
const URL = `http://127.0.0.1:${PORT}`

const server = spawn('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', String(PORT)], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env },
})

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('vite preview timeout')), 10000)
  server.stdout.on('data', (chunk) => {
    if (String(chunk).includes(String(PORT))) {
      clearTimeout(timer)
      resolve()
    }
  })
  server.on('error', reject)
})

const browser = await chromium.launch({
  headless: true,
  ...(fs.existsSync(chromePath) ? { executablePath: chromePath } : {}),
})

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const consoleErrors = []
  page.on('pageerror', (err) => consoleErrors.push(String(err)))

  await page.goto(URL, { waitUntil: 'networkidle' })

  // 1. Verify default startup lands directly in the 3-Column Conversation Workbench at Z3 (all the way in)
  await page.waitForSelector('.page.isactive[aria-label="conversation"]')
  await page.waitForSelector('[data-testid="z3-workbench-grid"].workbench3')
  await page.waitForSelector('[data-testid="col2-z3-stream"]')

  const wbColsCount = await page.locator('[data-testid="z3-workbench-grid"] > [data-wb-col]').count()
  assert.equal(wbColsCount, 3, `expected 3 persistent columns in workbench by default, got ${wbColsCount}`)

  const z3Spans = await page.locator('.page.isactive .gspan').count()
  assert.ok(z3Spans > 0, `expected grounded spans in default Z3 stream, got ${z3Spans}`)

  // Verify older epochs are compressed to 1-line Z2 ledger rows by default in Z3
  const compressedBefore = await page.locator('.streamturn.compressed').count()
  assert.ok(compressedBefore >= 10, `expected older epochs compressed in Z3, got ${compressedBefore} compressed turns`)

  // Toggle older-epoch compression off and back on
  await page.click('[data-cursor="conv-epoch-compress:toggle"]')
  const compressedAfterExpand = await page.locator('.streamturn.compressed').count()
  assert.equal(compressedAfterExpand, 0, 'expected 0 compressed turns after toggling older: expanded')
  await page.click('[data-cursor="conv-epoch-compress:toggle"]')
  assert.ok((await page.locator('.streamturn.compressed').count()) >= 10, 'expected older epochs re-compressed')

  // Click first concept chip in .hotwordstrip to filter turns and highlight grounded spans
  const firstHw = page.locator('.hotwordstrip .hwchip').first()
  const firstHwText = await firstHw.textContent()
  await firstHw.click()
  assert.ok(await firstHw.evaluate((el) => el.classList.contains('on')), 'clicked concept chip must have .on class')
  const activeGrounded = await page.locator('.streamturn .gspan.grounded-active').count()
  assert.ok(activeGrounded >= 1, `expected .grounded-active spans when filtered by ${firstHwText}`)

  // Clear concept filter
  await page.click('.hotwordstrip .hwclear')
  assert.equal(await page.locator('.hotwordstrip .hwclear').count(), 0, 'concept filter should clear')

  // Click a grounded file span (TEST_INFRA.md in E06) to verify direct jump to REVIEW pivot, then return to conversation
  const fileSpan = page.locator('.streamturn .gspan.g-file:has-text("TEST_INFRA.md")').first()
  assert.ok((await fileSpan.count()) > 0, 'expected grounded TEST_INFRA.md span in active E06 stream')
  await fileSpan.click()
  await page.waitForSelector('.page.isactive[aria-label="review"]')
  const revSelectedFile = await page.locator('.page.isactive .revfile.sel .revfilename').textContent()
  assert.equal(revSelectedFile?.trim(), 'TEST_INFRA.md', 'clicking grounded TEST_INFRA.md span must select TEST_INFRA.md in Review')

  // Return to Conversation 3-Column Workbench at Z3
  await page.click('nav.pivotrail button.pivot:has-text("conversation")')
  await page.click('.zoomstops button:has-text("Z3")')
  await page.waitForSelector('[data-testid="col2-z3-stream"]')

  // 2. Switch to the 200-turn (~105k lines) Codex session ("Codex ExecuTorch 200") via Column 1
  const tSwitch0 = performance.now()
  await page.click('.page.isactive [data-cursor="conv-thread:codex"]')
  await page.waitForSelector('[data-cursor="conv-turn:199"]')
  const z3SwitchMs = performance.now() - tSwitch0

  // Record exact layout bounding boxes of Column 1 and Column 3 at Z3
  const getColBounds = async () => page.evaluate(() => {
    const c1 = document.querySelector('[data-wb-col="1"]').getBoundingClientRect()
    const c2 = document.querySelector('[data-wb-col="2"]').getBoundingClientRect()
    const c3 = document.querySelector('[data-wb-col="3"]').getBoundingClientRect()
    const nav = document.querySelector('nav.pivotrail').getBoundingClientRect()
    return {
      c1Left: Math.round(c1.left), c1Width: Math.round(c1.width),
      c2Left: Math.round(c2.left), c2Width: Math.round(c2.width),
      c3Left: Math.round(c3.left), c3Width: Math.round(c3.width),
      navTop: Math.round(nav.top), navHeight: Math.round(nav.height),
    }
  })
  const boundsZ3 = await getColBounds()

  // 3. Hold Ctrl + Zoom Out 1 step -> Z2 (1-Line Turn, Decision & Mutation Ledger in Column 2)
  const tZ2_0 = performance.now()
  await page.keyboard.press('Control+-')
  await page.waitForSelector('[data-testid="col2-z2-ledger"]')
  const z2SwitchMs = performance.now() - tZ2_0

  const boundsZ2 = await getColBounds()
  assert.deepEqual(boundsZ2, boundsZ3, 'Zooming Z3 -> Z2 must NOT change any of the 3-column page layout coordinates')

  const codexPromptsCount = await page.locator('[data-testid="col2-z2-ledger"] [data-col="1"] .turnrow').count()
  const codexDecisionsCount = await page.locator('[data-testid="col2-z2-ledger"] [data-col="2"] .turnrow').count()
  assert.ok(codexPromptsCount > 20, `expected >20 user prompts in 200-turn Codex Z2 ledger, got ${codexPromptsCount}`)
  assert.ok(codexDecisionsCount > 15, `expected >15 extracted decisions in 200-turn Codex Z2 ledger, got ${codexDecisionsCount}`)

  // 4. Hold Ctrl + Zoom Out 1 more step -> Z1 (14 Chronological Epoch Chapters in Column 2)
  const tZ1_0 = performance.now()
  await page.keyboard.press('Control+-')
  await page.waitForSelector('[data-testid="col2-z1-chapters"]')
  const z1SwitchMs = performance.now() - tZ1_0

  const boundsZ1 = await getColBounds()
  assert.deepEqual(boundsZ1, boundsZ3, 'Zooming Z2 -> Z1 must NOT change any of the 3-column page layout coordinates')

  const z1ChaptersCount = await page.locator('[data-testid="col2-z1-chapters"] .z1chapter').count()
  assert.equal(z1ChaptersCount, 14, `expected 14 epoch chapters in Z1 Column 2, got ${z1ChaptersCount}`)

  // 5. Hold Ctrl + Shift + Zoom Out -> Z0 (Concepts Throughout History in Column 2)
  // First step back to Z3 with Ctrl+Shift+=, then test Ctrl+Shift+- jumping straight from Z3 -> Z0!
  await page.keyboard.press('Control+Shift+=')
  await page.waitForSelector('[data-testid="col2-z3-stream"]')

  const tZ0_0 = performance.now()
  await page.keyboard.press('Control+Shift+-')
  await page.waitForSelector('[data-testid="col2-z0-concepts"]')
  const z0SwitchMs = performance.now() - tZ0_0

  const boundsZ0 = await getColBounds()
  assert.deepEqual(boundsZ0, boundsZ3, 'Ctrl+Shift+Zoom Out (Z3 -> Z0 Concepts) must NOT change any of the 3-column page layout coordinates')

  const z0ErasCount = await page.locator('[data-testid="col2-z0-concepts"] .z0eracard').count()
  assert.equal(z0ErasCount, 3, `expected 3 chronological eras in Z0 Concepts view, got ${z0ErasCount}`)

  const z0ConceptsCount = await page.locator('[data-testid="col2-z0-concepts"] .z0conceptrow').count()
  assert.ok(z0ConceptsCount >= 8, `expected >= 8 concept rows with chronological heat strips in Z0, got ${z0ConceptsCount}`)

  // Click the "ExecuTorch" concept title in Z0 to filter the session to ExecuTorch turns and dive straight into Z3
  const tFilter0 = performance.now()
  await page.click('[data-testid="concept-card-executorch"] .z0concepttitle')
  await page.waitForSelector('[data-testid="col2-z3-stream"]')
  const filterMs = performance.now() - tFilter0

  const filteredTurns = await page.locator('[data-testid="col2-z3-stream"] .streamturn').count()
  assert.equal(filteredTurns, 51, `expected 51 turns matching ExecuTorch concept filter in Z3, got ${filteredTurns}`)
  await page.click('.hotwordstrip .hwclear')

  // Open [z] Epoch Jump Grid on the 200-turn Codex session
  const tGrid0 = performance.now()
  await page.keyboard.press('z')
  await page.waitForSelector('.epochgrid')
  const gridOpenMs = performance.now() - tGrid0
  const gridCells = await page.locator('.epochgrid .epochcells .mapblock').count()
  assert.equal(gridCells, 14, `expected 14 epoch cells in [z] jump grid, got ${gridCells}`)
  const gridHotWords = await page.locator('.epochgrid .ephotwords .ephw').count()
  assert.ok(gridHotWords >= 30, `expected extracted hot-word badges inside epoch jump grid cells, got ${gridHotWords}`)
  await page.keyboard.press('Escape')

  // 6. Verify switching to "OAuth Token Refresh Multi-Tab Race" in Column 1 updates Column 2 & Column 3 Live Diff
  await page.click('[data-testid="wb-session-refresh-race"]')
  const diffHeaderBefore = await page.locator('[data-testid="z3-diff-header"]').textContent()
  assert.ok(diffHeaderBefore.includes('RefreshGraceWindow.kt'), `expected RefreshGraceWindow.kt in Col 3 diff, got ${diffHeaderBefore}`)

  await page.click('[data-testid="wb-file-AuthAndVaultStore.kt"]')
  const diffHeaderAfter = await page.locator('[data-testid="z3-diff-header"]').textContent()
  assert.ok(diffHeaderAfter.includes('AuthAndVaultStore.kt'), `expected AuthAndVaultStore.kt in Col 3 after clicking Col 1 file, got ${diffHeaderAfter}`)

  // 7. Verify CC Switch Settings controls in Settings Domain 01 (thinkingLevel, circuitBreaker, rectifier, optimizer)
  await page.click('nav.pivotrail button.pivot:has-text("settings")')
  await page.waitForSelector('.page.isactive[aria-label="settings"]')

  await page.click('.page.isactive .paramrow:has-text("thinking level") button:has-text("high")')
  const storedAfterHigh = await page.evaluate(() => JSON.parse(localStorage.getItem('zunecode.config.v1')))
  assert.equal(storedAfterHigh.thinkingLevel, 'high', 'thinkingLevel must persist to localStorage')

  assert.equal(consoleErrors.length, 0, `unexpected page errors: ${consoleErrors.join('; ')}`)

  console.log(JSON.stringify({
    ok: true,
    codexTurns: 200,
    codexPromptsCount,
    codexDecisionsCount,
    z1ChaptersCount,
    z0ConceptsCount,
    gridHotWords,
    filteredExecuTorchTurns: filteredTurns,
    layoutShiftPxAcrossZ3_Z2_Z1_Z0: 0,
    uiTimingsMs: {
      z3SwitchMs: Math.round(z3SwitchMs),
      z2SwitchMs: Math.round(z2SwitchMs),
      z1SwitchMs: Math.round(z1SwitchMs),
      z0SwitchMs: Math.round(z0SwitchMs),
      gridOpenMs: Math.round(gridOpenMs),
      filterMs: Math.round(filterMs),
    },
  }, null, 2))
} finally {
  await browser.close()
  server.kill('SIGTERM')
}
