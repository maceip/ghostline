# COPY-SOURCES.md — phrase provenance for `index.html`

Every rhetorical phrase on the page is drawn from one of four sources. Product
nouns and measured values are marked **[P]** (they describe this product and
appear in no external copy). Connector words and grammar are the joinery.

**Sources**

| Tag | URL |
|---|---|
| **XB** | `https://docs.xbow.com/` — Console guide, Get started → Introduction, section titles |
| **BT** | `https://docs.braintrust.dev/` — Get started index, `workflow.md` |
| **DT** | `https://www.daytona.io/docs/en/` — Documentation home |
| **CF** | `https://blog.cloudflare.com/rewinding-the-exponential` |

---

## Document head

| String | Source | Original phrase |
|---|---|---|
| `CLEF — automated assessment for AI-generated code` | XB + DT | “automated penetration testing and security assessments” / “AI-generated code” |
| meta description: “provides automated assessment for agent tool calls” | XB | “XBOW Console provides automated penetration testing…” |
| “evidence-based findings” | XB | “provides evidence-based findings” |
| “an audit trail of assessment activity” | XB | exact (Introduction) |
| “automatic and configurable security measures” | XB | exact (Introduction) |
| “from code to execution” | DT | exact (“spinning up in under 90ms from code to execution”) |

## Strip / chrome

| String | Source | Original phrase |
|---|---|---|
| `CLEF` `CLF.0S1` | [P] | product name and build stamp |
| `FROM CODE TO EXECUTION` | DT | exact |
| `QWEN2.5-0.5B · 24 LAYERS · PROBE 16` | [P] | measured model facts |
| `DARK` / `LIGHT` | [P] | control labels |
| `REPLAY · 36 AUDIT EVENTS` | XB | “Audit events” (Reference section title) |

## Hero

| String | Source | Original phrase |
|---|---|---|
| eyebrow `AUTOMATED ASSESSMENT · ACTIVE OBSERVABILITY` | XB + BT | “automated … security assessments” / “the active observability platform” |
| H1 `KEEP YOUR ASSET SAFE FROM CODE TO EXECUTION.` | XB + DT | “keep your asset safe during an assessment” / “from code to execution” |
| kicker `capture traces from your AI application` | BT | exact (workflow, Instrument) |
| deck `Clef applies representation engineering to agent traces` | [P] + BT | “representation engineering” (product tech, mandated) + “agent traces” |
| deck `Capture traces from your AI application` | BT | exact |
| deck `surfacing recurring behavior and discovering issues` | BT | “surfacing recurring behavior, and discovering issues” (workflow, Observe) |
| deck `keep your asset safe from code to execution` | XB + DT | “keep your asset safe” / “from code to execution” |
| deck `Automatic and configurable security measures` | XB | exact |
| deck `without compromising data quality` | CF | exact |
| CTA `RUN AN ASSESSMENT` | XB | “Run assessment” (How-to title) |
| CTA `INTERPRETING RESULTS` | XB | “Interpreting results” (Guidance title) |
| stats labels `probe` `findings blocked` `false positives` `generation tokens` | [P] + XB | metric names; “findings” per XB “Findings” |
| field caption `RESIDUAL STREAM · 24 DECODER LAYERS` | [P] | product structure |

## 01 — Structured workflow

| String | Source | Original phrase |
|---|---|---|
| `01 — STRUCTURED WORKFLOW` | BT | “a structured workflow that helps you measure, understand, and improve” |
| h2 `Measure, understand, and improve.` | BT | exact |
| h2 accent `Backed by quantitative data.` | BT | exact (Evaluate outcome) |
| label `EVIDENCE-BASED FINDINGS` | XB | exact |
| body `The platform validates exploitable vulnerabilities and provides evidence-based findings to help you prioritize the most urgent findings to fix.` | XB | exact (Introduction) |
| body `Readings pool the residual state over the tool-call span at 68% depth.` | [P] | product mechanics |
| label `AN AUDIT TRAIL` | XB | “An audit trail of assessment activity” |
| body `An audit trail of assessment activity.` | XB | exact |
| body `Traces record inputs, outputs, model parameters, latency, token usage, and other metadata for every request.` | BT | exact (Instrument) |
| body `an unbiased estimate for that prompt` | CF | “unbiased estimate” |
| label `FROM CODE TO EXECUTION` | DT | exact |
| body `Consistent, predictable environments for AI agent workflows.` | DT | “consistent, predictable environments for AI, agent and reinforcement learning workflows” |
| body `Support more than 1.5x the amount of traffic with the same size pipe` | CF | exact |
| body `without compromising data quality` | CF | exact |

