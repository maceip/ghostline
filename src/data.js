export const PIVOTS = ['hub', 'conversation', 'collection', 'review', 'terminal', 'agents', 'settings']

export const ACCENTS = [
  { name: 'magenta', value: '#f10da2', hover: '#fa6ec9', pressed: '#b9077b' },
  { name: 'orange', value: '#f09609', hover: '#f7b04a', pressed: '#b46d06' },
  { name: 'cyan', value: '#1ba1e2', hover: '#5dbdea', pressed: '#1375a6' },
  { name: 'lime', value: '#8cbf26', hover: '#aad65e', pressed: '#678a1b' },
  { name: 'purple', value: '#a200ff', hover: '#c05cff', pressed: '#7300b8' },
]

export const seedThreads = [
  {
    id: 'board',
    title: 'Board of Directors',
    project: 'fragments',
    age: 'now',
    pinned: true,
    unread: 3,
    status: '1 subagent running',
    scope: ':fragments.auth',
    messages: [
      { role: 'agent', name: 'Fragments Desktop Multi-Agent Team (teamwork_preview)', text: 'Teamwork Progress (Iteration 4):\n• E2E Verification Track (e2e_test_writer_1): Building the 4-tier test infrastructure (TEST_INFRA.md & TEST_READY.md).\n• Milestone 1 — Model & Key Control Center: three explorers are running in parallel on the RSA-2048 JWT / Keychain vault + :model-serving worker controls.' },
      { role: 'agent', name: 'Fragments Desktop Multi-Agent Team (teamwork_preview)', text: 'Teamwork Progress (Iteration 5):\n• Published TEST_INFRA.md defining the 4-tier testing pyramid across :model-serving, :ui, and :nucleus-macos26.\n• m1_worker_1 is implementing fragments.auth in :ui (AuthAndVaultStore, RSA-2048 JWT signing/verification, Keychain vault).' },
      { role: 'tool', name: 'Prompt Draft', text: 'Launched teamwork_preview multi-agent workflow for /Users/mac/fragments', action: 'Proceed' },
      { role: 'agent', name: 'Fragments Desktop Multi-Agent Team (teamwork_preview)', text: 'Teamwork Progress (Liveness Check 4):\n• All 29 test suites across the 4-tier pyramid are green (./gradlew :nucleus-macos26:jvmTest → 0 failures).\n• VaultService and fragments.auth in :ui are actively being written and wired.' },
    ],
  },
  {
    id: 'siem',
    title: 'SIEM Workbench UI Enhancement',
    project: 'fragments',
    age: '2d',
    pinned: true,
    unread: 0,
    status: 'review ready · 4 files',
    scope: ':fragments.ui',
    messages: [
      { role: 'user', name: 'you', text: 'Restyle the threat workbench to match the inline overlay spec. No material3.' },
      { role: 'agent', name: 'muse', text: 'Done. Threat rows now render inline with severity as type weight, not chips. 4 files changed, screenshot tests updated. Open review to approve the diff.' },
    ],
  },
  {
    id: 'e2e',
    title: 'Real World E2E Demo Verification',
    project: 'fragments',
    age: '6d',
    pinned: false,
    unread: 0,
    status: 'complete · 29 suites green',
    messages: [
      { role: 'user', name: 'you', text: 'Run the full demo verification against a clean checkout.' },
      { role: 'agent', name: 'muse', text: 'Complete. 29 suites green, 0 failures. TEST_READY.md published with the tier breakdown and rerun commands.' },
    ],
  },
  {
    id: 'auth',
    title: 'RSA-2048 JWT + Keychain Vault',
    project: 'fragments.auth',
    age: '1h',
    pinned: false,
    unread: 1,
    status: 'm1_worker_1 writing',
    scope: ':fragments.auth',
    messages: [
      { role: 'agent', name: 'm1_worker_1', text: 'Wiring AuthAndVaultStore into MacosChromeApp.kt. JWT verification path is done; Keychain write-back is next.' },
    ],
  },
]

/* agents are the live state store: tiles, fleet heartbeat, and velocity are all
   DERIVED from these numbers (src/derive.js) and they move on the fleet tick.
   tokens/rate are numeric; pass/total drive testing tiles; adds/dels mutating
   tiles; scanned exploring tiles. threadId links a worker to its workstream. */
