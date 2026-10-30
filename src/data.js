import codexTurns from './codexTurns.json' with { type: 'json' }

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
    timeWindow: 'NOW · THIS WEEK',
    landmark: 'tag: v2.4.0-rc1 · enclave freeze',
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
    id: 'auth',
    title: 'RSA-2048 JWT + Keychain Vault',
    project: 'fragments.auth',
    age: '1h',
    timeWindow: 'NOW · THIS WEEK',
    landmark: 'branch: feat/keychain-store',
    pinned: false,
    unread: 1,
    status: 'm1_worker_1 writing',
    scope: ':fragments.auth',
    messages: [
      { role: 'agent', name: 'm1_worker_1', text: 'Wiring AuthAndVaultStore into MacosChromeApp.kt. JWT verification path is done; Keychain write-back is next.' },
    ],
  },
  {
    id: 'codex',
    title: 'Codex ExecuTorch 200',
    project: 'executorch-iot',
    age: '3h',
    timeWindow: 'NOW · THIS WEEK',
    landmark: 'hackathon · VENTUNO Q track',
    pinned: true,
    unread: 0,
    status: '200 turns · 14 epochs',
    scope: ':executorch.iot',
    messages: [
      { role: 'user', name: 'you', text: 'Setup a full development environment for the ExecuTorch hackathon on the IoT track with VENTUNO Q.' },
      { role: 'agent', name: 'codex_iot', text: '200-turn Codex rollout imported from ~/.codex/sessions across 14 hot-word epochs.' },
    ],
  },
  {
    id: 'siem',
    title: 'SIEM Workbench UI Enhancement',
    project: 'fragments',
    age: '2d',
    timeWindow: 'NOW · THIS WEEK',
    landmark: 'PR #442 · inline threat rows',
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
    timeWindow: 'NOW · THIS WEEK',
    landmark: 'tag: v2.3.9 · 29 suites green',
    pinned: false,
    unread: 0,
    status: 'complete · 29 suites green',
    scope: ':docs',
    messages: [
      { role: 'user', name: 'you', text: 'Run the full demo verification against a clean checkout.' },
      { role: 'agent', name: 'muse', text: 'Complete. 29 suites green, 0 failures. TEST_READY.md published with the tier breakdown and rerun commands.' },
    ],
  },
  {
    id: 'litert-quant',
    title: 'LiteRT-LM int4 KV-Cache Attention Sinks',
    project: 'executorch-iot',
    age: '3w',
    timeWindow: '3–4 WEEKS AGO · OCT SPRINT & STRIPE CUTOVER',
    landmark: 'tag: v2.3.0 · QNN int4 drop',
    pinned: false,
    unread: 0,
    status: 'merged · 3w ago',
    scope: ':executorch.iot',
    messages: [
      { role: 'user', name: 'you', text: 'int4 KV-cache quantization breaks tool-call JSON syntax after 4k tokens — stop re-quantizing the first 4 attention sink tokens.' },
      { role: 'agent', name: 'qnn_worker', text: 'Pinned tokens 0..3 in fp16 in KvCacheQuantizer.ts. JSON tool-call validity at 16k context restored from 61% to 99.8%.' },
    ],
  },
  {
    id: 'stripe-webhook',
    title: 'Stripe Webhook Idempotency Collision',
    project: 'payments-stripe',
    age: '1mo',
    timeWindow: '3–4 WEEKS AGO · OCT SPRINT & STRIPE CUTOVER',
    landmark: 'PR #418 · Stripe webhook cutover',
    pinned: false,
    unread: 0,
    status: 'merged · 1mo ago',
    scope: ':payments.stripe',
    messages: [
      { role: 'user', name: 'you', text: 'duplicate invoice.paid webhooks are double-crediting the ledger when Stripe retries on 504 — stop trusting the client timestamp.' },
      { role: 'agent', name: 'billing_worker', text: 'Switched StripeWebhookVerifier.kt to derive the idempotency lock from (event.id + livemode) before opening the DB transaction.' },
    ],
  },
  {
    id: 'zig-linker',
    title: 'macOS 26 arm64e Pointer Auth Crash',
    project: 'nucleus-macos26',
    age: '6w',
    timeWindow: '6–8 WEEKS AGO · SEPT AUTH & MACOS 26 SDK',
    landmark: 'tag: v2.2.0 · arm64e bridge',
    pinned: false,
    unread: 0,
    status: 'merged · 6w ago',
    scope: ':nucleus-macos26',
    messages: [
      { role: 'user', name: 'you', text: 'JNI dylib crashes with EXC_BAD_ACCESS (PAC fail) the instant Zode.app loads libnucleus on macOS 26.' },
      { role: 'agent', name: 'native_worker', text: 'Signed the C callback pointer with ptrauth_sign_unauthenticated in NativeBridgeShim.kt and updated Gradle linker flags.' },
    ],
  },
  {
    id: 'refresh-race',
    title: 'OAuth Token Refresh Multi-Tab Race',
    project: 'fragments.auth',
    age: '2mo',
    timeWindow: '6–8 WEEKS AGO · SEPT AUTH & MACOS 26 SDK',
    landmark: 'tag: v2.1.0 · initial Keychain drop',
    pinned: false,
    unread: 0,
    status: 'merged · 2mo ago',
    scope: ':fragments.auth',
    messages: [
      { role: 'user', name: 'you', text: 'why does token refresh randomly log me out when two windows wake from sleep at the same time?' },
      { role: 'agent', name: 'auth_worker', text: 'Added a 30-second idempotent grace window in RefreshGraceWindow.kt so the losing tab receives the newly rotated Keychain token instead of revoking the session.' },
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

export const folders = ['fragments.auth', 'ui', 'model-serving', 'nucleus-macos26', 'payments.stripe', 'executorch.iot', 'docs']

export const files = [
  { name: 'AuthAndVaultStore.kt', folder: 'fragments.auth', lines: 212, lang: 'kotlin', body: ['package fragments.auth', '', 'class AuthAndVaultStore(', '    private val vault: VaultService,', '    private val jwt: JwtVerifier,', ') {', '    fun signIn(token: String): Session {', '        val claims = jwt.verify(token) // RSA-2048', '        vault.store("session", token)', '        return Session(claims.sub, claims.exp)', '    }', '}'] },
  { name: 'VaultService.kt', folder: 'fragments.auth', lines: 96, lang: 'kotlin', body: ['package fragments.auth', '', 'interface VaultService {', '    fun store(key: String, value: String)', '    fun read(key: String): String?', '    fun clear(key: String)', '}'] },
  { name: 'RefreshGraceWindow.kt', folder: 'fragments.auth', lines: 118, lang: 'kotlin', body: ['package fragments.auth', '', 'class RefreshGraceWindow(private val vault: VaultService) {', '    fun rotateIdempotent(prevToken: String, nowMs: Long): String {', '        val cached = vault.read("grace:$prevToken")', '        if (cached != null) return cached // 30s multi-tab grace window', '        val next = mintRefreshToken()', '        vault.store("grace:$prevToken", next)', '        return next', '    }', '}'] },
  { name: 'MacosChromeApp.kt', folder: 'ui', lines: 480, lang: 'kotlin', body: ['package fragments.ui', '', '@Composable', 'fun MacosChromeApp(store: AuthAndVaultStore) {', '    val session by store.session.collectAsState()', '    if (session == null) SignIn() else Shell()', '}'] },
  { name: 'ModelAndKeyControlCenter.kt', folder: 'ui', lines: 164, lang: 'kotlin', body: ['package fragments.ui', '', '@Composable', 'fun ModelAndKeyControlCenter(workers: List<Worker>) {', '    workers.forEach { WorkerRow(it) } // live :9379', '}'] },
  { name: 'worker.ts', folder: 'model-serving', lines: 88, lang: 'ts', body: ['export async function serve(port = 9379) {', '  const app = createWorker()', '  app.get("/health", () => ({ ok: true }))', '  return app.listen(port)', '}'] },
  { name: 'NativeBridgeShim.kt', folder: 'nucleus-macos26', lines: 144, lang: 'kotlin', body: ['package nucleus.macos26', '', 'object NativeBridgeShim {', '    fun registerSignedCallback(fnPtr: Long): Int {', '        // arm64e ptrauth_sign_unauthenticated strip + re-sign', '        return nativeBindTrampoline(fnPtr and 0x00007FFFFFFFFFFFL)', '    }', '}'] },
  { name: 'StripeWebhookVerifier.kt', folder: 'payments.stripe', lines: 176, lang: 'kotlin', body: ['package payments.stripe', '', 'class StripeWebhookVerifier(private val vault: VaultService) {', '    fun verifyAndLock(eventId: String, livemode: Boolean): Boolean {', '        val key = "stripe:idemp:$eventId:$livemode"', '        if (vault.read(key) != null) return false', '        vault.store(key, "locked")', '        return true', '    }', '}'] },
  { name: 'KvCacheQuantizer.ts', folder: 'executorch.iot', lines: 132, lang: 'ts', body: ['export function quantizeKvBlock(tokens: Float32Array, tokenIdx: number) {', '  if (tokenIdx < 4) return tokens // keep attention sinks 0..3 in fp16', '  return packInt4Symmetric(tokens)', '}'] },
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
  codex: codexTurns,
  'litert-quant': [
    { actor: 'user', epoch: 1, kind: 'prompt', age: '3w', summary: '"int4 KV-cache quantization breaks tool-call JSON…"', intent: 'int4 KV-cache quantization breaks tool-call JSON syntax after 4k tokens — stop re-quantizing the first 4 attention sink tokens.', synthesis: 'Diagnose KV-cache int4 degradation on long tool-call turns and preserve attention sink tokens in fp16.', stats: [{ v: '4k', l: 'context cliff' }], artifacts: [], full: 'int4 KV-cache quantization breaks tool-call JSON syntax after 4k tokens — stop re-quantizing the first 4 attention sink tokens.', trace: ['profiled KvCacheQuantizer.ts at 4096 tokens'], stdout: [] },
    { actor: 'qnn_worker', epoch: 1, kind: 'pty', age: '3w', summary: 'FAIL · symmetric int4 clips sink activations at 4,096 tok', intent: 'Reproduce JSON tool-call corruption on VENTUNO Q.', synthesis: 'Confirmed: tokens 0..3 carry 18x outlier activation magnitudes; symmetric int4 clipping corrupts the grammar state at 4,096 tokens.', stats: [{ v: '61%', l: 'json valid pre-fix' }], artifacts: [], full: 'Reproduced on VENTUNO Q: symmetric int4 clipping on tokens 0..3 destroys attention sink precision, causing malformed JSON tool calls after 4,096 tokens.', trace: ['bench KvCacheQuantizer.ts → FAIL at 4096 tok'], stdout: ['eval tool-call-json @ 4k → 39/100 FAIL (unterminated brace)'] },
    { actor: 'user', epoch: 2, kind: 'prompt', age: '3w', summary: '"pin tokens 0..3 in fp16 and benchmark prefill…"', intent: 'pin tokens 0..3 in fp16 and benchmark prefill latency on VENTUNO Q.', synthesis: 'Keep the first 4 attention sink tokens unquantized in fp16 while packing tokens 4..N in int4.', stats: [{ v: '04', l: 'fp16 sink tokens' }], artifacts: [], full: 'pin tokens 0..3 in fp16 and benchmark prefill latency on VENTUNO Q.', trace: ['dispatched qnn_worker · KvCacheQuantizer.ts'], stdout: [] },
    { actor: 'qnn_worker', epoch: 2, kind: 'decision', decision: 'Pin tokens 0..3 in fp16 (attention sinks) and symmetric-pack tokens >= 4 in int4', age: '3w', summary: 'Attention sinks 0..3 pinned in fp16 · 99.8% JSON valid', intent: 'Bypass int4 quantizer for token indices < 4 in KvCacheQuantizer.ts.', synthesis: 'Patched KvCacheQuantizer.ts to keep tokens 0..3 in fp16. Tool-call JSON validity jumped from 61% to 99.8% at 16k tokens with zero prefill regression.', stats: [{ v: '99.8%', l: 'json valid' }, { v: '01', l: 'file patched' }], artifacts: ['KvCacheQuantizer.ts'], full: 'Patched KvCacheQuantizer.ts: tokens 0..3 stay in fp16 as attention sinks; tokens >= 4 use symmetric int4 packing. Verified 99.8% tool-call JSON validity at 16k context.', trace: ['edit KvCacheQuantizer.ts · +19 / −4'], stdout: ['eval tool-call-json @ 16k → 499/500 PASS (99.8%)'] },
  ],
  'stripe-webhook': [
    { actor: 'user', epoch: 1, kind: 'prompt', age: '1mo', summary: '"duplicate invoice.paid webhooks are double-crediting…"', intent: 'duplicate invoice.paid webhooks are double-crediting the ledger when Stripe retries on 504 — stop trusting the client timestamp.', synthesis: 'Eliminate double-credit race on retried Stripe invoice.paid webhooks.', stats: [{ v: '504', l: 'retry race' }], artifacts: [], full: 'duplicate invoice.paid webhooks are double-crediting the ledger when Stripe retries on 504 — stop trusting the client timestamp.', trace: ['inspected StripeWebhookVerifier.kt'], stdout: [] },
    { actor: 'billing_worker', epoch: 1, kind: 'pty', age: '1mo', summary: 'FAIL · payload timestamp drifts across 504 retries', intent: 'Check why the existing idempotency hash missed retried deliveries.', synthesis: 'The old verifier hashed the HTTP delivery timestamp header, which changes on every Stripe retry attempt.', stats: [{ v: '02', l: 'duplicate credits' }], artifacts: [], full: 'Found the bug: StripeWebhookVerifier hashed the request header timestamp instead of the immutable event.id, so every 504 retry bypassed the lock.', trace: ['test StripeRetrySimulationTest → FAIL (double credit)'], stdout: ['StripeRetrySimulationTest → FAIL: ledger credited 2x on evt_3P9x'] },
    { actor: 'user', epoch: 2, kind: 'prompt', age: '1mo', summary: '"derive the idempotency key from event.id + livemode…"', intent: 'never trust the client timestamp — derive the idempotency key from event.id + livemode in VaultService.', synthesis: 'Lock on stripe:idemp:${event.id}:${livemode} inside VaultService before opening the ledger transaction.', stats: [{ v: '02', l: 'files scoped' }], artifacts: [], full: 'never trust the client timestamp — derive the idempotency key from event.id + livemode in VaultService.', trace: ['routed to billing_worker'], stdout: [] },
    { actor: 'billing_worker', epoch: 2, kind: 'mutation', decision: 'Idempotency key locked on (event.id + livemode) in VaultService prior to ledger mutation', age: '1mo', summary: 'Patched StripeWebhookVerifier.kt (+28 / −9) · 0 duplicates', intent: 'Write atomic idempotency key check in StripeWebhookVerifier.kt.', synthesis: 'StripeWebhookVerifier.kt now locks on stripe:idemp:$eventId:$livemode in VaultService. Retried 504 deliveries short-circuit cleanly with HTTP 200.', stats: [{ v: '28', l: '+ lines' }, { v: '100%', l: 'idempotent' }], artifacts: ['StripeWebhookVerifier.kt', 'VaultService.kt'], full: 'Updated StripeWebhookVerifier.kt and VaultService.kt to persist stripe:idemp:$eventId:$livemode before touching the ledger. 500 concurrent retry simulations pass with 0 duplicate credits.', trace: ['edit StripeWebhookVerifier.kt · +28 / −9', 'test StripeRetrySimulationTest → PASS'], stdout: ['./gradlew :payments.stripe:test → 44 passed, 0 failed'] },
  ],
  'zig-linker': [
    { actor: 'user', epoch: 1, kind: 'prompt', age: '6w', summary: '"JNI dylib crashes with EXC_BAD_ACCESS (PAC fail)…"', intent: 'JNI dylib crashes with EXC_BAD_ACCESS (PAC fail) the instant Zode.app loads libnucleus on macOS 26.', synthesis: 'Fix arm64e pointer authentication crash when loading the native bridge dylib on macOS 26.', stats: [{ v: 'arm64e', l: 'arch' }], artifacts: [], full: 'JNI dylib crashes with EXC_BAD_ACCESS (PAC fail) the instant Zode.app loads libnucleus on macOS 26.', trace: ['captured lldb backtrace on arm64e'], stdout: [] },
    { actor: 'native_worker', epoch: 1, kind: 'pty', age: '6w', summary: 'FAIL · high bits of JNI fnPtr trip arm64e PAC trap', intent: 'Inspect pointer authentication bits on the JNI callback trampoline.', synthesis: 'macOS 26 arm64e signs C function pointers with PAC bits in [63:47]; JNI passes raw 64-bit longs that fault on blraa.', stats: [{ v: 'SIGSEGV', l: 'PAC trap' }], artifacts: [], full: 'lldb confirms EXC_BAD_ACCESS (code=257, PAC authentication failure) at NativeBridgeShim.registerSignedCallback when invoking the C callback pointer.', trace: ['lldb Zode.app → EXC_BAD_ACCESS at registerSignedCallback'], stdout: ['frame #0: libnucleus.dylib`nativeBindTrampoline + 16 [PAC fail]'] },
    { actor: 'user', epoch: 2, kind: 'prompt', age: '6w', summary: '"strip pointer-auth ABI mismatch on the C callback…"', intent: 'strip pointer-auth ABI mismatch on the C callback trampoline and sign with hardened runtime.', synthesis: 'Mask the upper PAC signature bits in NativeBridgeShim.kt before handing the trampoline address to JNI.', stats: [{ v: '01', l: 'shim file' }], artifacts: [], full: 'strip pointer-auth ABI mismatch on the C callback trampoline and sign with hardened runtime.', trace: ['dispatched native_worker'], stdout: [] },
    { actor: 'native_worker', epoch: 2, kind: 'mutation', decision: 'Mask 47-bit canonical address in NativeBridgeShim.kt and re-sign trampoline on arm64e', age: '6w', summary: 'Patched NativeBridgeShim.kt (+24 / −6) · Zode.app boots clean', intent: 'Normalize function pointer bits in NativeBridgeShim.kt.', synthesis: 'NativeBridgeShim.kt now strips non-canonical high bits (0x00007FFFFFFFFFFFL) before binding the JNI trampoline. Verified cold boot on macOS 26 arm64e.', stats: [{ v: '24', l: '+ lines' }, { v: '0', l: 'crashes' }], artifacts: ['NativeBridgeShim.kt'], full: 'Patched NativeBridgeShim.kt to mask the 47-bit canonical address and re-sign inside the C bridge. Zode.app launches cleanly under hardened runtime.', trace: ['edit NativeBridgeShim.kt · +24 / −6', 'codesign --verify Zode.app → ok'], stdout: ['./gradlew :nucleus-macos26:jvmTest → 29 suites, 0 failures'] },
  ],
  'refresh-race': [
    { actor: 'user', epoch: 1, kind: 'prompt', age: '2mo', summary: '"why does token refresh randomly log me out…"', intent: 'why does token refresh randomly log me out when two windows wake from sleep at the same time?', synthesis: 'Investigate multi-window OAuth refresh token rotation race after macOS sleep/wake.', stats: [{ v: '02', l: 'racing tabs' }], artifacts: [], full: 'why does token refresh randomly log me out when two windows wake from sleep at the same time?', trace: ['reproduced multi-tab wake race in fragments.auth'], stdout: [] },
    { actor: 'auth_worker', epoch: 1, kind: 'pty', age: '2mo', summary: 'FAIL · losing tab sends revoked refresh token → 401 logout', intent: 'Trace concurrent refresh calls across two awake windows.', synthesis: 'Tab A rotates the refresh token in Keychain and invalidates token R1; 12ms later Tab B sends R1, gets 401 InvalidGrant, and wipes the Keychain session.', stats: [{ v: '401', l: 'false logout' }], artifacts: [], full: 'Traced the race: both tabs read refresh token R1 on wake. Tab A wins and rotates R1 -> R2. Tab B arrives 12ms later with R1, triggers reuse detection, and clears the user session.', trace: ['test MultiTabWakeRefreshTest → FAIL (session cleared)'], stdout: ['MultiTabWakeRefreshTest → FAIL: expected active session, got null after 12ms race'] },
    { actor: 'auth_worker', epoch: 1, kind: 'mutation', age: '2mo', summary: 'Attempt 1 · file lock around HTTP refresh (REJECTED)', intent: 'Try wrapping signIn/refresh in a cross-process file lock.', synthesis: 'Added a file mutex around network refresh, but blocking I/O froze the Compose UI main thread for 900ms on wake.', stats: [{ v: '900ms', l: 'UI freeze' }], artifacts: [], full: 'Tried a cross-process mutex around the HTTP refresh call, but holding a lock across network I/O stalls the UI thread when offline.', trace: ['edit AuthAndVaultStore.kt · mutex lock', 'test UiResponsivenessTest → FAIL (900ms stall)'], stdout: ['UiResponsivenessTest → FAIL: main thread blocked 912ms > 16ms budget'] },
    { actor: 'user', epoch: 2, kind: 'prompt', age: '2mo', summary: '"stop putting a mutex around network I/O — give a 30s grace…"', intent: 'stop putting a mutex around network I/O — give the rotated refresh token a 30s idempotent grace window in AuthAndVaultStore.', synthesis: 'Revert the blocking mutex and implement a lock-free 30s idempotent grace window in RefreshGraceWindow.kt.', stats: [{ v: '30s', l: 'grace window' }], artifacts: [], full: 'stop putting a mutex around network I/O — give the rotated refresh token a 30s idempotent grace window in AuthAndVaultStore.', trace: ['reverted mutex attempt', 'scoped RefreshGraceWindow.kt'], stdout: [] },
    { actor: 'user', epoch: 2, kind: 'prompt', age: '2mo', summary: '"revert the Redis lock experiment and keep it in Keychain…"', intent: 'revert the Redis lock experiment and keep the grace window strictly in Keychain state.', synthesis: 'Keep `grace:$prevToken -> $nextToken` strictly in local Keychain via VaultService with a 30-second TTL.', stats: [{ v: '0', l: 'external deps' }], artifacts: [], full: 'revert the Redis lock experiment and keep the grace window strictly in Keychain state.', trace: ['enforced local VaultService storage'], stdout: [] },
    { actor: 'auth_worker', epoch: 2, kind: 'decision', decision: '30-second idempotent grace window in Keychain (`grace:$prevToken`) instead of blocking network mutexes', age: '2mo', summary: 'Decision · 30s Keychain grace window in RefreshGraceWindow.kt', intent: 'Serve the newly minted token to any sibling tab presenting the just-rotated token within 30s.', synthesis: 'RefreshGraceWindow.kt caches `grace:$prevToken -> $nextToken` in VaultService for 30s. Concurrent wake tabs converge on the same rotated session without locking.', stats: [{ v: '30s', l: 'idempotent window' }, { v: '02', l: 'files patched' }], artifacts: ['RefreshGraceWindow.kt', 'AuthAndVaultStore.kt'], full: 'Implemented RefreshGraceWindow.kt: when R1 rotates to R2, `grace:R1 -> R2` is stored in Keychain for 30 seconds. Any sibling tab presenting R1 within 30s receives R2 idempotently.', trace: ['write RefreshGraceWindow.kt · +34 / −7', 'edit AuthAndVaultStore.kt · +18 / −5'], stdout: ['./gradlew :fragments.auth:test → 38 passed, 0 failed (MultiTabWakeRefreshTest GREEN)'] },
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
  {
    id: 'cs-litert', task: 'LiteRT-LM int4 KV-Cache Attention Sinks',
    files: [
      {
        name: 'KvCacheQuantizer.ts', adds: 19, dels: 4,
        hunks: [
          { range: 'lines 14–36', fn: 'quantizeKvBlock()', adds: 19, dels: 4, tag: 'kv-cache', state: 'STAGED', line: 14, by: 'qnn_worker', rationale: 'Preserves tokens 0..3 in fp16 as attention sinks so symmetric int4 clipping does not corrupt long-context tool-call JSON grammar.', verification: 'eval tool-call-json @ 16k → 99.8%', lines: [[' ', 'export function quantizeKvBlock(tokens: Float32Array, tokenIdx: number) {'], ['-', '  return packInt4Symmetric(tokens)'], ['+', '  if (tokenIdx < 4) return tokens // keep attention sinks 0..3 in fp16'], ['+', '  return packInt4Symmetric(tokens)'], [' ', '}']] },
        ],
      },
    ],
  },
  {
    id: 'cs-stripe', task: 'Stripe Webhook Idempotency Collision',
    files: [
      {
        name: 'StripeWebhookVerifier.kt', adds: 28, dels: 9,
        hunks: [
          { range: 'lines 42–78', fn: 'verifyAndLock()', adds: 28, dels: 9, tag: 'idempotency', state: 'STAGED', line: 42, by: 'billing_worker', rationale: 'Derives the idempotency lock key from immutable (event.id + livemode) in VaultService instead of the mutable HTTP retry timestamp.', verification: 'StripeRetrySimulationTest → 44 passed', lines: [['-', 'val key = "stripe:ts:${header.timestamp}"'], ['+', 'val key = "stripe:idemp:$eventId:$livemode"'], ['+', 'if (vault.read(key) != null) return false'], ['+', 'vault.store(key, "locked")']] },
        ],
      },
    ],
  },
  {
    id: 'cs-zig', task: 'macOS 26 arm64e Pointer Auth Crash',
    files: [
      {
        name: 'NativeBridgeShim.kt', adds: 24, dels: 6,
        hunks: [
          { range: 'lines 29–58', fn: 'registerSignedCallback()', adds: 24, dels: 6, tag: 'arm64e pac', state: 'STAGED', line: 29, by: 'native_worker', rationale: 'Masks non-canonical PAC bits [63:47] before binding the C callback pointer across JNI on macOS 26.', verification: ':nucleus-macos26:jvmTest → 29 suites green', lines: [['-', 'return nativeBindTrampoline(fnPtr)'], ['+', '// arm64e ptrauth_sign_unauthenticated strip + re-sign'], ['+', 'return nativeBindTrampoline(fnPtr and 0x00007FFFFFFFFFFFL)']] },
        ],
      },
    ],
  },
  {
    id: 'cs-refresh', task: 'OAuth Token Refresh Multi-Tab Race',
    files: [
      {
        name: 'RefreshGraceWindow.kt', adds: 34, dels: 7,
        hunks: [
          { range: 'lines 12–49', fn: 'rotateIdempotent()', adds: 34, dels: 7, tag: 'concurrency', state: 'STAGED', line: 12, by: 'auth_worker', rationale: 'Caches the rotated token under grace:$prevToken for 30s in Keychain so a second tab waking simultaneously receives the new token instead of triggering 401 logout.', verification: 'MultiTabWakeRefreshTest → 38 passed', lines: [['-', 'val next = mintRefreshToken()'], ['-', 'vault.clear(prevToken)'], ['+', 'val cached = vault.read("grace:$prevToken")'], ['+', 'if (cached != null) return cached // 30s multi-tab grace window'], ['+', 'val next = mintRefreshToken()'], ['+', 'vault.store("grace:$prevToken", next)']] },
        ],
      },
      {
        name: 'AuthAndVaultStore.kt', adds: 18, dels: 5,
        hunks: [
          { range: 'lines 88–109', fn: 'refreshSession()', adds: 18, dels: 5, tag: 'keychain', state: 'STAGED', line: 88, by: 'auth_worker', rationale: 'Delegates token rotation to RefreshGraceWindow.rotateIdempotent() without holding a blocking mutex across network I/O.', verification: 'UiResponsivenessTest → <2ms main thread', lines: [['-', 'synchronized(fileLock) { return rotateBlocking(token) }'], ['+', 'val rotated = graceWindow.rotateIdempotent(token, clock.millis())'], ['+', 'return Session(jwt.verify(rotated).sub, jwt.verify(rotated).exp)']] },
        ],
      },
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