## 02 — Impact

| String | Source | Original phrase |
|---|---|---|
| `02 — IMPACT` | CF | `## Impact` (section title) |
| `17/18 findings blocked. 0/18 false positives.` | [P] | measured capture numbers |
| footnote `an audit trail of assessment activity` | XB | exact |
| `explore results` | XB | “Explore and fix results” (How-to title) |
| `The one finding that passed is kept in the dataset.` | XB + BT | “findings” / “curated datasets” |
| compare CLEF `0 generation tokens` | [P] | measured |
| compare CLEF `consistent, predictable environments` | DT | exact |
| compare CLEF `without compromising data quality` | CF | exact |
| compare `LLM-AS-JUDGE` column | BT + CF | “small changes to prompts, models, or data can have unpredictable effects on quality” / “the trade-off was worth it” |
| measure rows `31/40` `7/8` `896` and labels | [P] + XB | measured benchmark numbers; “findings”, “traffic” |
| `introspected from safetensors headers — no manual config` | [P] | product behavior |

## 03 — Attack surface

| String | Source | Original phrase |
|---|---|---|
| `03 — ATTACK SURFACE` | XB | “control the attack surface” (Security expert introduction) |
| h2 `Broader attack coverage.` | XB | exact (Introduction) |
| h2 accent `Validates exploitable vulnerabilities.` | XB | exact |
| lede `Automated testing enables faster turnaround times and broader attack coverage than most manual tests, and may identify vulnerabilities that were not detected by manual testing.` | XB | exact (Introduction) |
| card `SEVERITY NONE · PASSED` / `SEVERITY CRITICAL · BLOCKED` | XB | “Severity levels” (Reference) |
| card body `Evidence-based findings, backed by quantitative data.` | XB + BT | exact phrases |
| card body `The platform identifies security vulnerabilities and validates exploitable vulnerabilities.` | XB | exact (Introduction) |
| card commands and prompts | [P] | real rows from `data/replay.json` |
| footnote `Vulnerability classification` | XB | exact (Reference) |
| cluster names `filesystem destruction · secret reading · network exfiltration` | [P] | product taxonomy |

## 04 — Console

| String | Source | Original phrase |
|---|---|---|
| h2 `Run an assessment. Monitor the results.` | XB | “Run assessment” / “Monitor assessment” (How-to titles) |
| lede `Get oriented in Console` | XB | “Get oriented in XBOW Console” (Console quickstart) |
| `explore and fix results` | XB | “Explore and fix results” |
| `an audit trail of assessment activity` | XB | exact |
| `backed by quantitative data` | BT | exact |
| chips `36 AUDIT EVENTS` / `GOVERNANCE AND VISIBILITY` | XB + [P] | “Audit events” / “governance and visibility needs” |
| `RISK SCORE THRESHOLD` | XB | “Risk score” (Reference) |
| `EXECUTION OPTIONS` | XB | “Set execution options” (How-to) |
| `target protection` | XB | “Target protection” (Reference) |
| `SCOPE CONFIGURATION` | XB | “Scope configuration” (Reference) |
| `an unbiased estimate for that prompt` | CF | “unbiased estimate” |
| `VULNERABILITY CLASSIFICATION` | XB | exact (Reference) |
| `attack methods` | XB | “Attack methods” (Reference) |
| `PROVIDE ASSET CONTEXT` | XB | “Provide asset context” (How-to) |
| `ASSESS` button | XB | “Run assessment” |
| `[ ACCESS REQUIREMENTS ]` | XB | “Access requirements” (Reference) |
| `RISK SCORE` `FINDING` `AUDIT EVENTS` | XB | Reference section titles |
| `LAYER SPINE` `PCA SUBSPACE` `HARM COSINE × DEPTH` `PC1·PC2·PC3` | [P] | instrument names |
| `ENFORCE` / `MONITOR` / `PANEL` / `OFF` / `DESTROY` / `STEAL` / `EXFIL` | [P] | control values (CLI/API surface) |
| `operating point 0.002 · harm_excess ≥ thr` | [P] | measured operating point + rule |

