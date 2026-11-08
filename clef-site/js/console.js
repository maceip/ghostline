/**
 * console.js — Surface 2: Operator Control Plane (`clef-site/console.html` / `/console`)
 *
 * Connects to `/v1/telemetry` (SSE stream), `/v1/telemetry/frames`, `/v1/policy`,
 * `/v1/arena/run`, `/v1/guard/rollback`, `/api/calibration`, and `/api/label`.
 * Mounts the Shared Visualizer Core (`ghostline-core.js`) in the Center Inspection Stage.
 */
import {
  renderTokenSalienceStream,
  renderLayerCosineScrubber,
  renderPcaSubspaceCanvas,
  renderCounterfactualClamping,
  fmtSigned,
  escapeHtml,
  isValidTraceFrame,
} from "./ghostline-core.js";

const $ = (id) => document.getElementById(id);

let frames = [];
let selectedTurnId = null;
let activeFilter = "all";
let currentPolicy = {
  mode: "hard-block",
  clamp_alpha: 1.15,
  block_threshold: 0.011,
  decision_layer: 16,
  capabilities: [],
};
let clampCache = new Map();

async function ensureSession() {
  try {
    await fetch("/api/session", { method: "POST", credentials: "same-origin" });
  } catch {}
}

function updateTopBarKpis() {
  const total = frames.length;
  const flagged = frames.filter((f) => f.verdict !== "allow").length;
  const selected = frames.find((f) => f.turn_id === selectedTurnId) || frames.at(-1);

  if ($("con-count-total")) $("con-count-total").textContent = String(total);
  if ($("con-count-flagged")) $("con-count-flagged").textContent = String(flagged);
  if (selected) {
    if ($("con-prefill-ms")) {
      $("con-prefill-ms").textContent = `${(selected.prefill_ms || 0).toFixed(1)} ms`;
    }
    if ($("con-peak-harm")) {
      $("con-peak-harm").textContent = fmtSigned(selected.harm_cosine, 3);
    }
  }
}

function syncModeButtons(mode) {
  for (const btn of document.querySelectorAll("#con-top-modes .con-mode-btn")) {
    btn.classList.toggle("is-active", btn.dataset.mode === mode);
  }
}

function renderCapabilityMatrix() {
  const tbody = $("con-cap-tbody");
  if (!tbody) return;
  const caps = Array.isArray(currentPolicy.capabilities) ? currentPolicy.capabilities : [];
  tbody.innerHTML = caps
    .map(
      (c, idx) => `<tr data-cap-idx="${idx}" data-testid="con-cap-row">
        <td title="${escapeHtml(c.scope)}"><code>${escapeHtml(c.scope.split(" ")[0])}</code></td>
        <td>
          <select class="con-cap-select" data-cap-idx="${idx}" data-testid="con-cap-select">
            <option value="allow" ${c.policy === "allow" ? "selected" : ""}>ALLOW</option>
            <option value="clamp" ${c.policy === "clamp" ? "selected" : ""}>CLAMP</option>
            <option value="hard-block" ${c.policy === "hard-block" ? "selected" : ""}>HARD-BLOCK</option>
          </select>
        </td>
        <td>${fmtSigned(c.max_excess, 3)}</td>
      </tr>`
    )
    .join("");

  for (const sel of tbody.querySelectorAll(".con-cap-select")) {
    sel.addEventListener("change", async () => {
      const idx = Number(sel.dataset.capIdx);
      if (currentPolicy.capabilities[idx]) {
        currentPolicy.capabilities[idx].policy = sel.value;
        await savePolicy({ capabilities: currentPolicy.capabilities });
      }
    });
  }
}

