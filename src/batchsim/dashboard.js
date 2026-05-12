/**
 * Simulation Dashboard
 *
 * Renders simulation results: summary metrics, per-element table,
 * bottleneck highlights, qualitative notes, and filterable event log.
 */

import { SimulationEventType } from "./models.js";

/**
 * Create the dashboard panel DOM element.
 * @returns {HTMLElement}
 */
export function createDashboard() {
  const el = document.createElement("div");
  el.id = "sim-dashboard";
  el.className = "sim-dashboard is-hidden";
  el.innerHTML = `
    <div class="sim-dash__header">
      <span class="sim-dash__title">📊 Resultados da Simulação</span>
      <div class="sim-dash__actions">
        <button id="sim-dash-export" class="sim-dash__btn" title="Exportar CSV">📥 CSV</button>
        <button id="sim-dash-close" class="sim-dash__btn" title="Fechar">✕</button>
      </div>
    </div>
    <div class="sim-dash__body">
      <div class="sim-dash__tabs">
        <button class="sim-dash__tab is-active" data-tab="summary">Resumo</button>
        <button class="sim-dash__tab" data-tab="elements">Elementos</button>
        <button class="sim-dash__tab" data-tab="bottlenecks">Gargalos</button>
        <button class="sim-dash__tab" data-tab="log">Log</button>
        <button class="sim-dash__tab" data-tab="notes">Análise</button>
      </div>
      <div class="sim-dash__content">
        <div class="sim-dash__pane is-active" data-pane="summary" id="pane-summary"></div>
        <div class="sim-dash__pane" data-pane="elements" id="pane-elements"></div>
        <div class="sim-dash__pane" data-pane="bottlenecks" id="pane-bottlenecks"></div>
        <div class="sim-dash__pane" data-pane="log" id="pane-log"></div>
        <div class="sim-dash__pane" data-pane="notes" id="pane-notes"></div>
      </div>
    </div>
  `;

  // Tab switching
  const tabs = el.querySelectorAll(".sim-dash__tab");
  const panes = el.querySelectorAll(".sim-dash__pane");
  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("is-active"));
      panes.forEach((p) => p.classList.remove("is-active"));
      tab.classList.add("is-active");
      const target = tab.getAttribute("data-tab");
      el.querySelector(`[data-pane="${target}"]`).classList.add("is-active");
    });
  }

  // Close
  el.querySelector("#sim-dash-close").addEventListener("click", () => {
    el.classList.add("is-hidden");
  });

  return el;
}

/**
 * Populate dashboard with simulation run data.
 *
 * @param {HTMLElement} dashboard
 * @param {import('./models.js').SimulationRun} run
 */
export function renderDashboard(dashboard, run) {
  dashboard.classList.remove("is-hidden");

  const metrics = run.metrics;
  if (!metrics) return;

  renderSummary(dashboard.querySelector("#pane-summary"), metrics, run);
  renderElementsTable(
    dashboard.querySelector("#pane-elements"),
    metrics.elementMetrics,
  );
  renderBottlenecks(
    dashboard.querySelector("#pane-bottlenecks"),
    metrics.bottlenecks,
  );
  renderLog(dashboard.querySelector("#pane-log"), run.log);
  renderNotes(dashboard.querySelector("#pane-notes"), metrics.qualitativeNotes);
}