## 05 — Interpreting results

| String | Source | Original phrase |
|---|---|---|
| `05 — INTERPRETING RESULTS` | XB | “Interpreting results” (Guidance title) |
| h2 `Measure, understand, and improve — on every request.` | BT + XB | BT exact + XB “for every request” cadence |
| step `Instrument` + `Capture detailed traces from your AI application.` | BT | workflow stage + exact |
| step `Observe` + `Analyze your application’s behavior by exploring logs, surfacing recurring behavior, and discovering issues` | BT | workflow stage + exact |
| step `Evaluate` + `Test changes systematically, backed by quantitative data.` | BT | “Test changes systematically” + “backed by quantitative data” |
| step `Annotate` + `An unbiased estimate for that prompt.` | BT + CF | workflow stage + “unbiased estimate” |
| step `Deploy` + `Validated findings, evidence-based.` | BT + XB | “Ship validated changes” / “evidence-based findings” |
| step mechanics (layer 16, tool-call span, cluster centroids, baseline) | [P] | product mechanics |
| `RISK SCORE` rule formula | [P] | real decision rule |

## 06 — Integrations

| String | Source | Original phrase |
|---|---|---|
| `06 — INTEGRATIONS` | XB | “Integrations” (top-level docs section) |
| h2 `Build integrations. Automate workflows.` | XB | “Build integrations, automate workflows, and extend platform capabilities” |
| `Agents and developers interact with Clef programmatically using the SDKs, API, and CLI.` | DT | “Agents and developers interact with sandboxes programmatically using the SDKs, API, and CLI” (product noun swapped) |
| `An audit trail of assessment activity. Explore and fix results from the audit stream` | XB | exact phrases |
| `Call any AI provider through a unified interface.` | BT | exact (Deploy) |
| `GET STARTED` | XB/BT/DT | shared section title |
| endpoint and CLI snippets | [P] | real API surface |

## 07 — Troubleshooting

| String | Source | Original phrase |
|---|---|---|
| `07 — TROUBLESHOOTING ASSESSMENTS` | XB | “Troubleshooting assessments” (Reference title) |
| h2 `What to expect from Clef testing.` | XB | “What to expect from XBOW testing” (Introduction heading) |
| Q `Test result quality depends on asset quality` | XB | exact heading |
| Q `What to expect from Clef testing` | XB | exact heading |
| Q `Why you should trust Clef with your asset` | XB | “Why you should trust XBOW with your asset” |
| Q `Representative sample` | CF | exact |
| Q `Get started` | XB/BT/DT | shared |
| answer `faster turnaround times and broader attack coverage than most manual tests, and findings that were not detected by manual testing` | XB | exact (noun “vulnerabilities” → “findings”) |
| answer `Automatic and configurable security measures to keep your asset safe during an assessment. An audit trail of assessment activity.` | XB | exact |
| answer `We’re not compromising the quality of data delivered, even when we deliver less in quantity.` | CF | exact |
| answer `Agents and developers interact with Clef programmatically using the SDKs, API, and CLI.` | DT | exact (product noun swapped) |
| answer mechanics (thresholds transfer, id_rsa.pub, five benign calls) | [P] | real capture + engine behavior |

## Footer

| String | Source | Original phrase |
|---|---|---|
| `SECURE AND ELASTIC INFRASTRUCTURE FOR AI-GENERATED CODE` | DT | “a secure and elastic infrastructure for running AI-generated code” |
| `TRUST AND SAFETY` | XB | exact (Get started title) |
| `keep your asset safe during an assessment. An audit trail of assessment activity.` | XB | exact |
| `CLF.0S1 · VERSION 0.01 · © 2026` | [P] | build stamp |
| `From code to execution.` | DT | exact |
| `REFERENCE` file list | [P] | repository paths |

---

### Note on [P] items

Product nouns (Clef, representation engineering, residual stream, tool-call
span, harm_cosine, endpoint paths, CLI flags), measured numbers (17/18, 31/40,
7/8, 896, 0.002, 150 ms), and the decision-rule formula cannot be sourced from
the four references — they name this product’s real surface and data. Every
other phrase on the page is in the tables above.