export const seedAgents = [
  { id: 'a1', threadId: 'board', name: 'e2e_test_writer_1', task: '4-tier test infrastructure', phase: 'testing', state: 'running', progress: 72, tokens: 48200, rate: 14200, pass: 12, total: 14, tail: '> FuzzDpopConcurrencyTest (72%)', tools: 23, elapsed: '12m', log: ['read TEST_READY.md · 42 lines', 'write TEST_INFRA.md · tier 3 of 4', './gradlew :ui:runComposeUiTest → 11 passed', 'writing tier 4 · clean-checkout e2e script…'] },
  { id: 'a2', threadId: 'board', name: 'm1_explorer_1', task: 'RSA-2048 JWT / Keychain vault survey', phase: 'AST survey', state: 'complete', progress: 100, tokens: 31700, rate: 0, scanned: 14, tail: 'verdict · 1 fail-open path', tools: 18, elapsed: '9m', log: ['grep JwtVerifier → 3 call sites', 'read VaultService.kt · Keychain on macos26', 'verdict · RS256 only, no HS fallback'] },
  { id: 'a3', threadId: 'board', name: 'm1_explorer_2', task: ':model-serving worker controls :9379', phase: ':9379 probe', state: 'complete', progress: 100, tokens: 27900, rate: 0, tail: 'pool · 3 live, 0 stalled', tools: 14, elapsed: '7m', log: ['GET :9379/health → ok', 'worker pool · 3 live, 0 stalled', 'verdict · controls safe to expose in :ui'] },
  { id: 'a4', threadId: 'auth', name: 'm1_explorer_3', task: 'fragments.auth Compose UI survey', phase: 'awaiting slot', state: 'queued', progress: 0, tokens: 0, rate: 0, tail: 'queued behind m1_worker_1', tools: 0, elapsed: '—', log: ['queued behind m1_worker_1'] },
  { id: 'a5', threadId: 'auth', name: 'm1_worker_1', task: 'implementing fragments.auth in :ui', phase: 'patching AST', state: 'running', progress: 41, tokens: 66400, rate: 19600, adds: 48, dels: 12, tail: '> verifyToken() · AuthAndVaultStore.kt', tools: 31, elapsed: '18m', log: ['edit MacosChromeApp.kt · collectAsState session', 'write AuthAndVaultStore.kt · +48', ':ui:compileKotlin → ok', 'wiring ModelAndKeyControlCenter dialog…'] },
  { id: 'a6', threadId: 'board', name: 'm1_verifier_1', task: 'invariant check · enclave gates', phase: 'invariant check', state: 'blocked', progress: 66, tokens: 19300, rate: 0, pass: 2, total: 3, tail: 'gate raised · awaiting arbitration', tools: 9, elapsed: '6m', log: ['AST check no_unauthenticated_fallback → PASS', 'dpop_ath_bound → 12/12 assertions', 'dev_sandbox_boot → FAIL :142 throws without mock PCR0', 'gate raised · awaiting human arbitration'] },
]

export const folders = ['fragments.auth', 'ui', 'model-serving', 'nucleus-macos26', 'docs']

export const files = [
  { name: 'AuthAndVaultStore.kt', folder: 'fragments.auth', lines: 212, lang: 'kotlin', body: ['package fragments.auth', '', 'class AuthAndVaultStore(', '    private val vault: VaultService,', '    private val jwt: JwtVerifier,', ') {', '    fun signIn(token: String): Session {', '        val claims = jwt.verify(token) // RSA-2048', '        vault.store("session", token)', '        return Session(claims.sub, claims.exp)', '    }', '}'] },
  { name: 'VaultService.kt', folder: 'fragments.auth', lines: 96, lang: 'kotlin', body: ['package fragments.auth', '', 'interface VaultService {', '    fun store(key: String, value: String)', '    fun read(key: String): String?', '    fun clear(key: String)', '}'] },
  { name: 'MacosChromeApp.kt', folder: 'ui', lines: 480, lang: 'kotlin', body: ['package fragments.ui', '', '@Composable', 'fun MacosChromeApp(store: AuthAndVaultStore) {', '    val session by store.session.collectAsState()', '    if (session == null) SignIn() else Shell()', '}'] },
  { name: 'ModelAndKeyControlCenter.kt', folder: 'ui', lines: 164, lang: 'kotlin', body: ['package fragments.ui', '', '@Composable', 'fun ModelAndKeyControlCenter(workers: List<Worker>) {', '    workers.forEach { WorkerRow(it) } // live :9379', '}'] },
  { name: 'worker.ts', folder: 'model-serving', lines: 88, lang: 'ts', body: ['export async function serve(port = 9379) {', '  const app = createWorker()', '  app.get("/health", () => ({ ok: true }))', '  return app.listen(port)', '}'] },
  { name: 'TEST_INFRA.md', folder: 'docs', lines: 140, lang: 'md', body: ['# test infrastructure', '', 'tier 1  unit          jvmTest', 'tier 2  compose ui    runComposeUiTest', 'tier 3  integration   :model-serving', 'tier 4  e2e demo      clean checkout'] },
  { name: 'TEST_READY.md', folder: 'docs', lines: 42, lang: 'md', body: ['# test ready', '', '29 suites · 0 failures', './gradlew :nucleus-macos26:jvmTest'] },
  { name: 'jwt-keychain-notes.md', folder: 'docs', lines: 28, lang: 'md', body: ['# jwt + keychain survey', '', 'RS256 only · no HS fallback', '3 JwtVerifier call sites', 'finding · VaultKeyring.kt:142 getLegacy() fail-open', 'verdict · strict DPoP + PCR0, throw on miss'] },
]

