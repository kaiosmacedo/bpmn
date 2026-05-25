/**
 * Simulation Integration Module
 *
 * Bridges the BPMN modeler with the batch simulation engine,
 * structured logger, metrics calculator and dashboard.
 */

import BpmnModdle from "bpmn-moddle";

import { buildGraph } from "./graph.js";
import { runBatch } from "./engine.js";
import { mulberry32, toCsv, downloadText } from "./utils.js";
import { applyHeatmap, clearHeatmap } from "./heatmap.js";
import { computeMetrics } from "./metrics.js";
import { buildStructuredLog } from "./logger.js";
import { createDashboard, renderDashboard } from "./dashboard.js";
import { SimulationStatus, createSimulationRun } from "./models.js";

import "./dashboard.css";

/**
 * Create and bind simulation controls + dashboard to the modeler.
 *
 * @param {Object} modeler - bpmn-js Modeler instance
 */
export function bindSimulation(modeler) {
  let currentRun = null;
  let dashboard = null;

  // ── Guard against duplicate DOM (if bindSimulation called more than once) ──
  const existingPanel = document.querySelector(".sim-controls");
  if (existingPanel) existingPanel.remove();
  const existingDash = document.getElementById("sim-dashboard");
  if (existingDash) existingDash.remove();

  // ── Build simulation controls panel ──
  const panel = createControlPanel();
  document.body.appendChild(panel);

  // ── Create dashboard (hidden by default) ──
  dashboard = createDashboard();
  document.body.appendChild(dashboard);

  // ── Wire CSV export from dashboard ──
  dashboard.querySelector("#sim-dash-export").addEventListener("click", () => {
    if (!currentRun || !currentRun.rawResults) return;
    exportCsv(currentRun);
  });

  // ── References ──
  const els = {
    collapse: panel.querySelector("#sim-ctrl-collapse"),
    replications: panel.querySelector("#sim-replications"),
    seed: panel.querySelector("#sim-seed"),
    maxTime: panel.querySelector("#sim-max-time"),
    arrivalType: panel.querySelector("#sim-arrival-type"),
    arrivalValue: panel.querySelector("#sim-arrival-value"),
    btnRun: panel.querySelector("#sim-btn-run"),
    btnStop: panel.querySelector("#sim-btn-stop"),
    btnDash: panel.querySelector("#sim-btn-dashboard"),
    btnClearHeat: panel.querySelector("#sim-btn-clear-heat"),
    btnLoadCfg: panel.querySelector("#sim-btn-load-cfg"),
    fileCfg: panel.querySelector("#sim-file-cfg"),
    status: panel.querySelector("#sim-ctrl-status"),
  };

  // Collapse toggle
  els.collapse.addEventListener("click", () => {
    panel.classList.toggle("is-collapsed");
    els.collapse.textContent = panel.classList.contains("is-collapsed")
      ? "▸"
      : "▾";
  });

  // Load external config — the <label> already triggers the hidden input natively;
  // no extra click() call needed (would open the dialog twice).
  els.fileCfg.addEventListener("change", async (ev) => {
    const f = ev.target.files?.[0];
    if (!f) return;
    try {
      const cfg = JSON.parse(await f.text());
      if (cfg.replications) els.replications.value = cfg.replications;
      if (cfg.seed) els.seed.value = cfg.seed;
      if (cfg.maxSimTime) els.maxTime.value = cfg.maxSimTime;
      if (cfg.caseArrival) {
        els.arrivalType.value = cfg.caseArrival.type || "exponential";
        els.arrivalValue.value =
          cfg.caseArrival.mean || cfg.caseArrival.value || 5;
      }
      // Store full config for use during run
      panel._loadedCfg = cfg;
      const resCount = Object.keys(cfg.resources || {}).length;
      const actCount = Object.keys(cfg.activityDurations || {}).length;
      const flowDelays = Object.keys(cfg.messageFlowDelays || {}).length;
      setStatus(
        els.status,
        `✅ Config: ${f.name}\n` +
        `• Replicações: ${cfg.replications || '?'}\n` +
        `• Tempo máx: ${cfg.maxSimTime || '?'}\n` +
        `• Recursos (lanes): ${resCount}\n` +
        `• Durações por atividade: ${actCount}\n` +
        `• Delays em message-flows: ${flowDelays}`,
      );
    } catch (e) {
      console.error(e);
      setStatus(els.status, "Erro ao carregar configuração.");
    } finally {
      els.fileCfg.value = "";
    }
  });

  // Run simulation
  els.btnRun.addEventListener("click", () =>
    runSimulation(modeler, panel, els, dashboard),
  );

  // Stop / Reset
  els.btnStop.addEventListener("click", () => {
    if (currentRun) currentRun.status = SimulationStatus.IDLE;
    const canvas = modeler.get("canvas");
    const elementRegistry = modeler.get("elementRegistry");
    clearHeatmap(canvas, elementRegistry);
    setStatus(els.status, "Simulação resetada.");
  });

  // Show dashboard
  els.btnDash.addEventListener("click", () => {
    if (!currentRun || !currentRun.metrics) {
      setStatus(els.status, "Execute uma simulação primeiro.");
      return;
    }
    dashboard.classList.remove("is-hidden");
  });

  // Clear heatmap
  els.btnClearHeat.addEventListener("click", () => {
    const canvas = modeler.get("canvas");
    const elementRegistry = modeler.get("elementRegistry");
    clearHeatmap(canvas, elementRegistry);
    setStatus(els.status, "Heatmap limpo.");
  });

  // ── Run simulation function ──
  async function runSimulation(modeler, panel, els, dashboard) {
    try {
      els.btnRun.disabled = true;
      setStatus(els.status, "Extraindo modelo BPMN...");

      // 1) Get current BPMN XML from modeler
      const { xml } = await modeler.saveXML({ format: true });

      // 2) Parse with moddle
      const moddle = new BpmnModdle();
      const { rootElement: definitions } = await moddle.fromXML(xml);
      const graph = buildGraph(definitions);

      // 3) Build config from panel inputs + loaded cfg
      const baseCfg = panel._loadedCfg || {};
      const cfg = {
        ...baseCfg,
        replications: parseInt(els.replications.value) || 10,
        seed: parseInt(els.seed.value) || 2026,
        maxSimTime: parseInt(els.maxTime.value) || 480,
        startEventId: baseCfg.startEventId || graph.startEvents[0],
        scenarioId: baseCfg.scenarioId || "modeler-sim",
        caseArrival: baseCfg.caseArrival || {
          type: els.arrivalType.value || "exponential",
          [els.arrivalType.value === "fixed" ? "value" : "mean"]:
            parseFloat(els.arrivalValue.value) || 5,
        },
      };

      // 4) Create simulation run
      currentRun = createSimulationRun(cfg);
      currentRun.status = SimulationStatus.RUNNING;
      currentRun.startedAt = new Date().toISOString();

      setStatus(els.status, `Simulando... Replicações: ${cfg.replications}`);

      // 5) Run batch simulation (yielding to UI with setTimeout)
      await new Promise((r) => setTimeout(r, 50));

      const rngFactory = (seed) => mulberry32(seed);
      const rawResults = await runBatch({ graph, cfg, rng: rngFactory });

      currentRun.rawResults = rawResults;

      // 6) Build structured log
      setStatus(els.status, "Construindo log estruturado...");
      currentRun.log = buildStructuredLog(
        rawResults.eventsRows,
        graph.elementsById,
        cfg,
      );

      // 7) Compute metrics
      setStatus(els.status, "Calculando métricas...");
      const metricsCfg = { ...cfg, _laneOfElement: graph.laneOfElement };
      currentRun.metrics = computeMetrics(
        rawResults,
        graph.elementsById,
        metricsCfg,
      );

      currentRun.status = SimulationStatus.COMPLETED;
      currentRun.endedAt = new Date().toISOString();

      // 8) Apply heatmap
      const canvas = modeler.get("canvas");
      const elementRegistry = modeler.get("elementRegistry");

      const elementCounts = new Map();
      const flowCounts = new Map();
      for (const row of rawResults.eventsRows) {
        if (row.eventType === "enter" && row.elementId) {
          elementCounts.set(
            row.elementId,
            (elementCounts.get(row.elementId) || 0) + 1,
          );
        }
        if (row.eventType === "leave" && row.flowId) {
          flowCounts.set(row.flowId, (flowCounts.get(row.flowId) || 0) + 1);
        }
      }

      clearHeatmap(canvas, elementRegistry);
      applyHeatmap({
        canvas,
        elementRegistry,
        elementsCounts: elementCounts,
        flowCounts,
      });

      // 9) Show results
      const m = currentRun.metrics;
      const cte = ((m.cycleTimeEfficiency || 0) * 100).toFixed(1);
      const overloaded = (m.resourceMetrics || []).filter((r) => r.isOverloaded).length;
      setStatus(
        els.status,
        `✅ Concluído!\n` +
          `Replicações: ${cfg.replications}\n` +
          `Casos: ${m.completedCases}/${m.totalCases}\n` +
          `Ciclo médio: ${m.avgCycleTime.toFixed(2)}\n` +
          `P90/P95: ${(m.p90CycleTime||0).toFixed(2)} / ${(m.p95CycleTime||0).toFixed(2)}\n` +
          `Throughput λ: ${m.throughput.toFixed(4)}\n` +
          `WIP médio: ${m.avgWip.toFixed(2)}\n` +
          `CTE: ${cte}%\n` +
          `Recursos saturados: ${overloaded}\n` +
          `Gargalos: ${m.bottlenecks.length}\n` +
          `Log: ${currentRun.log.length} entradas`,
      );

      // 10) Render dashboard
      renderDashboard(dashboard, currentRun);
    } catch (e) {
      console.error("Erro na simulação:", e);
      if (currentRun) currentRun.status = SimulationStatus.ERROR;
      setStatus(els.status, `❌ Erro: ${e.message}`);
    } finally {
      els.btnRun.disabled = false;
    }
  }
}

