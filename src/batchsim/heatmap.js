/**
 * Simulation Overlay — BPMN Diagram Visualization
 *
 * Provides rich visual feedback on the diagram after simulation,
 * inspired by professional BPM simulation tools (Bizagi, Signavio, iGrafx):
 *
 * 1. Color-coded element fills (green → yellow → red by performance)
 * 2. KPI badges on tasks showing avg time, wait time, throughput
 * 3. Sequence flow thickness/color by volume
 * 4. Bottleneck pulsing highlight
 * 5. Lane utilization indicators
 *
 * Uses bpmn-js Overlays API for HTML badges and Canvas markers for CSS fills.
 */

const OVERLAY_TYPE = "sim-overlay";
const MARKER_CLASSES = [
  "sim-perf-good",
  "sim-perf-ok",
  "sim-perf-warn",
  "sim-perf-bad",
  "sim-bottleneck",
  "sim-flow-1",
  "sim-flow-2",
  "sim-flow-3",
  "sim-flow-4",
  "sim-hot-1",
  "sim-hot-2",
  "sim-hot-3",
  "sim-hot-4",
];

// ─── Time formatting (same as dashboard) ─────────────────────────────
function fmtTime(minutes) {
  if (minutes == null || !Number.isFinite(minutes) || minutes <= 0) return "—";
  if (minutes < 1) return `${(minutes * 60).toFixed(0)}s`;
  if (minutes < 60) return `${minutes.toFixed(1)}m`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m > 0 ? `${h}h${m}m` : `${h}h`;
}

function fmtInt(v) {
  if (v == null || v === 0) return "0";
  return v.toLocaleString("pt-BR");
}

// ─── Clear all overlays and markers ──────────────────────────────────
export function clearHeatmap(canvas, elementRegistry) {
  // Remove CSS markers
  const allElements = elementRegistry.getAll();
  for (const el of allElements) {
    for (const cls of MARKER_CLASSES) {
      try {
        canvas.removeMarker(el.id, cls);
      } catch (_) {
        /* element may not exist in canvas */
      }
    }
  }

  // Remove HTML overlays
  try {
    const overlays = canvas._container?.closest(".djs-container")
      ?.__overlays || canvas._overlays;
    // Fallback: remove by DOM
    const container = canvas._container || document.querySelector(".djs-container");
    if (container) {
      container
        .querySelectorAll(".sim-overlay-badge, .sim-overlay-lane")
        .forEach((el) => el.remove());
    }
  } catch (_) {
    /* no-op */
  }
}

/**
 * Remove overlays from the Overlays service (bpmn-js).
 */
export function clearOverlays(overlays) {
  if (!overlays) return;
  try {
    overlays.remove({ type: OVERLAY_TYPE });
  } catch (_) {
    /* fallback if type filter unsupported */
    try {
      const all = document.querySelectorAll(
        ".sim-overlay-badge, .sim-overlay-lane",
      );
      all.forEach((el) => el.remove());
    } catch (_2) {
      /* no-op */
    }
  }
}

// ─── Apply the full simulation overlay ───────────────────────────────
/**
 * @param {Object} opts
 * @param {Object} opts.canvas - bpmn-js canvas
 * @param {Object} opts.elementRegistry - bpmn-js elementRegistry
 * @param {Object} opts.overlays - bpmn-js overlays service
 * @param {Map} opts.elementsCounts - Map(elementId → visit count)
 * @param {Map} opts.flowCounts - Map(flowId → traversal count)
 * @param {Array} opts.elementMetrics - from computeMetrics
 * @param {Array} opts.resourceMetrics - from computeMetrics
 * @param {Array} opts.bottlenecks - from computeMetrics
 * @param {string} opts.mode - "kpi" | "heat" | "flow" (default: "kpi")
 */
export function applyHeatmap(opts) {
  const {
    canvas,
    elementRegistry,
    overlays,
    elementsCounts,
    flowCounts,
    elementMetrics,
    resourceMetrics,
    bottlenecks,
    mode = "kpi",
  } = opts;

  // Always apply flow thickness
  applyFlowOverlay(canvas, elementRegistry, flowCounts);

  if (mode === "heat") {
    applyHeatBins(canvas, elementRegistry, elementsCounts);
  } else if (mode === "kpi" && elementMetrics) {
    applyKpiOverlay(canvas, elementRegistry, overlays, elementMetrics, bottlenecks);
    if (resourceMetrics && overlays) {
      applyLaneUtilization(overlays, elementRegistry, resourceMetrics);
    }
  } else {
    // Fallback: basic heat bins
    applyHeatBins(canvas, elementRegistry, elementsCounts);
  }
}

// ─── Flow thickness & color by volume ────────────────────────────────
function applyFlowOverlay(canvas, elementRegistry, flowCounts) {
  if (!flowCounts || flowCounts.size === 0) return;
  const max = Math.max(1, ...Array.from(flowCounts.values()));

  for (const el of elementRegistry.getAll()) {
    const count = flowCounts.get(el.id) || 0;
    if (count === 0) continue;
    const norm = count / max;
    const b = norm < 0.25 ? 1 : norm < 0.5 ? 2 : norm < 0.75 ? 3 : 4;
    canvas.addMarker(el.id, `sim-flow-${b}`);
  }
}