export const diff = [
  { file: 'ui/MacosChromeApp.kt', adds: 12, dels: 3 },
  { file: 'fragments.auth/AuthAndVaultStore.kt', adds: 48, dels: 0 },
  { file: 'fragments.auth/VaultService.kt', adds: 21, dels: 5 },
]

export const diffLines = [
  [' ', 'fun MacosChromeApp(store: AuthAndVaultStore) {'],
  ['-', '    val session = store.legacySession()'],
  ['+', '    val session by store.session.collectAsState()'],
  ['+', '    LaunchedEffect(session) { vaultUnlocked(session) }'],
  [' ', '    if (session == null) SignIn() else Shell()'],
  [' ', '}'],
]

export const seedActivity = [
  { when: '2m', what: 'e2e_test_writer_1 published TEST_INFRA.md' },
  { when: '9m', what: 'm1_worker_1 edited AuthAndVaultStore.kt (+48)' },
  { when: '14m', what: '29 test suites green · :nucleus-macos26:jvmTest' },
  { when: '31m', what: 'workflow teamwork_preview iteration 5 started' },
  { when: '1h', what: 'you pinned SIEM Workbench UI Enhancement' },
]

export const artifacts = ['Prompt Draft', 'Wireframe Ghost Overlay Inline', 'Threat Workbench Inline', 'Code Review And Workbench Verification', 'TEST_INFRA.md', 'TEST_READY.md', 'jwt-keychain-notes.md']

/* conversation as a turn matrix: each turn is an index row (col 2) + a payload (col 3).
   full/trace/stdout feed the Enter z-axis reader. */