function exportCsv(run) {
  const raw = run.rawResults;
  const prefix = run.parameters.scenarioId || "simulation";

  if (raw.eventsRows?.length)
    downloadText(`events_${prefix}.csv`, toCsv(raw.eventsRows), "text/csv");
  if (raw.summaryRows?.length)
    downloadText(`summary_${prefix}.csv`, toCsv(raw.summaryRows), "text/csv");
  if (raw.casesRows?.length)
    downloadText(`cases_${prefix}.csv`, toCsv(raw.casesRows), "text/csv");
  if (raw.taskRows?.length)
    downloadText(`tasks_${prefix}.csv`, toCsv(raw.taskRows), "text/csv");
  if (raw.pathRows?.length)
    downloadText(`paths_${prefix}.csv`, toCsv(raw.pathRows), "text/csv");

  // Export structured log
  if (run.log?.length) {
    const logRows = run.log.map((e) => ({
      seq: e.seq,
      eventType: e.eventType,
      simTime: e.simTime,
      caseId: e.caseId,
      tokenId: e.tokenId,
      elementId: e.elementId,
      elementName: e.elementName,
      message: e.message,
      level: e.level,
    }));
    downloadText(`log_${prefix}.csv`, toCsv(logRows), "text/csv");
  }
}

function setStatus(el, text) {
  el.textContent = text;
}