function renderSummary(pane, metrics, run) {
  const params = run.parameters || {};
  pane.innerHTML = `
    <div class="sim-dash__cards">
      <div class="sim-dash__card">
        <div class="sim-dash__card-label">Tempo Médio de Ciclo</div>
        <div class="sim-dash__card-value">${metrics.avgCycleTime.toFixed(2)}</div>
      </div>
      <div class="sim-dash__card">
        <div class="sim-dash__card-label">Min / Max Ciclo</div>
        <div class="sim-dash__card-value">${metrics.minCycleTime.toFixed(2)} / ${metrics.maxCycleTime.toFixed(2)}</div>
      </div>
      <div class="sim-dash__card">
        <div class="sim-dash__card-label">Mediana do Ciclo</div>
        <div class="sim-dash__card-value">${metrics.medianCycleTime.toFixed(2)}</div>
      </div>
      <div class="sim-dash__card">
        <div class="sim-dash__card-label">Casos Completos</div>
        <div class="sim-dash__card-value">${metrics.completedCases} / ${metrics.totalCases}</div>
      </div>
      <div class="sim-dash__card">
        <div class="sim-dash__card-label">Throughput</div>
        <div class="sim-dash__card-value">${metrics.throughput.toFixed(4)}</div>
      </div>
      <div class="sim-dash__card">
        <div class="sim-dash__card-label">WIP Médio</div>
        <div class="sim-dash__card-value">${metrics.avgWip.toFixed(4)}</div>
      </div>
      <div class="sim-dash__card">
        <div class="sim-dash__card-label">Gargalos</div>
        <div class="sim-dash__card-value ${metrics.bottlenecks.length > 0 ? "is-warn" : ""}">${metrics.bottlenecks.length}</div>
      </div>
      <div class="sim-dash__card">
        <div class="sim-dash__card-label">Replicações</div>
        <div class="sim-dash__card-value">${params.replications || 1}</div>
      </div>
    </div>
    <div class="sim-dash__section">
      <h4>Parâmetros</h4>
      <table class="sim-dash__table sim-dash__table--compact">
        <tr><td>Cenário</td><td>${esc(params.scenarioId || "default")}</td></tr>
        <tr><td>Seed</td><td>${params.seed || "N/A"}</td></tr>
        <tr><td>Tempo Max</td><td>${params.maxSimTime || "N/A"}</td></tr>
        <tr><td>Evento Inicial</td><td>${esc(params.startEventId || "auto")}</td></tr>
        <tr><td>Chegada</td><td>${esc(JSON.stringify(params.caseArrival || {}))}</td></tr>
      </table>
    </div>
  `;
}

