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

  // 1. Navigate to Conversation pivot (Z1) on Board of Directors
  await page.click('nav.pivotrail button.pivot:has-text("conversation")')
  await page.waitForSelector('.page.isactive[aria-label="conversation"]')

  const z1Spans = await page.locator('.page.isactive .gspan').count()
  assert.ok(z1Spans > 0, `expected grounded spans in Z1 Col 3, got ${z1Spans}`)

  // 2. Step to Z2 (Decisions & Mutations Ledger)
  await page.click('.zoomstops button:has-text("Z2")')
  const z2Header = await page.locator('.page.isactive .label').first().textContent()
  assert.ok(z2Header.includes('decisions & mutations ledger'), `expected Z2 ledger header, got ${z2Header}`)

  // 3. Step to Z3 (Full-bleed session with Epoch Strip + Hot-Word Strip + Z2 older-epoch compression)
  await page.click('.zoomstops button:has-text("Z3")')
  await page.waitForSelector('.epochstrip')
  await page.waitForSelector('.hotwordstrip')

  const hwChips = await page.locator('.hotwordstrip .hwchip').count()
  assert.ok(hwChips >= 5, `expected at least 5 hot-word chips in Z3 .hotwordstrip, got ${hwChips}`)

  // Verify older epochs are compressed to 1-line Z2 ledger rows by default
  const compressedBefore = await page.locator('.streamturn.compressed').count()
  assert.ok(compressedBefore >= 10, `expected older epochs compressed in Z3, got ${compressedBefore} compressed turns`)

  // Toggle older-epoch compression off and back on
  await page.click('[data-cursor="conv-epoch-compress:toggle"]')
  const compressedAfterExpand = await page.locator('.streamturn.compressed').count()
  assert.equal(compressedAfterExpand, 0, 'expected 0 compressed turns after toggling older: expanded')
  await page.click('[data-cursor="conv-epoch-compress:toggle"]')
  assert.ok((await page.locator('.streamturn.compressed').count()) >= 10, 'expected older epochs re-compressed')

  // Click first hot-word chip in .hotwordstrip to filter Z3 turns and highlight grounded spans
  const firstHw = page.locator('.hotwordstrip .hwchip').first()
  const firstHwText = await firstHw.textContent()
  await firstHw.click()
  assert.ok(await firstHw.evaluate((el) => el.classList.contains('on')), 'clicked hot-word chip must have .on class')
  const activeGrounded = await page.locator('.streamturn .gspan.grounded-active').count()
  assert.ok(activeGrounded >= 1, `expected .grounded-active spans when filtered by ${firstHwText}`)

  // Clear hot-word filter via the clear button
  await page.click('.hotwordstrip .hwclear')
  assert.equal(await page.locator('.hotwordstrip .hwclear').count(), 0, 'hot-word filter should clear')

  // Click a grounded file span (TEST_INFRA.md in E06) to verify direct jump to REVIEW pivot
  const fileSpan = page.locator('.streamturn .gspan.g-file:has-text("TEST_INFRA.md")').first()
  assert.ok((await fileSpan.count()) > 0, 'expected grounded TEST_INFRA.md span in active E06 stream')
  await fileSpan.click()
  await page.waitForSelector('.page.isactive[aria-label="review"]')
  const revSelectedFile = await page.locator('.page.isactive .revfile.sel .revfilename').textContent()
  assert.equal(revSelectedFile?.trim(), 'TEST_INFRA.md', 'clicking grounded TEST_INFRA.md span must select TEST_INFRA.md in Review')

  // 4. Switch to the 200-turn Codex session ("Codex ExecuTorch 200") and benchmark UI responsiveness
  await page.click('.zoomstops button:has-text("Z1")')
  await page.click('nav.pivotrail button.pivot:has-text("conversation")')
  await page.waitForSelector('.page.isactive[aria-label="conversation"]')
  const tSwitch0 = performance.now()
  await page.click('.page.isactive [data-cursor="conv-thread:codex"]')
  await page.waitForSelector('[data-cursor="conv-turn:199"]')
  const z1SwitchMs = performance.now() - tSwitch0

  // Step to Z2 on the 200-turn Codex thread
  const tZ2_0 = performance.now()
  await page.click('.zoomstops button:has-text("Z2")')
  await page.waitForSelector('.page.isactive .label:has-text("decisions & mutations ledger")')
  const z2SwitchMs = performance.now() - tZ2_0
  const codexPromptsCount = await page.locator('.page.isactive [data-col="1"] .turnrow').count()
  const codexDecisionsCount = await page.locator('.page.isactive [data-col="2"] .turnrow').count()
  assert.ok(codexPromptsCount > 20, `expected >20 user prompts in 200-turn Codex Z2 ledger, got ${codexPromptsCount}`)
  assert.ok(codexDecisionsCount > 15, `expected >15 extracted decisions in 200-turn Codex Z2 ledger, got ${codexDecisionsCount}`)

  // Step to Z3 on the 200-turn Codex thread
  const tZ3_0 = performance.now()
  await page.click('.zoomstops button:has-text("Z3")')
  await page.waitForSelector('.hotwordstrip .hwchip:has-text("ExecuTorch")')
  const z3SwitchMs = performance.now() - tZ3_0

  const codexEpochsCount = await page.locator('.epochstrip .epochchip').count()
  assert.equal(codexEpochsCount, 14, `expected 14 epochs on 200-turn Codex session, got ${codexEpochsCount}`)

  // Verify Z2 compression keeps Z3 compact on a 200-turn session (190 compressed older turns, 10 expanded in E14)
  const codexCompressedCount = await page.locator('.streamturn.compressed').count()
  assert.equal(codexCompressedCount, 190, `expected 190 older-epoch turns compressed in Z3, got ${codexCompressedCount}`)

  // Open [z] Epoch Jump Grid on the 200-turn Codex session
  const tGrid0 = performance.now()
  await page.keyboard.press('z')
  await page.waitForSelector('.epochgrid')
  const gridOpenMs = performance.now() - tGrid0

  const gridCells = await page.locator('.epochgrid .epochcells .mapblock').count()
  assert.equal(gridCells, 14, `expected 14 epoch cells in [z] jump grid, got ${gridCells}`)
  const gridHotWords = await page.locator('.epochgrid .ephotwords .ephw').count()
  assert.ok(gridHotWords >= 30, `expected extracted hot-word badges inside epoch jump grid cells, got ${gridHotWords}`)

  // Click Epoch 01 ([01] usb) in the jump grid to teleport to Turn 01
  await page.click('.epochgrid [data-cursor="conv-epoch:1"]')
  await page.waitForSelector('.epochstrip .epochchip.on:has-text("E01 USB")')

  // Filter the 200-turn stream by clicking "ExecuTorch" in .hotwordstrip
  const tFilter0 = performance.now()
  await page.click('.hotwordstrip .hwchip:has-text("ExecuTorch")')
  await page.waitForSelector('.hotwordstrip .hwclear')
  const filterMs = performance.now() - tFilter0
  const filteredTurns = await page.locator('.z3grid .streamturn').count()
  assert.equal(filteredTurns, 51, `expected 51 turns matching ExecuTorch hot-word filter, got ${filteredTurns}`)

  // 5. Verify CC Switch Settings controls in Settings Domain 01 (thinkingLevel, circuitBreaker, rectifier, optimizer, modelMapping)
  await page.click('.zoomstops button:has-text("Z1")')
  await page.click('nav.pivotrail button.pivot:has-text("settings")')
  await page.waitForSelector('.page.isactive[aria-label="settings"]')

  // Click thinkingLevel 'high' and verify persistence in localStorage
  await page.click('.page.isactive .paramrow:has-text("thinking level") button:has-text("high")')
  const storedAfterHigh = await page.evaluate(() => JSON.parse(localStorage.getItem('zunecode.config.v1')))
  assert.equal(storedAfterHigh.thinkingLevel, 'high', 'thinkingLevel must persist to localStorage')

  // Toggle circuit breaker off and back on, and verify persistence
  await page.click('.page.isactive .paramrow:has-text("circuit breaker") button:has-text("off")')
  const storedAfterCbOff = await page.evaluate(() => JSON.parse(localStorage.getItem('zunecode.config.v1')))
  assert.equal(storedAfterCbOff.circuitBreaker.enabled, false, 'circuitBreaker.enabled=false must persist')
  await page.click('.page.isactive .paramrow:has-text("circuit breaker") button:has-text("on")')

  // Toggle rectifier off and back on
  await page.click('.page.isactive .paramrow:has-text("thinking signature & budget rectifier") button:has-text("off")')
  const storedAfterRectOff = await page.evaluate(() => JSON.parse(localStorage.getItem('zunecode.config.v1')))
  assert.equal(storedAfterRectOff.rectifier.enabled, false, 'rectifier.enabled=false must persist')
  await page.click('.page.isactive .paramrow:has-text("thinking signature & budget rectifier") button:has-text("on")')

  // Toggle prompt cache 4-breakpoint injector off and back on
  await page.click('.page.isactive .paramrow:has-text("prompt cache 4-breakpoint injector") button:has-text("off")')
  const storedAfterOptOff = await page.evaluate(() => JSON.parse(localStorage.getItem('zunecode.config.v1')))
  assert.equal(storedAfterOptOff.optimizer.cacheInjection, false, 'optimizer.cacheInjection=false must persist')
  await page.click('.page.isactive .paramrow:has-text("prompt cache 4-breakpoint injector") button:has-text("on")')

  // 6. E2E Verification of Z0 Sky-Level Mosaic -> Z3 Persistent 3-Column Zune Workbench
  await page.click('nav.pivotrail button.pivot:has-text("conversation")')
  await page.click('.zoomstops button:has-text("Z0")')
  await page.waitForSelector('.zoommap.z0skymap')

  // Verify the room pivot rail (hub conversation collection...) is NOT rendered at Z0
  const pivotRailAtZ0 = await page.locator('nav.pivotrail').count()
  assert.equal(pivotRailAtZ0, 0, 'nav.pivotrail (hub conversation...) must be hidden at Z0')

  const z0TilesCount = await page.locator('.z0skymap .z0tile').count()
  assert.equal(z0TilesCount, 9, `expected 9 episodic session tiles across 60d in Z0 sky map, got ${z0TilesCount}`)

  // Verify every Z0 session tile has both a Square Live Telemetry Tile (.z0square) and a Paired Tile Description (.z0desc)
  const z0SquaresCount = await page.locator('.z0skymap .z0tile .z0square').count()
  const z0DescsCount = await page.locator('.z0skymap .z0tile .z0desc').count()
  assert.equal(z0SquaresCount, 9, 'every Z0 session must render a .z0square live telemetry tile face')
  assert.equal(z0DescsCount, 9, 'every Z0 session must render a paired .z0desc typographic description')

  // Verify all 6 live fleet workers render as live tiles + descriptions in the Z0 right column
  const z0AgentUnitsCount = await page.locator('.z0skymap .z0agentunit').count()
  assert.equal(z0AgentUnitsCount, 6, `expected 6 live fleet agent tile units in Z0 right rail, got ${z0AgentUnitsCount}`)

  // Verify live gate arbitration right on the Z0 blocked tile (board) updates the tile big numeral live
  const boardBigBefore = await page.locator('[data-testid="z0-tile-big-board"]').textContent()
  assert.equal(boardBigBefore?.trim(), 'FAIL :142', `expected FAIL :142 on blocked board tile, got ${boardBigBefore}`)
  await page.click('[data-testid="z0-gate-yes"]')
  const boardBigAfter = await page.locator('[data-testid="z0-tile-big-board"]').textContent()
  assert.notEqual(boardBigAfter?.trim(), 'FAIL :142', 'resolving gate on Z0 tile must immediately transition board tile to live testing telemetry')

  // Orienteer by typing a human prompt fragment from 2 months ago ("randomly log me out")
  await page.fill('[data-testid="z0-orienteer-input"]', 'randomly log me out')
  await page.waitForSelector('[data-testid="z0-match-badge-refresh-race"]')
  const matchBadgeText = await page.locator('[data-testid="z0-match-badge-refresh-race"]').textContent()
  assert.ok(matchBadgeText.includes('MATCHED YOUR PROMPT'), `expected MATCHED YOUR PROMPT badge, got ${matchBadgeText}`)

  // Verify temporal neighbor in the same 6-8w swimlane stays visible (.z0-neighbor) while unrelated tiles dim (.searchdim)
  const zigNeighborClass = await page.locator('[data-testid="z0-tile-zig-linker"]').getAttribute('class')
  assert.ok(zigNeighborClass.includes('z0-neighbor'), `expected temporal neighbor .z0-neighbor on zig-linker, got ${zigNeighborClass}`)

  // Clear Z0 query and click the 2-month-old session tile ("OAuth Token Refresh Multi-Tab Race") to dive straight into Z3 3-Column Workbench
  await page.click('[data-testid="z0-orienteer-clear"]')
  await page.click('[data-testid="z0-tile-refresh-race"]')

  // Assert we landed directly in Z3 Persistent 3-Column Workbench (.z3grid.workbench3)
  await page.waitForSelector('[data-testid="z3-workbench-grid"].workbench3')
  const wbColsCount = await page.locator('[data-testid="z3-workbench-grid"] > [data-wb-col]').count()
  assert.equal(wbColsCount, 3, `expected 3 persistent columns in Z3 workbench, got ${wbColsCount}`)

  // Verify Col 1 shows session files & human prompts, Col 2 shows conversation stream + composer, Col 3 shows RefreshGraceWindow.kt diff
  const diffHeaderBefore = await page.locator('[data-testid="z3-diff-header"]').textContent()
  assert.ok(diffHeaderBefore.includes('RefreshGraceWindow.kt'), `expected RefreshGraceWindow.kt in Col 3 diff, got ${diffHeaderBefore}`)

  // Click AuthAndVaultStore.kt in Col 1 and verify Col 3 switches to AuthAndVaultStore.kt without leaving the 3-column workbench
  await page.click('[data-testid="wb-file-AuthAndVaultStore.kt"]')
  const diffHeaderAfter = await page.locator('[data-testid="z3-diff-header"]').textContent()
  assert.ok(diffHeaderAfter.includes('AuthAndVaultStore.kt'), `expected AuthAndVaultStore.kt in Col 3 after clicking Col 1 file, got ${diffHeaderAfter}`)

  // Test inline semantic fold ("Z1 my prompts & decisions only") inside Col 2 while keeping all 3 columns on screen
  await page.click('[data-testid="z3-fold-human-decisions"]')
  const humanDecisionTurns = await page.locator('.z3grid .streamturn').count()
  assert.equal(humanDecisionTurns, 4, `expected 4 human prompts + decision turns when robot filler is muted in refresh-race, got ${humanDecisionTurns}`)
  await page.click('[data-testid="z3-fold-z2-older"]')

  // Click the ↑ Z0 sky map button in Z3 to zoom back up to Z0
  await page.click('[data-testid="z3-to-z0-btn"]')
  await page.waitForSelector('.zoommap.z0skymap')

  assert.equal(consoleErrors.length, 0, `unexpected page errors: ${consoleErrors.join('; ')}`)

  console.log(JSON.stringify({
    ok: true,
    codexTurns: 200,
    codexPromptsCount,
    codexDecisionsCount,
    codexEpochsCount,
    codexCompressedCount,
    gridHotWords,
    filteredExecuTorchTurns: filteredTurns,
    uiTimingsMs: {
      z1SwitchMs: Math.round(z1SwitchMs),
      z2SwitchMs: Math.round(z2SwitchMs),
      z3SwitchMs: Math.round(z3SwitchMs),
      gridOpenMs: Math.round(gridOpenMs),
      filterMs: Math.round(filterMs),
    },
  }, null, 2))
} finally {
  await browser.close()
  server.kill('SIGTERM')
}