function createControlPanel() {
  const panel = document.createElement("div");
  panel.className = "sim-controls is-collapsed";
  panel.innerHTML = `
    <div class="sim-controls__header">
      <div class="sim-controls__title">
        <span>🔬 Simulação</span>
        <span style="font-size:10px;font-weight:900;padding:3px 7px;border-radius:999px;background:rgba(11,102,195,0.14);border:1px solid rgba(11,102,195,0.22);color:#0b3b72;">Batch</span>
      </div>
      <button id="sim-ctrl-collapse" style="width:30px;height:30px;border-radius:10px;border:1px solid rgba(15,23,42,0.14);background:rgba(255,255,255,0.9);cursor:pointer;" title="Expandir / minimizar">▸</button>
    </div>

    <div class="sim-controls__body">
      <div class="sim-controls__form">
        <div class="sim-controls__field">
          <label>Replicações</label>
          <input id="sim-replications" type="number" value="10" min="1" max="10000" />
        </div>
        <div class="sim-controls__field">
          <label>Seed</label>
          <input id="sim-seed" type="number" value="2026" />
        </div>
        <div class="sim-controls__field">
          <label>Tempo máximo</label>
          <input id="sim-max-time" type="number" value="480" min="1" />
        </div>
        <div class="sim-controls__field">
          <label>Chegada (tipo)</label>
          <select id="sim-arrival-type">
            <option value="exponential">Exponencial</option>
            <option value="fixed">Fixo</option>
            <option value="uniform">Uniforme</option>
            <option value="normal">Normal</option>
          </select>
        </div>
        <div class="sim-controls__field" style="grid-column: span 2;">
          <label>Valor (mean/value)</label>
          <input id="sim-arrival-value" type="number" value="5" min="0" step="0.1" />
        </div>
      </div>

      <div class="sim-controls__buttons">
        <button id="sim-btn-run" class="sim-controls__btn sim-controls__btn--primary" title="Iniciar simulação">
          ▶ Simular
        </button>
        <button id="sim-btn-stop" class="sim-controls__btn sim-controls__btn--danger" title="Resetar">
          ⏹ Resetar
        </button>
      </div>

      <div class="sim-controls__row">
        <button id="sim-btn-dashboard" class="sim-controls__btn" title="Abrir dashboard de resultados">
          📊 Dashboard
        </button>
        <button id="sim-btn-clear-heat" class="sim-controls__btn" title="Limpar heatmap do diagrama">
          🧹 Limpar
        </button>
      </div>

      <div class="sim-controls__row">
        <label id="sim-btn-load-cfg" class="sim-controls__btn" style="cursor:pointer;justify-content:center;">
          📂 Carregar Config
          <input id="sim-file-cfg" type="file" accept="application/json" style="display:none;" />
        </label>
      </div>

      <div class="sim-controls__status" id="sim-ctrl-status">Pronto. Configure e clique em Simular.</div>
    </div>
  `;

  return panel;
}