// ─── Classic heat bins (opacity-based) ───────────────────────────────
function applyHeatBins(canvas, elementRegistry, elementsCounts) {
  if (!elementsCounts || elementsCounts.size === 0) return;
  const max = Math.max(1, ...Array.from(elementsCounts.values()));

  for (const el of elementRegistry.getAll()) {
    const count = elementsCounts.get(el.id) || 0;
    if (count === 0) continue;
    const norm = count / max;
    const b = norm < 0.25 ? 1 : norm < 0.5 ? 2 : norm < 0.75 ? 3 : 4;
    canvas.addMarker(el.id, `sim-hot-${b}`);
  }
}

// ─── KPI badges on tasks (like Bizagi/Signavio) ──────────────────────
function applyKpiOverlay(canvas, elementRegistry, overlays, elementMetrics, bottlenecks) {
  if (!elementMetrics || elementMetrics.length === 0) return;

  const metricsMap = new Map();
  for (const m of elementMetrics) {
    metricsMap.set(m.elementId, m);
  }
  const bottleneckIds = new Set((bottlenecks || []).map((b) => b.elementId));

  // Determine max values for performance coloring
  const tasks = elementMetrics.filter(
    (m) => m.elementType.endsWith("Task") || m.elementType === "bpmn:Task",
  );
  const maxAvg = Math.max(1, ...tasks.map((m) => m.avgTime));
  const maxWait = Math.max(1, ...tasks.map((m) => m.avgWaitTime || 0));

  for (const el of elementRegistry.getAll()) {
    const m = metricsMap.get(el.id);
    if (!m) continue;
    if (!m.elementType.endsWith("Task") && m.elementType !== "bpmn:Task") continue;
    if (m.visits === 0 && m.totalTime === 0) continue;

    const isBottleneck = bottleneckIds.has(el.id);

    // Color coding: based on relative wait time
    const waitRatio = maxWait > 0 ? (m.avgWaitTime || 0) / maxWait : 0;
    if (isBottleneck) {
      canvas.addMarker(el.id, "sim-bottleneck");
    } else if (waitRatio > 0.7) {
      canvas.addMarker(el.id, "sim-perf-bad");
    } else if (waitRatio > 0.4) {
      canvas.addMarker(el.id, "sim-perf-warn");
    } else if (waitRatio > 0.15) {
      canvas.addMarker(el.id, "sim-perf-ok");
    } else {
      canvas.addMarker(el.id, "sim-perf-good");
    }

    // HTML badge overlay
    if (overlays) {
      const badgeHtml = createBadge(m, isBottleneck);
      try {
        overlays.add(el.id, OVERLAY_TYPE, {
          position: { bottom: -4, right: -4 },
          html: badgeHtml,
        });
      } catch (_) {
        /* element may not support overlays */
      }
    }
  }
}

function createBadge(m, isBottleneck) {
  const cls = isBottleneck ? "sim-overlay-badge sim-overlay-badge--bottleneck" : "sim-overlay-badge";
  const waitLine =
    (m.avgWaitTime || 0) > 0
      ? `<div class="sim-overlay-badge__row"><span class="sim-overlay-badge__icon">⏳</span>${fmtTime(m.avgWaitTime)}</div>`
      : "";

  const div = document.createElement("div");
  div.className = cls;
  div.innerHTML = `
    <div class="sim-overlay-badge__row"><span class="sim-overlay-badge__icon">⏱</span>${fmtTime(m.avgTime)}</div>
    ${waitLine}
    <div class="sim-overlay-badge__row sim-overlay-badge__row--count"><span class="sim-overlay-badge__icon">×</span>${fmtInt(m.visits)}</div>
  `;
  div.title = `${m.elementName || m.elementId}\nDuração média: ${fmtTime(m.avgTime)}\nEspera média: ${fmtTime(m.avgWaitTime || 0)}\nExecuções: ${fmtInt(m.visits)}${isBottleneck ? "\n⚠️ GARGALO" : ""}`;
  return div;
}

// ─── Lane utilization badges ─────────────────────────────────────────
function applyLaneUtilization(overlays, elementRegistry, resourceMetrics) {
  if (!resourceMetrics || resourceMetrics.length === 0) return;

  for (const r of resourceMetrics) {
    // Try to find the lane element in the registry
    const laneEl = elementRegistry.get(r.laneId);
    if (!laneEl) continue;

    const pct = (r.utilization * 100).toFixed(0);
    const cls = r.isOverloaded
      ? "sim-overlay-lane sim-overlay-lane--over"
      : r.isUnderused
        ? "sim-overlay-lane sim-overlay-lane--idle"
        : "sim-overlay-lane sim-overlay-lane--ok";

    const div = document.createElement("div");
    div.className = cls;
    div.innerHTML = `<span class="sim-overlay-lane__pct">ρ ${pct}%</span><span class="sim-overlay-lane__cap">${r.capacity}×</span>`;
    div.title = `${r.name}\nUtilização: ${pct}%\nCapacidade: ${r.capacity}\nEspera média: ${fmtTime(r.avgWait)}`;

    try {
      overlays.add(r.laneId, OVERLAY_TYPE, {
        position: { top: 4, left: 4 },
        html: div,
      });
    } catch (_) {
      /* lane may not be in registry */
    }
  }
}