function renderElementsTable(pane, elementMetrics) {
  if (!elementMetrics || elementMetrics.length === 0) {
    pane.innerHTML =
      '<p class="sim-dash__empty">Nenhuma métrica de elemento disponível.</p>';
    return;
  }

  const rows = elementMetrics
    .map(
      (m) => `
    <tr class="${m.isBottleneck ? "is-bottleneck" : ""}">
      <td title="${esc(m.elementId)}">${esc(m.elementName || m.elementId)}</td>
      <td>${esc(shortType(m.elementType))}</td>
      <td class="num">${m.visits}</td>
      <td class="num">${m.totalTime.toFixed(2)}</td>
      <td class="num">${m.avgTime.toFixed(2)}</td>
      <td class="num">${m.minTime.toFixed(2)}</td>
      <td class="num">${m.maxTime.toFixed(2)}</td>
      <td class="num">${m.waitTime.toFixed(2)}</td>
      <td>${m.isBottleneck ? '<span class="sim-badge sim-badge--red">Gargalo</span>' : ""}</td>
    </tr>
  `,
    )
    .join("");

  pane.innerHTML = `
    <div class="sim-dash__table-wrap">
      <table class="sim-dash__table">
        <thead>
          <tr>
            <th>Elemento</th>
            <th>Tipo</th>
            <th>Visitas</th>
            <th>Tempo Total</th>
            <th>Tempo Médio</th>
            <th>Min</th>
            <th>Max</th>
            <th>Espera</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function renderBottlenecks(pane, bottlenecks) {
  if (!bottlenecks || bottlenecks.length === 0) {
    pane.innerHTML =
      '<p class="sim-dash__empty">✅ Nenhum gargalo identificado nesta simulação.</p>';
    return;
  }

  const items = bottlenecks
    .map(
      (b) => `
    <div class="sim-dash__bottleneck-card">
      <div class="sim-dash__bottleneck-name">🔴 ${esc(b.elementName || b.elementId)}</div>
      <div class="sim-dash__bottleneck-type">${esc(shortType(b.elementType))}</div>
      <div class="sim-dash__bottleneck-stats">
        <span>Visitas: <strong>${b.visits}</strong></span>
        <span>Tempo Total: <strong>${b.totalTime.toFixed(2)}</strong></span>
        <span>Tempo Médio: <strong>${b.avgTime.toFixed(2)}</strong></span>
        <span>Espera: <strong>${b.waitTime.toFixed(2)}</strong></span>
      </div>
    </div>
  `,
    )
    .join("");

  pane.innerHTML = `
    <h4>Gargalos Identificados</h4>
    <p class="sim-dash__hint">Atividades com maior concentração de tempo e/ou espera.</p>
    ${items}
  `;
}

function renderLog(pane, log) {
  if (!log || log.length === 0) {
    pane.innerHTML = '<p class="sim-dash__empty">Nenhum evento registrado.</p>';
    return;
  }

  // Filter controls
  const filterHtml = `
    <div class="sim-dash__log-filter">
      <select id="sim-log-filter-type">
        <option value="">Todos os tipos</option>
        ${Object.values(SimulationEventType)
          .map((t) => `<option value="${t}">${t}</option>`)
          .join("")}
      </select>
      <select id="sim-log-filter-level">
        <option value="">Todos os níveis</option>
        <option value="info">info</option>
        <option value="warn">warn</option>
        <option value="error">error</option>
      </select>
      <input id="sim-log-search" type="text" placeholder="Buscar..." />
      <span class="sim-dash__log-count" id="sim-log-count">${log.length} registros</span>
    </div>
  `;

  const tableId = "sim-log-table-body";

  pane.innerHTML = `
    ${filterHtml}
    <div class="sim-dash__table-wrap sim-dash__table-wrap--log">
      <table class="sim-dash__table sim-dash__table--log">
        <thead>
          <tr>
            <th>#</th>
            <th>T</th>
            <th>Tipo</th>
            <th>Caso</th>
            <th>Elemento</th>
            <th>Mensagem</th>
            <th>Nível</th>
          </tr>
        </thead>
        <tbody id="${tableId}"></tbody>
      </table>
    </div>
  `;

  const tbody = pane.querySelector(`#${tableId}`);
  const filterType = pane.querySelector("#sim-log-filter-type");
  const filterLevel = pane.querySelector("#sim-log-filter-level");
  const search = pane.querySelector("#sim-log-search");
  const countEl = pane.querySelector("#sim-log-count");

  function applyFilters() {
    const typeVal = filterType.value;
    const levelVal = filterLevel.value;
    const searchVal = (search.value || "").toLowerCase();

    let filtered = log;
    if (typeVal) filtered = filtered.filter((e) => e.eventType === typeVal);
    if (levelVal) filtered = filtered.filter((e) => e.level === levelVal);
    if (searchVal)
      filtered = filtered.filter(
        (e) =>
          (e.message || "").toLowerCase().includes(searchVal) ||
          (e.elementId || "").toLowerCase().includes(searchVal) ||
          (e.caseId || "").toLowerCase().includes(searchVal),
      );

    // Limit visible rows for performance
    const MAX_ROWS = 500;
    const shown = filtered.slice(0, MAX_ROWS);

    tbody.innerHTML = shown
      .map(
        (e) => `
      <tr class="sim-log-${e.level || "info"}">
        <td class="num">${e.seq}</td>
        <td class="num">${e.simTime.toFixed(2)}</td>
        <td>${esc(e.eventType)}</td>
        <td>${esc(e.caseId)}</td>
        <td title="${esc(e.elementId)}">${esc(e.elementName || e.elementId)}</td>
        <td>${esc(e.message)}</td>
        <td><span class="sim-badge sim-badge--${e.level || "info"}">${e.level || "info"}</span></td>
      </tr>
    `,
      )
      .join("");

    countEl.textContent =
      filtered.length > MAX_ROWS
        ? `${MAX_ROWS} de ${filtered.length} registros`
        : `${filtered.length} registros`;
  }

  filterType.addEventListener("change", applyFilters);
  filterLevel.addEventListener("change", applyFilters);
  search.addEventListener("input", applyFilters);

  applyFilters();
}

function renderNotes(pane, notes) {
  if (!notes || notes.length === 0) {
    pane.innerHTML = '<p class="sim-dash__empty">Nenhuma observação.</p>';
    return;
  }

  pane.innerHTML = `
    <h4>Análise Qualitativa</h4>
    <p class="sim-dash__hint">Observações baseadas nos resultados da simulação, inspiradas em análise de valor agregado e identificação de desperdícios.</p>
    <ul class="sim-dash__notes">
      ${notes.map((n) => `<li>${esc(n)}</li>`).join("")}
    </ul>
  `;
}

function shortType(t) {
  return (t || "").replace("bpmn:", "");
}

function esc(s) {
  if (!s) return "";
  const d = document.createElement("div");
  d.textContent = String(s);
  return d.innerHTML;
}