export const seedTurns = {
  board: [
    { actor: 'user', epoch: 1, kind: 'prompt', age: '2d', summary: '"Rebuild fragments.auth properly…"', intent: 'Rebuild fragments.auth: RSA-2048 JWT, Keychain vault, enclave attestation. Survey before anyone writes code.', synthesis: 'Scoped to fragments.auth + :ui wiring. Read-only survey epochs first; no mutations until the key paths are mapped.', stats: [{ v: '05', l: 'workers planned' }], artifacts: [], full: 'Rebuild fragments.auth properly this time: RSA-2048 JWT verification, Keychain-backed vault, enclave attestation on the boundary. I want surveys before code — spawn explorers, keep workers parked.', trace: ['spawned m1_explorer_1 · jwt/vault', 'spawned m1_explorer_2 · :9379 controls', 'spawned m1_explorer_3 · compose ui'], stdout: [] },
    { actor: 'muse', epoch: 1, kind: 'synthesis', age: '2d', summary: 'Teamwork preview · 3 explorers running', intent: 'Stand up the multi-agent team and the survey plan.', synthesis: 'Teamwork Progress (Iteration 1): three explorers running in parallel — JWT/Keychain survey, :model-serving worker controls, fragments.auth Compose UI. Milestone 1 is Model & Key Control Center.', stats: [{ v: '03', l: 'explorers running' }, { v: '0', l: 'edits' }], artifacts: ['Prompt Draft'], full: 'Teamwork Progress (Iteration 1):\n• m1_explorer_1 — RSA-2048 JWT / Keychain vault survey\n• m1_explorer_2 — :model-serving worker controls on :9379\n• m1_explorer_3 — fragments.auth Compose UI survey\nWorkers stay parked until surveys land.', trace: ['workflow teamwork_preview started', '3 explorers dispatched'], stdout: [] },
    { actor: 'm1_explorer_2', epoch: 1, kind: 'pty', age: '2d', summary: ':9379 worker controls · healthy', intent: 'Probe the model-serving worker pool before exposing controls in :ui.', synthesis: 'Worker pool is healthy: 3 live, 0 stalled. Controls are safe to surface in the control center.', stats: [{ v: '03', l: 'workers live' }, { v: '0', l: 'stalled' }], artifacts: [], full: 'Probed :9379. Health endpoint ok, pool reports 3 live workers and no stalls in the last hour. Verdict: safe to expose start/stop in :ui.', trace: ['GET :9379/health → ok', 'GET :9379/pool → 3 live'], stdout: ['curl :9379/health → {"ok":true}', 'curl :9379/pool → 3 live · 0 stalled'] },
    { actor: 'user', epoch: 2, kind: 'prompt', age: '2d', summary: '"Do we need hardware tokens…"', intent: 'Settle the token hardware question: PKCS#11 or pure Keychain?', synthesis: 'Question routed to the JWT survey: what signs, what verifies, where do keys live.', stats: [], artifacts: [], full: 'Do we need hardware tokens in the loop (PKCS#11), or is Keychain + enclave attestation enough for the threat model? Settle it with evidence, not preference.', trace: ['routed to m1_explorer_1'], stdout: [] },
    { actor: 'm1_explorer_1', epoch: 2, kind: 'decision', decision: 'RS256 only — HS fallback rejected as a downgrade path; Keychain + enclave attestation suffices, no PKCS#11', age: '2d', summary: 'RS256 only · no HS fallback', intent: 'Answer the hardware-token question from the actual call sites.', synthesis: '3 JwtVerifier call sites, all RS256-capable. An HS fallback would be a silent downgrade path — rejected. Keychain storage + enclave PCR attestation covers the threat model without PKCS#11 hardware.', stats: [{ v: '03', l: 'verifier call sites' }, { v: '01', l: 'decision' }], artifacts: ['jwt-keychain-notes.md'], full: 'Surveyed every JwtVerifier call site (3) and the Keychain write path (1).\n\nDecision: RS256 only. Accepting HS256 anywhere creates a downgrade path an attacker can force. Keychain + PCR attestation covers key custody; PKCS#11 hardware adds ops cost without closing a real gap.', trace: ['grep JwtVerifier → 3 call sites', 'read VaultService.kt · Keychain on macos26', 'verdict · RS256 only'], stdout: ['grep -rn "HS256" fragments.auth → 0 hits (keep it that way)'] },
    { actor: 'muse', epoch: 2, kind: 'synthesis', age: '2d', summary: 'Token architecture frozen', intent: 'Record the token decision so workers build against it.', synthesis: 'Frozen: RS256 JWT, Keychain vault, DPoP proof + PCR0 attestation at the enclave boundary. jwt-keychain-notes.md is the reference.', stats: [{ v: '01', l: 'reference doc' }], artifacts: ['jwt-keychain-notes.md'], full: 'Token architecture frozen for the auth rebuild. Anything that weakens it (fallbacks, nullable key paths) is a bug by definition from here on.', trace: ['published jwt-keychain-notes.md'], stdout: [] },
    { actor: 'user', epoch: 3, kind: 'prompt', age: '1d', summary: '"Map the keyring read paths…"', intent: 'Every key lookup path in VaultKeyring, with failure behavior.', synthesis: 'Keyring mapping epoch: enumerate lookups, note what each returns on failure.', stats: [], artifacts: [], full: 'Map the keyring read paths. For every lookup I want: who calls it, what it returns on success, and — the important part — what it returns when the keyring fails.', trace: ['routed to m1_explorer_1'], stdout: [] },
    { actor: 'm1_explorer_1', epoch: 3, kind: 'synthesis', age: '1d', summary: 'Keyring mapped · legacy path found', intent: 'Enumerate VaultKeyring lookups and their failure modes.', synthesis: 'All modern paths verify DPoP + PCR0. One legacy path — getLegacy() at VaultKeyring.kt:142 — returns null on miss. Flagged for the survey epoch to confirm reachability.', stats: [{ v: '01', l: 'legacy path' }, { v: '142', l: 'line' }], artifacts: [], full: 'Keyring map complete. verifyDpop() paths all fail closed.\n\nOne smell: getLegacy() at VaultKeyring.kt:142 returns null on miss, pre-DPoP code. Needs a reachability check before we call it a finding.', trace: ['read VaultKeyring.kt · full', 'grep getLegacy → 1 hit'], stdout: ['grep -rn getLegacy fragments.auth → VaultKeyring.kt:142'] },
    { actor: 'muse', epoch: 3, kind: 'decision', decision: 'Legacy getLegacy() path must be reachability-checked before any patch — survey first', age: '1d', summary: 'Legacy path flagged, not yet patched', intent: 'Avoid patching dead code or missing a live fail-open.', synthesis: 'Parked the patch: first prove whether any live caller can reach getLegacy(). That is epoch 04.', stats: [], artifacts: [], full: 'Not patching on a smell. If getLegacy() is dead code, delete it; if a live caller reaches it, it is a fail-open and gets the strict treatment. Survey decides.', trace: ['queued reachability check · epoch 04'], stdout: [] },
    { actor: 'user', epoch: 4, kind: 'prompt', age: '14m', summary: '"Audit AuthAndVaultStore key rotation…"', intent: 'Verify key rotation invariants across the enclave boundary.', synthesis: 'Scoped the audit to AuthAndVaultStore, VaultKeyring, and the enclave PCR check. Read-only pass first — no edits until the survey lands.', stats: [{ v: '14', l: 'files in scope' }, { v: '0', l: 'edits' }], artifacts: [], full: 'Audit AuthAndVaultStore key rotation. I want the invariants verified across the enclave boundary: who can mint, who can rotate, and what happens on a null key. Survey first, patch second.', trace: ['parsed scope · fragments.auth', 'queued explorer m1_explorer_1'], stdout: [] },
    { actor: 'm1_explorer_1', epoch: 4, kind: 'decision', decision: 'VaultKeyring.kt:142 is fail-open — every other path verifies DPoP + PCR0', age: '12m', summary: 'Surveyed 14 files (+0 / −0)', intent: 'Map every key lookup path in fragments.auth.', synthesis: 'Found an unauthenticated fallback in VaultKeyring.kt line 142: a legacy nullable lookup that returns null instead of failing closed. Every other path verifies DPoP + PCR0.', stats: [{ v: '14', l: 'files surveyed' }, { v: '01', l: 'finding' }], artifacts: ['jwt-keychain-notes.md'], full: 'Survey complete. 14 files read, 3 JwtVerifier call sites, 1 Keychain write path.\n\nThe one finding that matters: VaultKeyring.kt:142 falls back to getLegacy() and returns null on miss. Callers treat null as "no session" — so a keyring failure looks exactly like a signed-out user. Fail-open by silence.', trace: ['grep JwtVerifier → 3 call sites', 'read VaultKeyring.kt:130–160', 'read AuthAndVaultStore.kt · full', 'verdict · 1 fail-open path'], stdout: ['grep -rn getLegacy fragments.auth → 1 hit', 'VaultKeyring.kt:142'] },
    { actor: 'e2e_test_writer_1', epoch: 4, kind: 'pty', age: '11m', summary: 'Baseline: 29 suites green pre-patch', intent: 'Establish the pre-patch test baseline so the patch can be judged against it.', synthesis: 'Clean baseline: 29 suites, 0 failures across the pyramid. Any regression after the patch is the patch.', stats: [{ v: '29', l: 'suites green' }, { v: '0', l: 'failures' }], artifacts: ['TEST_READY.md'], full: 'Baseline run before anyone touches the auth boundary: full pyramid, clean tree. 29 suites green.', trace: ['run tier 1–4 baseline'], stdout: ['./gradlew :nucleus-macos26:jvmTest → 29 suites, 0 failures', './gradlew :ui:runComposeUiTest → 11 passed'] },
    { actor: 'user', epoch: 5, kind: 'decision', decision: 'Strict DPoP + PCR0 or throw — no silent nulls, patch authorized', age: '9m', summary: '"Patch the keyring fallback…"', intent: 'Remove the legacy fallback. Strict DPoP + PCR0 or throw.', synthesis: 'Patch authorized. m1_worker_1 picked it up; e2e_test_writer_1 spawned in parallel to cover the change with the 4-tier suite.', stats: [{ v: '02', l: 'workers spawned' }], artifacts: ['Prompt Draft'], full: 'Patch the keyring fallback. Strict DPoP + PCR0, throw on failure, no silent nulls. Spawn the test writer in parallel — I want this covered before it lands in review.', trace: ['spawned m1_worker_1 · patch', 'spawned e2e_test_writer_1 · coverage'], stdout: [] },
    { actor: 'm1_worker_1', epoch: 5, kind: 'mutation', age: '8m', summary: 'verifyToken() strict · first hunks', intent: 'Replace the nullable legacy lookup with strict verification.', synthesis: 'First hunks written: imports + verifyToken() now verifies DPoP against PCR0_STRICT and throws VaultAuthException on any miss. rotateKey() is next.', stats: [{ v: '33', l: '+ lines so far' }, { v: '02', l: 'hunks' }], artifacts: [], full: 'verifyToken() rewritten: getLegacy() call deleted, verifyDpop(token, PCR0_STRICT) bound directly, null impossible by construction — the elvis throws VaultAuthException.', trace: ['edit AuthAndVaultStore.kt · imports', 'edit verifyToken() · strict DPoP', ':ui:compileKotlin → ok'], stdout: [':ui:compileKotlin → BUILD SUCCESSFUL'] },
    { actor: 'muse', epoch: 5, kind: 'synthesis', age: '7m', summary: 'Coverage spawned in parallel', intent: 'The fail-closed path gets tests before review, not after.', synthesis: 'e2e_test_writer_1 is building the 4-tier coverage for the strict path while the patch finishes: unit, compose-ui, integration, clean-checkout e2e.', stats: [{ v: '04', l: 'test tiers' }], artifacts: ['TEST_INFRA.md'], full: 'Coverage plan locked to the patch: tier 1 unit for verifyToken(), tier 2 compose-ui for the session flow, tier 3 :model-serving integration, tier 4 clean-checkout e2e.', trace: ['test writer briefed with hunk list'], stdout: [] },
    { actor: 'm1_worker_1', epoch: 6, kind: 'mutation', age: '5m', summary: 'Patch staged · 4 hunks (+48 / −12)', intent: 'Finish rotation + teardown so the whole fallback surface is gone.', synthesis: 'Patch complete and staged for review: verifyToken() strict, rotateKey() re-verifies before swap (write-new-then-retire), teardown formatting only. 3 files, 6 hunks total with tests and build.', stats: [{ v: '48', l: '+ lines in AuthAndVaultStore' }, { v: '03', l: 'files staged for review' }], artifacts: [], full: 'All four AuthAndVaultStore hunks staged. rotateKey() now mints and stores the next key before retiring the previous — a crash mid-rotation cannot orphan the session.', trace: ['edit rotateKey() · write-then-retire', 'ktlint pass', 'staged 3 files for review'], stdout: [':ui:assembleDebug → ok'] },
    { actor: 'e2e_test_writer_1', epoch: 6, kind: 'mutation', age: 'running', state: 'running', progress: 72, summary: '4-tier test infrastructure', intent: 'Verify key rotation invariants across enclave boundary.', synthesis: 'Found unauthenticated fallback in VaultKeyring.kt line 142. Patch is staged; tier 3 of 4 is written, clean-checkout e2e script is in progress.', stats: [{ v: '112', l: '+ lines in TEST_INFRA.md' }, { v: '03', l: 'files staged for review' }], artifacts: ['TEST_INFRA.md', 'Wireframe Ghost Overlay Inline'], full: 'Teamwork Progress (Iteration 5):\n• Published TEST_INFRA.md defining the 4-tier testing pyramid across :model-serving, :ui, and :nucleus-macos26.\n• m1_worker_1 is implementing fragments.auth in :ui (AuthAndVaultStore, RSA-2048 JWT signing/verification, Keychain vault).\n• All 29 existing suites green; the new fail-closed path gets tier-2 compose tests + a tier-4 clean-checkout run.', trace: ['read TEST_READY.md · 42 lines', 'write TEST_INFRA.md · tier 3 of 4', 'spawn check · m1_worker_1 at 41%'], stdout: ['./gradlew :ui:runComposeUiTest → 11 passed', './gradlew :nucleus-macos26:jvmTest → 29 suites, 0 failures'] },
    { actor: 'queued · synthesis', epoch: 6, kind: 'synthesis', age: 'queued', state: 'queued', summary: 'Awaiting test suite green', intent: 'Final synthesis once tier 4 lands.', synthesis: 'Will summarize the patch, the coverage, and the residual risk in one pass. Blocked on e2e_test_writer_1.', stats: [], artifacts: [], full: 'Queued. Runs when the 4-tier suite is green.', trace: ['blocked on e2e_test_writer_1'], stdout: [] },
  ],
  siem: [
    { actor: 'user', age: '2d', summary: '"Restyle the threat workbench…"', intent: 'Match the inline overlay spec. No material3.', synthesis: 'Inline overlay rows, severity as type weight instead of chips.', stats: [{ v: '04', l: 'files' }], artifacts: [], full: 'Restyle the threat workbench to match the inline overlay spec. No material3.', trace: ['read overlay spec'], stdout: [] },
    { actor: 'muse', age: '2d', summary: 'Workbench restyled · review ready', intent: 'Ship the inline workbench.', synthesis: 'Done. Threat rows render inline, screenshot tests updated. 4 files changed — the diff is waiting in review under SIEM Workbench UI.', stats: [{ v: '04', l: 'files changed' }, { v: '29', l: 'suites green' }], artifacts: ['Threat Workbench Inline', 'Wireframe Ghost Overlay Inline'], full: 'Done. Threat rows now render inline with severity as type weight, not chips. 4 files changed, screenshot tests updated. Open review to approve the diff.', trace: ['edit ThreatWorkbench.kt', 'update screenshot tests'], stdout: [':ui:runComposeUiTest → passed'] },
  ],
  e2e: [
    { actor: 'user', age: '6d', summary: '"Run the full demo verification…"', intent: 'Clean-checkout verification of the whole demo.', synthesis: 'Full pyramid, clean tree, no cached state.', stats: [], artifacts: [], full: 'Run the full demo verification against a clean checkout.', trace: ['clone · clean', 'run tier 1–4'], stdout: [] },
    { actor: 'muse', age: '6d', summary: 'Complete · 29 suites green', intent: 'Publish the readiness record.', synthesis: 'Complete. 29 suites green, 0 failures. TEST_READY.md published with tier breakdown and rerun commands.', stats: [{ v: '29', l: 'suites green' }, { v: '0', l: 'failures' }], artifacts: ['TEST_READY.md'], full: 'Complete. 29 suites green, 0 failures. TEST_READY.md published with the tier breakdown and rerun commands.', trace: ['publish TEST_READY.md'], stdout: ['./gradlew :nucleus-macos26:jvmTest → 0 failures'] },
  ],
  auth: [
    { actor: 'm1_worker_1', age: '1h', state: 'running', progress: 41, summary: 'Wiring AuthAndVaultStore', intent: 'JWT verification into MacosChromeApp.', synthesis: 'JWT verification path is done; Keychain write-back is next. Wiring AuthAndVaultStore into MacosChromeApp.kt via collectAsState session flow.', stats: [{ v: '48', l: '+ lines' }, { v: '41%', l: 'complete' }], artifacts: [], full: 'Wiring AuthAndVaultStore into MacosChromeApp.kt. JWT verification path is done; Keychain write-back is next.', trace: ['edit MacosChromeApp.kt', 'write AuthAndVaultStore.kt · +48'], stdout: [':ui:compileKotlin → ok'] },
  ],
}