async function savePolicy(patch) {
  try {
    if ($("con-pol-status")) $("con-pol-status").textContent = "SAVING…";
    const res = await fetch("/v1/policy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    currentPolicy = await res.json();
    syncModeButtons(currentPolicy.mode);
    if ($("con-pol-alpha")) $("con-pol-alpha").value = String(currentPolicy.clamp_alpha);
    if ($("con-pol-alpha-val")) {
      $("con-pol-alpha-val").textContent = Number(currentPolicy.clamp_alpha).toFixed(2);
    }
    if ($("con-pol-thresh")) {
      $("con-pol-thresh").value = Number(currentPolicy.block_threshold).toFixed(3);
    }
    renderCapabilityMatrix();
    if ($("con-pol-status")) $("con-pol-status").textContent = `ACTIVE (${currentPolicy.mode.toUpperCase()})`;
  } catch (err) {
    if ($("con-pol-status")) $("con-pol-status").textContent = `ERR: ${String(err).slice(0, 24)}`;
  }
}

function renderTurnList() {
  const listEl = $("con-turn-list");
  if (!listEl) return;

  const filtered = frames
    .slice()
    .reverse()
    .filter((f) => activeFilter === "all" || f.verdict === activeFilter);

  if ($("con-session-count")) {
    $("con-session-count").textContent = `${filtered.length} / ${frames.length} turns`;
  }

  listEl.innerHTML = filtered
    .map((f) => {
      const isSel = f.turn_id === selectedTurnId;
      const vClass =
        f.verdict === "allow"
          ? "is-allow"
          : f.verdict === "clamped"
          ? "is-clamped"
          : "is-blocked";
      return `<button type="button" class="con-turn-item ${
        isSel ? "is-selected" : ""
      }" data-turn-id="${escapeHtml(f.turn_id)}" data-testid="con-turn-item">
        <div class="con-turn-top">
          <span>${escapeHtml(f.session_id || f.turn_id.slice(0, 12))}</span>
          <span class="con-v-badge ${vClass}">${escapeHtml(f.verdict)}</span>
        </div>
        <div class="con-turn-cmd"><code>${escapeHtml(
          f.passes?.proposed_tool_call || f.tool_name
        )}</code></div>
        <div class="con-turn-meta">
          <span>Δ ${fmtSigned(f.harm_excess, 3)}</span>
          <span>${(f.prefill_ms || 0).toFixed(1)} ms · ${escapeHtml(f.mode)}</span>
        </div>
      </button>`;
    })
    .join("");

  for (const item of listEl.querySelectorAll(".con-turn-item")) {
    item.addEventListener("click", () => {
      selectedTurnId = item.dataset.turnId;
      renderTurnList();
      mountSelectedFrame();
    });
  }
}

function mountSelectedFrame() {
  const frame =
    frames.find((f) => f.turn_id === selectedTurnId) || frames.at(-1) || null;
  updateTopBarKpis();
  if (!frame) return;
  selectedTurnId = frame.turn_id;

  const cachedClamp = clampCache.get(frame.turn_id) || null;
  renderTokenSalienceStream($("con-stage-tokens"), frame, {
    onSelectToken: (tokIdx) => {
      renderPcaSubspaceCanvas($("con-stage-pca"), frame, { selectedTokenIdx: tokIdx });
    },
  });
  renderLayerCosineScrubber($("con-stage-layers"), frame);
  renderPcaSubspaceCanvas($("con-stage-pca"), frame);
  renderCounterfactualClamping($("con-stage-clamp"), frame, cachedClamp, {
    onRunClamp: async (nextAlpha, targetFrame) => {
      try {
        const res = await fetch("/v1/guard/rollback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            prompt: targetFrame.passes?.anchor_prompt || "Execute command in workspace.",
            tool_name: targetFrame.tool_name || "bash",
            tool_args: { cmd: targetFrame.passes?.proposed_tool_call || "rm -rf ~/Documents" },
            alpha: nextAlpha,
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = await res.json();
        if (d.clamp_telemetry) {
          clampCache.set(targetFrame.turn_id, d.clamp_telemetry);
          targetFrame.clamp_alpha = nextAlpha;
          if (d.safe_command) {
            targetFrame.passes.steered_tool_call = d.safe_command;
          }
          mountSelectedFrame();
        }
      } catch {}
    },
  });

  if ($("con-cal-cmd") && frame.passes?.proposed_tool_call) {
    $("con-cal-cmd").value = frame.passes.proposed_tool_call;
  }
}

function upsertFrame(newFrame) {
  if (!isValidTraceFrame(newFrame)) return;
  const idx = frames.findIndex((f) => f.turn_id === newFrame.turn_id);
  if (idx >= 0) {
    frames[idx] = newFrame;
  } else {
    frames.push(newFrame);
  }
  selectedTurnId = newFrame.turn_id;
  renderTurnList();
  mountSelectedFrame();
}

async function dispatchLiveProbe(cmdStr) {
  const btn = $("con-quick-send");
  if (btn) btn.disabled = true;
  try {
    const res = await fetch("/v1/arena/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        task_prompt: "Operator Console live verification probe.",
        candidate_command: cmdStr,
        mode: currentPolicy.mode,
        clamp_alpha: currentPolicy.clamp_alpha,
        multi_step: false,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (Array.isArray(data.steps)) {
      for (const s of data.steps) {
        if (s.clamp_telemetry && s.frame) {
          clampCache.set(s.frame.turn_id, s.clamp_telemetry);
        }
        if (s.frame) upsertFrame(s.frame);
      }
    } else if (data.primary_frame) {
      upsertFrame(data.primary_frame);
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function loadCalibrationStudio() {
  try {
    const res = await fetch("/api/calibration", { credentials: "same-origin" });
    if (!res.ok) return;
    const cal = await res.json();
    if ($("con-cal-total")) $("con-cal-total").textContent = `${cal.total_records ?? 0} records`;
    if ($("con-cal-benign-n")) $("con-cal-benign-n").textContent = String(cal.benign_count ?? 0);
    if ($("con-cal-harmful-n")) $("con-cal-harmful-n").textContent = String(cal.harmful_count ?? 0);
    const tau = cal.conformal_alpha_05?.threshold ?? cal.suggested_operating_threshold;
    if ($("con-cal-tau")) {
      $("con-cal-tau").textContent = typeof tau === "number" ? fmtSigned(tau, 3) : "unbounded";
    }
    const feed = $("con-cal-feed");
    if (feed && Array.isArray(cal.records)) {
      feed.innerHTML = cal.records
        .slice(-6)
        .reverse()
        .map((r) => {
          const cmd = r.tool_args?.cmd || r.tool_args?.command || r.tool_name;
          return `<div class="con-cal-row" data-testid="con-cal-row">
            <code>${escapeHtml(String(cmd).slice(0, 26))}</code>
            <strong style="color:${r.label === "benign" ? "#38a169" : "#D71921"}">${escapeHtml(
            r.label.toUpperCase()
          )} (${fmtSigned(r.harm_excess, 3)})</strong>
          </div>`;
        })
        .join("");
    }
  } catch {}
}

async function submitCalibrationLabel(label) {
  const cmd = $("con-cal-cmd")?.value.trim() || "cargo status";
  const statusEl = $("con-cal-status");
  if (statusEl) statusEl.textContent = `Probing & recording ${label}…`;
  try {
    const res = await fetch("/api/label", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        prompt: `Run \`${cmd}\` in the workspace.`,
        tool_name: "bash",
        tool_args: { cmd },
        label,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const out = await res.json();
    await loadCalibrationStudio();
    if (statusEl) {
      statusEl.textContent = `Recorded ${label.toUpperCase()} (Δ=${fmtSigned(
        out.record?.harm_excess,
        3
      )})`;
    }
  } catch (err) {
    if (statusEl) statusEl.textContent = `Error: ${String(err).slice(0, 36)}`;
  }
}

/* ---------- Event Listeners ---------- */
for (const btn of document.querySelectorAll("#con-top-modes .con-mode-btn")) {
  btn.addEventListener("click", () => {
    savePolicy({ mode: btn.dataset.mode });
  });
}

for (const fBtn of document.querySelectorAll("#con-filter-bar .con-filter-btn")) {
  fBtn.addEventListener("click", () => {
    activeFilter = fBtn.dataset.filter || "all";
    document
      .querySelectorAll("#con-filter-bar .con-filter-btn")
      .forEach((b) => b.classList.toggle("is-active", b === fBtn));
    renderTurnList();
  });
}

$("con-quick-send")?.addEventListener("click", () => {
  const cmd = $("con-quick-cmd")?.value.trim() || "rm -rf ~/Documents";
  dispatchLiveProbe(cmd);
});
$("con-quick-cmd")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const cmd = $("con-quick-cmd")?.value.trim() || "rm -rf ~/Documents";
    dispatchLiveProbe(cmd);
  }
});

$("con-pol-alpha")?.addEventListener("input", (e) => {
  if ($("con-pol-alpha-val")) {
    $("con-pol-alpha-val").textContent = Number(e.target.value).toFixed(2);
  }
});

$("con-pol-save")?.addEventListener("click", () => {
  const alpha = Number($("con-pol-alpha")?.value || 1.15);
  const thresh = Number($("con-pol-thresh")?.value || 0.011);
  savePolicy({ clamp_alpha: alpha, block_threshold: thresh });
});

$("con-cal-benign")?.addEventListener("click", () => submitCalibrationLabel("benign"));
$("con-cal-harmful")?.addEventListener("click", () => submitCalibrationLabel("harmful"));

$("con-theme-toggle")?.addEventListener("click", () => {
  const cur = document.documentElement.getAttribute("data-theme") || "dark";
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  $("con-theme-toggle").textContent = next === "dark" ? "LIGHT" : "DARK";
  const logo = $("con-logo");
  if (logo) {
    logo.src =
      next === "light" ? "./assets/logo/lockup-light.png" : "./assets/logo/lockup-dark.png";
  }
});

/* ---------- Startup & Live SSE Telemetry Stream ---------- */
(async () => {
  await ensureSession();
  try {
    const res = await fetch("/v1/telemetry/frames", { credentials: "same-origin" });
    if (res.ok) {
      const data = await res.json();
      if (data.policy) {
        currentPolicy = data.policy;
        syncModeButtons(currentPolicy.mode);
        if ($("con-pol-alpha")) $("con-pol-alpha").value = String(currentPolicy.clamp_alpha);
        if ($("con-pol-alpha-val")) {
          $("con-pol-alpha-val").textContent = Number(currentPolicy.clamp_alpha).toFixed(2);
        }
        if ($("con-pol-thresh")) {
          $("con-pol-thresh").value = Number(currentPolicy.block_threshold).toFixed(3);
        }
        renderCapabilityMatrix();
      }
      if (data.engine?.architecture && $("con-engine-arch")) {
        $("con-engine-arch").textContent = `${data.engine.architecture} · ${data.engine.num_layers}L`;
      }
      if (Array.isArray(data.frames) && data.frames.length > 0) {
        frames = data.frames.filter(isValidTraceFrame);
        selectedTurnId = frames.at(-1)?.turn_id || null;
        renderTurnList();
        mountSelectedFrame();
      }
    }
  } catch {}

  if (frames.length === 0) {
    await dispatchLiveProbe("rm -rf ~/Documents");
  }

  await loadCalibrationStudio();

  // Connect live SSE telemetry stream (/v1/telemetry)
  try {
    const es = new EventSource("/v1/telemetry");
    es.onopen = () => {
      if ($("con-stream-badge")) $("con-stream-badge").textContent = "LIVE · /v1/telemetry";
    };
    es.onmessage = (ev) => {
      try {
        const payload = JSON.parse(ev.data);
        if (payload?.trace_frame && isValidTraceFrame(payload.trace_frame)) {
          upsertFrame(payload.trace_frame);
        }
      } catch {}
    };
  } catch {}
})();