/* review as hunk triage: change set (task) → files → discrete mutation hunks.
   state: STAGED = approved, UNREVIEWED, REJECTED, INSTRUCTED (comment sent back). */
export const seedChangeSets = [
  {
    id: 'cs-board', task: 'Board of Directors',
    files: [
      {
        name: 'AuthAndVaultStore.kt', adds: 48, dels: 12,
        hunks: [
          { range: 'lines 18–24', fn: 'imports', adds: 2, dels: 0, tag: 'low risk', state: 'STAGED', line: 18, by: 'm1_worker_1', rationale: 'Imports for DPoP verification and the VaultAuthException type.', verification: ':ui:compileKotlin → ok', lines: [['+', 'import fragments.auth.dpop.verifyDpop'], ['+', 'import fragments.auth.VaultAuthException'], [' ', 'import fragments.auth.VaultService']] },
          { range: 'lines 138–164', fn: 'verifyToken()', adds: 31, dels: 8, tag: 'auth boundary', state: 'UNREVIEWED', line: 142, by: 'm1_worker_1', rationale: 'Replaced the nullable legacy lookup with strict DPoP + PCR0 check. The old path returned null on keyring failure, which callers read as "signed out" — fail-open by silence. Now it throws.', verification: '29 test suites green · 08ms', lines: [['-', 'val key = keyring.getLegacy()'], ['-', 'if (key == null) return null'], ['+', 'val key = keyring.verifyDpop('], ['+', '    token = request.dpopProof,'], ['+', '    enclavePcr = PCR0_STRICT'], ['+', ') ?: throw VaultAuthException()'], [' ', 'return Session(key.sub, key.exp)']] },
          { range: 'lines 210–225', fn: 'rotateKey()', adds: 15, dels: 4, tag: 'state mutation', state: 'UNREVIEWED', line: 210, by: 'm1_worker_1', rationale: 'Rotation now re-verifies against the enclave before swapping, and writes the new key before retiring the old one so a crash mid-rotation cannot orphan the session.', verification: ':ui:runComposeUiTest → 11 passed', lines: [[' ', 'fun rotateKey() {'], ['-', '    vault.clear("session-key")'], ['+', '    val next = keyring.mint()'], ['+', '    vault.store("session-key", next)'], ['+', '    keyring.retire(previous)'], [' ', '}']] },
          { range: 'lines 301–304', fn: 'teardown()', adds: 0, dels: 0, tag: 'formatting', state: 'UNREVIEWED', line: 301, by: 'm1_worker_1', rationale: 'Whitespace only — ktlint pass over the edited regions.', verification: 'ktlint → clean', lines: [[' ', 'fun teardown() {'], [' ', '    scope.cancel()'], [' ', '}']] },
        ],
      },
      {
        name: 'TEST_INFRA.md', adds: 112, dels: 0,
        hunks: [
          { range: 'lines 1–112', fn: 'new file', adds: 112, dels: 0, tag: 'docs', state: 'UNREVIEWED', line: 1, by: 'e2e_test_writer_1', rationale: 'Defines the 4-tier pyramid so the fail-closed change is covered at unit, compose-ui, integration, and clean-checkout e2e levels.', verification: '29 test suites green', lines: [['+', '# test infrastructure'], ['+', 'tier 1  unit          jvmTest'], ['+', 'tier 2  compose ui    runComposeUiTest'], ['+', 'tier 3  integration   :model-serving'], ['+', 'tier 4  e2e demo      clean checkout']] },
        ],
      },
      {
        name: 'build.gradle.kts', adds: 3, dels: 1,
        hunks: [
          { range: 'lines 44–47', fn: 'dependencies', adds: 3, dels: 1, tag: 'build', state: 'UNREVIEWED', line: 44, by: 'm1_worker_1', rationale: 'Test-only dependencies for the tier-2 compose suite. Nothing ships in the app artifact.', verification: ':ui:assembleDebug → ok', lines: [['-', 'testImplementation("junit:junit:4.13")'], ['+', 'testImplementation("junit:junit:4.13")'], ['+', 'testImplementation(project(":nucleus-macos26"))'], ['+', 'testImplementation("androidx.compose.ui:ui-test-junit4")']] },
        ],
      },
    ],
  },
  {
    id: 'cs-siem', task: 'SIEM Workbench UI',
    files: [
      {
        name: 'ThreatWorkbench.kt', adds: 64, dels: 38,
        hunks: [
          { range: 'lines 80–120', fn: 'ThreatRow()', adds: 40, dels: 30, tag: 'ui structure', state: 'UNREVIEWED', line: 80, by: 'muse', rationale: 'Rows render inline in the overlay instead of opening a detail sheet; severity is type weight, not a chip.', verification: 'screenshot tests updated', lines: [['-', 'Chip(text = threat.severity.label)'], ['+', 'Text(threat.title, fontWeight = threat.severity.weight)'], ['+', 'InlineOverlay(threat.evidence)']] },
          { range: 'lines 200–214', fn: 'severityWeight()', adds: 24, dels: 8, tag: 'ui mapping', state: 'UNREVIEWED', line: 200, by: 'muse', rationale: 'Single mapping from severity to Segoe weight so the workbench and overlay cannot drift apart.', verification: ':ui:runComposeUiTest → passed', lines: [['+', 'fun severityWeight(s: Severity) = when (s) {'], ['+', '    CRITICAL -> FontWeight.Bold'], ['+', '    HIGH -> FontWeight.SemiBold'], ['+', '    else -> FontWeight.Light'], ['+', '}']] },
        ],
      },
      { name: 'OverlaySpec.kt', adds: 22, dels: 0, hunks: [{ range: 'lines 1–22', fn: 'new file', adds: 22, dels: 0, tag: 'ui spec', state: 'STAGED', line: 1, by: 'muse', rationale: 'Geometry constants for the ghost overlay, lifted out of the workbench so the wireframe test can assert them.', verification: 'screenshot tests updated', lines: [['+', 'object OverlaySpec {'], ['+', '    val gutter = 32.dp'], ['+', '    val rowBaseline = 48.dp'], ['+', '}']] }] },
      { name: 'WorkbenchScreenshotTest.kt', adds: 31, dels: 9, hunks: [{ range: 'lines 12–40', fn: 'goldens', adds: 31, dels: 9, tag: 'tests', state: 'UNREVIEWED', line: 12, by: 'muse', rationale: 'Regenerated goldens for the inline rows; deleted the chip-layout captures.', verification: 'goldens → 6 updated', lines: [['-', '@Test fun chipRow() = capture("chip-row")'], ['+', '@Test fun inlineRow() = capture("inline-row")'], ['+', '@Test fun overlayOpen() = capture("overlay-open")']] }] },
      { name: 'MacosChromeApp.kt', adds: 12, dels: 3, hunks: [{ range: 'lines 60–66', fn: 'MacosChromeApp()', adds: 12, dels: 3, tag: 'wiring', state: 'UNREVIEWED', line: 60, by: 'm1_worker_1', rationale: 'Session now collected as state so sign-in/out re-renders the shell without a restart; vault unlock is a launched effect on session change.', verification: ':ui:compileKotlin → ok', lines: [[' ', 'fun MacosChromeApp(store: AuthAndVaultStore) {'], ['-', '    val session = store.legacySession()'], ['+', '    val session by store.session.collectAsState()'], ['+', '    LaunchedEffect(session) { vaultUnlocked(session) }'], [' ', '    if (session == null) SignIn() else Shell()'], [' ', '}']] }] },
    ],
  },
]

export const seedTerminal = [
  'fragments · zsh',
  '$ ./gradlew :nucleus-macos26:jvmTest',
  '29 suites · 0 failures · 41s',
  '$ git status --short',
  ' M ui/MacosChromeApp.kt',
  '?? fragments.auth/AuthAndVaultStore.kt',
]

export const agentReply = 'On it. I will survey the affected files first, make the smallest change that satisfies the request, then run the focused test tier and report the diff in review. The hub now-running column tracks this run.'

/* long sessions auto-segment into epochs (Zune alphabet jump grid, applied to time).
   anchor = index into seedTurns.board the epoch teleports to; older epochs are
   summary-only in the seed — their turns scrolled off days ago, which is the point. */
export const seedEpochs = [
  { n: 1, name: 'KICKOFF', when: 'THU 09:15', anchor: 0, summary: 'Scope set: fragments.auth, RSA-2048 JWT, Keychain vault. Teamwork preview spawned with 5 workers.' },
  { n: 2, name: 'PKCS#11', when: 'THU 11:40', anchor: 3, summary: 'Token hardware survey. RS256 only — HS fallback rejected as a downgrade path.' },
  { n: 3, name: 'KEYRING', when: 'THU 15:02', anchor: 6, summary: 'VaultKeyring mapped. Legacy getLegacy() path found, flagged for the survey epoch.' },
  { n: 4, name: 'SURVEY', when: 'FRI 09:20', anchor: 9, summary: '14 files read. One fail-open path at VaultKeyring.kt:142; everything else verifies DPoP + PCR0.' },
  { n: 5, name: 'DPOP', when: 'FRI 10:05', anchor: 12, summary: 'Decision: strict DPoP + PCR0 or throw. Patch authorized, test writer spawned in parallel.' },
  { n: 6, name: 'PATCH · NOW', when: 'FRI 14:12', anchor: 15, summary: 'Patch staged across 4 hunks (+48 / −12). 4-tier suite at 12/14; verifier gate is holding the merge.' },
]

/* the one human-arbitration gate currently holding the fleet (drives the hot-pink tile) */
export const seedGate = {
  threadId: 'board', by: 'm1_verifier_1', age: '2m', kind: 'BLOCKING MERGE', line: 142, cause: 'test-fail', file: 'AuthAndVaultStore.kt',
  text: 'DevSandboxTest failed because local macOS runs lack a hardware Nitro PCR0 register. The strict patch throws at AuthAndVaultStore.kt:142 without one.',
  question: 'Inject MockPcr0Provider for local :dev test profile only?',
  yes: 'inject mock in :dev', no: 'keep strict',
}

export const seedInvariants = [
  { state: 'PASS', name: 'no_unauthenticated_fallback', detail: 'AST static check' },
  { state: 'PASS', name: 'dpop_ath_bound', detail: '12/12 unit assertions' },
  { state: 'FAIL', name: 'dev_sandbox_boot', detail: ':142 throws without mock PCR0' },
  { state: 'RUN', name: 'replay_window_under_50ms', detail: '72% · fuzzing 1,420/2,000 iters' },
]
