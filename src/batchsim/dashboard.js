/**
 * Simulation Dashboard
 *
 * Renders simulation results with clear labels, time-unit indicators,
 * tooltips for technical terms, and accessible language for both
 * BPM professionals and non-specialists.
 */

import { SimulationEventType } from "./models.js";

// ─── Time formatting helpers ─────────────────────────────────────────
function fmtTime(minutes) {
  if (minutes == null || !Number.isFinite(minutes)) return "—";
  if (minutes < 1) return `${(minutes * 60).toFixed(0)}s`;
  if (minutes < 60) return `${minutes.toFixed(1)} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m > 0 ? `${h}h ${m}min` : `${h}h`;
}

function fmtNum(v, decimals = 2) {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toLocaleString("pt-BR", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function fmtPct(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

function fmtInt(v) {
  if (v == null) return "—";
  return Number(v).toLocaleString("pt-BR");
}

// ─── Tooltip wrapper ─────────────────────────────────────────────────
function tip(label, explanation) {
  return `<span class="sim-tip" tabindex="0" aria-label="${esc(explanation)}">${esc(label)}<span class="sim-tip__icon">?</span><span class="sim-tip__text">${esc(explanation)}</span></span>`;
}

// ─── Dashboard creation ──────────────────────────────────────────────
export function createDashboard() {
  const el = document.createElement("div");
  el.id = "sim-dashboard";
  el.className = "sim-dashboard is-hidden";
  el.innerHTML = `
    <div class="sim-dash__header">
      <span class="sim-dash__title">📊 Resultados da Simulação</span>
      <div class="sim-dash__actions">
        <button id="sim-dash-export" class="sim-dash__btn" title="Exportar resultados em CSV">📥 CSV</button>
        <button id="sim-dash-close" class="sim-dash__btn" title="Fechar painel">✕</button>
      </div>
    </div>
    <div class="sim-dash__body">
      <div class="sim-dash__tabs">
        <button class="sim-dash__tab is-active" data-tab="summary">Resumo</button>
        <button class="sim-dash__tab" data-tab="resources">Recursos</button>
        <button class="sim-dash__tab" data-tab="processes">Processos</button>
        <button class="sim-dash__tab" data-tab="elements">Elementos</button>
        <button class="sim-dash__tab" data-tab="bottlenecks">Gargalos</button>
        <button class="sim-dash__tab" data-tab="log">Log</button>
        <button class="sim-dash__tab" data-tab="notes">Análise</button>
      </div>
      <div class="sim-dash__content">
        <div class="sim-dash__pane is-active" data-pane="summary" id="pane-summary"></div>
        <div class="sim-dash__pane" data-pane="resources" id="pane-resources"></div>
        <div class="sim-dash__pane" data-pane="processes" id="pane-processes"></div>
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

  el.querySelector("#sim-dash-close").addEventListener("click", () => {
    el.classList.add("is-hidden");
  });

  return el;
}

export function renderDashboard(dashboard, run) {
  dashboard.classList.remove("is-hidden");
  const metrics = run.metrics;
  if (!metrics) return;

  renderSummary(dashboard.querySelector("#pane-summary"), metrics, run);
  renderResources(dashboard.querySelector("#pane-resources"), metrics.resourceMetrics || []);
  renderProcesses(dashboard.querySelector("#pane-processes"), metrics.processMetrics || []);
  renderElementsTable(dashboard.querySelector("#pane-elements"), metrics.elementMetrics);
  renderBottlenecks(dashboard.querySelector("#pane-bottlenecks"), metrics.bottlenecks);
  renderLog(dashboard.querySelector("#pane-log"), run.log);
  renderNotes(dashboard.querySelector("#pane-notes"), metrics.qualitativeNotes);
}

// ─── SUMMARY TAB ─────────────────────────────────────────────────────
function renderSummary(pane, metrics, run) {
  const params = run.parameters || {};
  const ctePct = (metrics.cycleTimeEfficiency || 0) * 100;
  const cteCls = ctePct < 30 ? "is-warn" : ctePct > 70 ? "is-good" : "";
  const compRate = metrics.totalCases > 0
    ? ((metrics.completedCases / metrics.totalCases) * 100).toFixed(1)
    : "0.0";

  pane.innerHTML = `
    <div class="sim-dash__section-title">
      ⏱️ Tempo de Ciclo
      <span class="sim-dash__section-hint">Quanto tempo cada caso leva do início ao fim (em minutos)</span>
    </div>
    <div class="sim-dash__cards">
      ${card(
        tip("Tempo Médio", "Média aritmética do tempo total que cada caso leva desde a chegada até a conclusão, considerando todas as replicações."),
        fmtTime(metrics.avgCycleTime),
        `± ${fmtTime(metrics.stdCycleTime || 0)} de desvio`,
      )}
      ${card(
        tip("Mediana", "Valor central: 50% dos casos terminam antes deste tempo. Menos sensível a valores extremos que a média."),
        fmtTime(metrics.medianCycleTime),
      )}
      ${card(
        tip("Percentil 90 (P90)", "90% dos casos terminam em até este tempo. Útil para definir SLAs realistas."),
        fmtTime(metrics.p90CycleTime || 0),
        "9 em cada 10 casos",
      )}
      ${card(
        tip("Percentil 95 (P95)", "95% dos casos terminam em até este tempo. Usado como referência para o pior caso típico."),
        fmtTime(metrics.p95CycleTime || 0),
        "19 em cada 20 casos",
      )}
      ${card(
        tip("Mais Rápido / Mais Lento", "O menor e o maior tempo de ciclo observados entre todos os casos completados."),
        `${fmtTime(metrics.minCycleTime)} / ${fmtTime(metrics.maxCycleTime)}`,
      )}
    </div>

    <div class="sim-dash__section-title">
      📈 Desempenho do Processo
      <span class="sim-dash__section-hint">Indicadores de fluxo e eficiência (Lei de Little)</span>
    </div>
    <div class="sim-dash__cards">
      ${card(
        tip("Throughput (λ)", "Quantos casos são concluídos por minuto, em média. Quanto maior, mais produtivo é o processo."),
        `${fmtNum(metrics.throughput, 4)}`,
        "casos/min",
      )}
      ${card(
        tip("WIP Médio", "Work In Progress: número médio de casos que estão 'em andamento' ao mesmo tempo dentro do processo."),
        fmtNum(metrics.avgWip, 1),
        `Lei de Little: λ×CT ≈ ${fmtNum(metrics.wipByLittle || 0, 1)}`,
      )}
      ${card(
        tip("Eficiência (CTE)", "Cycle Time Efficiency: percentual do tempo de ciclo que é efetivamente gasto em atividades produtivas (vs. esperando em fila)."),
        `${ctePct.toFixed(1)}%`,
        ctePct > 70 ? "Excelente — pouca espera" : ctePct > 40 ? "Moderada" : "Baixa — muita espera em fila",
        cteCls,
      )}
      ${card(
        tip("Tempo em Atividades", "Tempo médio que cada caso realmente gasta sendo processado (sem contar espera em fila)."),
        fmtTime(metrics.avgProcessingTime || 0),
        "tempo produtivo",
      )}
      ${card(
        tip("Tempo em Espera", "Tempo médio que cada caso passa aguardando em filas para conseguir um recurso disponível."),
        fmtTime(metrics.avgWaitingTime || 0),
        "tempo em fila",
        (metrics.avgWaitingTime || 0) > (metrics.avgProcessingTime || 0) ? "is-warn" : "",
      )}
    </div>

    <div class="sim-dash__section-title">
      📊 Execução da Simulação
      <span class="sim-dash__section-hint">Parâmetros e resultados gerais da rodada</span>
    </div>
    <div class="sim-dash__cards">
      ${card(
        tip("Casos Completos", "Quantos casos (clientes) terminaram todo o processo com sucesso vs. total de casos iniciados."),
        `${fmtInt(metrics.completedCases)} / ${fmtInt(metrics.totalCases)}`,
        `${compRate}% de conclusão`,
        parseFloat(compRate) < 80 ? "is-warn" : "",
      )}
      ${card(
        tip("Replicações", "Número de vezes que a simulação foi repetida com variações aleatórias para gerar resultados estatisticamente confiáveis."),
        fmtInt(params.replications || 1),
        "repetições independentes",
      )}
      ${card(
        tip("Tempo Simulado", "Duração total do período simulado (ex: um turno de trabalho)."),
        fmtTime(metrics.simEndTime || 0),
        `${fmtNum(metrics.simEndTime || 0, 0)} minutos`,
      )}
      ${card(
        tip("Gargalos", "Atividades identificadas como pontos de congestionamento que atrasam o fluxo do processo."),
        fmtInt(metrics.bottlenecks.length),
        metrics.bottlenecks.length > 0 ? "Ver aba Gargalos →" : "Nenhum detectado ✓",
        metrics.bottlenecks.length > 0 ? "is-warn" : "",
      )}
    </div>

    <div class="sim-dash__section">
      <h4>Parâmetros da Simulação</h4>
      <table class="sim-dash__table sim-dash__table--compact">
        <tr><td>Cenário</td><td>${esc(params.scenarioId || "default")}</td></tr>
        <tr><td>Seed (semente aleatória)</td><td>${params.seed ?? "N/A"}</td></tr>
        <tr><td>Tempo máximo simulado</td><td>${fmtTime(params.maxSimTime)}</td></tr>
        <tr><td>Evento de início</td><td>${esc(params.startEventId || "auto")}</td></tr>
        <tr><td>Chegada de casos</td><td>${formatArrival(params.caseArrival)}</td></tr>
      </table>
    </div>
  `;
}

function formatArrival(arrival) {
  if (!arrival) return "—";
  if (arrival.type === "exponential") return `A cada ~${fmtNum(arrival.mean, 1)} min (exponencial)`;
  if (arrival.type === "fixed") return `Fixo: a cada ${fmtNum(arrival.value, 1)} min`;
  if (arrival.type === "normal") return `Normal: μ=${fmtNum(arrival.mean, 1)} min, σ=${fmtNum(arrival.sd, 1)}`;
  if (arrival.type === "uniform") return `Uniforme: ${fmtNum(arrival.min, 1)}–${fmtNum(arrival.max, 1)} min`;
  return esc(JSON.stringify(arrival));
}

function card(label, value, foot, extraCls) {
  return `
    <div class="sim-dash__card ${extraCls || ""}">
      <div class="sim-dash__card-label">${label}</div>
      <div class="sim-dash__card-value">${value}</div>
      ${foot ? `<div class="sim-dash__card-foot">${foot}</div>` : ""}
    </div>
  `;
}

// ─── RESOURCES TAB ───────────────────────────────────────────────────
function renderResources(pane, resourceMetrics) {
  if (!resourceMetrics || resourceMetrics.length === 0) {
    pane.innerHTML = `
      <div class="sim-dash__empty-block">
        <p class="sim-dash__empty">📋 Nenhum recurso configurado.</p>
        <p class="sim-dash__hint">Para ver a utilização por recurso, adicione a seção <code>"resources"</code> ao arquivo de configuração (.sim.json) com as lanes e suas capacidades.</p>
      </div>`;
    return;
  }

  const rows = resourceMetrics
    .map((r) => {
      const pct = (r.utilization * 100).toFixed(1);
      const cls = r.isOverloaded ? "is-bottleneck" : r.isUnderused ? "is-idle" : "";
      const barCls = r.isOverloaded ? "is-over" : r.utilization > 0.6 ? "is-mid" : "is-low";
      const statusLabel = r.isOverloaded
        ? '<span class="sim-badge sim-badge--red">⚠️ Saturado</span>'
        : r.isUnderused
          ? '<span class="sim-badge sim-badge--blue">💤 Ocioso</span>'
          : '<span class="sim-badge sim-badge--green">✓ Saudável</span>';
      return `
        <tr class="${cls}">
          <td><strong>${esc(r.name)}</strong><br/><span class="sim-dash__muted">ID: ${esc(r.laneId)}</span></td>
          <td class="num">${r.capacity} ${r.capacity === 1 ? "pessoa" : "pessoas"}</td>
          <td>
            <div class="sim-dash__bar"><div class="sim-dash__bar-fill ${barCls}" style="width:${Math.min(100, parseFloat(pct))}%"></div></div>
            <div class="sim-dash__bar-label">${pct}%</div>
          </td>
          <td class="num">${fmtInt(r.taskCount)}</td>
          <td class="num">${fmtTime(r.busyTime)}</td>
          <td class="num">${fmtTime(r.avgWait)}</td>
          <td class="num">${fmtTime(r.maxWait)}</td>
          <td>${statusLabel}</td>
        </tr>
      `;
    })
    .join("");

  pane.innerHTML = `
    <h4>Utilização de Recursos por Lane</h4>
    <div class="sim-dash__explainer">
      <p>Cada <strong>lane</strong> (faixa) no diagrama representa um grupo de recursos (pessoas, máquinas, etc.) que realizam as atividades.</p>
      <p><strong>Utilização (ρ)</strong> = % do tempo que o recurso está ocupado. Valores ideais ficam entre 60–85%.</p>
      <ul class="sim-dash__legend">
        <li><span class="sim-dash__dot sim-dash__dot--green"></span> <strong>&lt; 60%</strong> — Capacidade ociosa disponível</li>
        <li><span class="sim-dash__dot sim-dash__dot--amber"></span> <strong>60–85%</strong> — Utilização saudável</li>
        <li><span class="sim-dash__dot sim-dash__dot--red"></span> <strong>&gt; 85%</strong> — Saturado (filas crescem exponencialmente)</li>
      </ul>
    </div>
    <div class="sim-dash__table-wrap">
      <table class="sim-dash__table">
        <thead>
          <tr>
            <th>${tip("Recurso", "Nome do recurso (lane do processo BPMN)")}</th>
            <th>${tip("Capacidade", "Quantas pessoas/unidades estão disponíveis em paralelo")}</th>
            <th>${tip("Utilização ρ", "Percentual do tempo que o recurso está ocupado processando tarefas")}</th>
            <th>${tip("Tarefas", "Total de tarefas executadas pelo recurso (somando todas as replicações)")}</th>
            <th>${tip("Tempo Ocupado", "Tempo médio (por replicação) que o recurso ficou trabalhando")}</th>
            <th>${tip("Espera Média", "Tempo médio que cada tarefa ficou na fila esperando este recurso ficar livre")}</th>
            <th>${tip("Espera Máx", "Maior tempo de espera observado em uma única tarefa")}</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

// ─── PROCESSES TAB ───────────────────────────────────────────────────
function renderProcesses(pane, processMetrics) {
  if (!processMetrics || processMetrics.length === 0) {
    pane.innerHTML = '<p class="sim-dash__empty">Nenhuma métrica por processo disponível.</p>';
    return;
  }

  const rows = processMetrics
    .map((p) => {
      const compPct = (p.completionRate * 100).toFixed(1);
      const cls = p.completionRate < 0.8 ? "is-warn" : "";
      return `
        <tr>
          <td><strong>${esc(p.processId)}</strong></td>
          <td class="num">${fmtInt(p.totalCases)}</td>
          <td class="num ${cls}">${fmtInt(p.completedCases)} (${compPct}%)</td>
          <td class="num">${fmtTime(p.avgCycleTime)}</td>
          <td class="num">${fmtTime(p.medianCycleTime)}</td>
          <td class="num">${fmtTime(p.p90CycleTime)}</td>
          <td class="num">${fmtTime(p.maxCycleTime)}</td>
        </tr>
      `;
    })
    .join("");

  pane.innerHTML = `
    <h4>Métricas por Processo (Pool)</h4>
    <div class="sim-dash__explainer">
      <p>Em uma <strong>colaboração BPMN</strong>, cada participante (pool) tem seu próprio ciclo de vida. Este relatório mostra os tempos de cada um separadamente.</p>
      <p>Exemplo: o <em>Customer</em> vai de "ficar com fome" até "comer a pizza"; o <em>Pizza Vendor</em> vai de "receber pedido" até "receber pagamento".</p>
    </div>
    <div class="sim-dash__table-wrap">
      <table class="sim-dash__table">
        <thead>
          <tr>
            <th>Processo</th>
            <th>${tip("Casos", "Total de instâncias criadas deste processo")}</th>
            <th>${tip("Concluídos", "Quantas instâncias terminaram com sucesso")}</th>
            <th>${tip("CT Médio", "Cycle Time médio: tempo total de cada caso do início ao fim")}</th>
            <th>${tip("Mediana", "Valor central — 50% dos casos ficam abaixo deste tempo")}</th>
            <th>${tip("P90", "90% dos casos terminam em até este tempo")}</th>
            <th>${tip("Máximo", "Caso mais demorado observado")}</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

// ─── ELEMENTS TAB ────────────────────────────────────────────────────
function renderElementsTable(pane, elementMetrics) {
  if (!elementMetrics || elementMetrics.length === 0) {
    pane.innerHTML = '<p class="sim-dash__empty">Nenhuma métrica de elemento disponível.</p>';
    return;
  }

  // Filter to only show elements with activity (visits > 0 or time > 0)
  const relevant = elementMetrics.filter(
    (m) => m.visits > 0 || m.totalTime > 0 || m.waitTime > 0,
  );

  const rows = relevant
    .map(
      (m) => `
    <tr class="${m.isBottleneck ? "is-bottleneck" : ""}">
      <td title="ID: ${esc(m.elementId)}">${esc(m.elementName || m.elementId)}</td>
      <td>${esc(shortType(m.elementType))}</td>
      <td class="num">${fmtInt(m.visits)}</td>
      <td class="num">${fmtTime(m.totalTime)}</td>
      <td class="num">${fmtTime(m.avgTime)}</td>
      <td class="num">${fmtTime(m.minTime)}</td>
      <td class="num">${fmtTime(m.maxTime)}</td>
      <td class="num">${fmtTime(m.waitTime)}</td>
      <td class="num">${fmtTime(m.avgWaitTime || 0)}</td>
      <td class="num">${fmtTime(m.maxWaitTime || 0)}</td>
      <td>${m.isBottleneck ? '<span class="sim-badge sim-badge--red">🔴 Gargalo</span>' : ""}</td>
    </tr>
  `,
    )
    .join("");

  pane.innerHTML = `
    <h4>Desempenho por Atividade</h4>
    <div class="sim-dash__explainer">
      <p>Cada linha mostra uma atividade (tarefa) ou evento do processo. Tempos de <strong>processamento</strong> indicam quanto tempo a atividade demora para ser executada; tempos de <strong>espera</strong> indicam quanto o caso ficou na fila antes de ser atendido.</p>
      <p><span class="sim-badge sim-badge--red">Gargalo</span> = atividades onde a combinação de tempo total + espera concentra o maior atraso.</p>
    </div>
    <div class="sim-dash__table-wrap">
      <table class="sim-dash__table">
        <thead>
          <tr>
            <th>Atividade</th>
            <th>Tipo</th>
            <th>${tip("Execuções", "Quantas vezes esta atividade foi executada (soma de todas as replicações)")}</th>
            <th>${tip("Tempo Total", "Soma de todo o tempo de processamento gasto nesta atividade")}</th>
            <th>${tip("Tempo Médio", "Duração média de cada execução desta atividade")}</th>
            <th>Min</th>
            <th>Max</th>
            <th>${tip("Espera Total", "Tempo total que os casos ficaram em fila aguardando para executar esta atividade")}</th>
            <th>${tip("Espera Média", "Tempo médio de espera em fila por execução")}</th>
            <th>${tip("Espera Máx", "Maior tempo de espera em fila observado em uma única execução")}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

// ─── BOTTLENECKS TAB ─────────────────────────────────────────────────
function renderBottlenecks(pane, bottlenecks) {
  if (!bottlenecks || bottlenecks.length === 0) {
    pane.innerHTML = `
      <div class="sim-dash__empty-block">
        <p class="sim-dash__empty">✅ Nenhum gargalo identificado nesta simulação.</p>
        <p class="sim-dash__hint">Isso significa que nenhuma atividade concentra excesso de espera ou tempo de processamento desproporcional ao restante.</p>
      </div>`;
    return;
  }

  const items = bottlenecks
    .map(
      (b) => `
    <div class="sim-dash__bottleneck-card">
      <div class="sim-dash__bottleneck-name">🔴 ${esc(b.elementName || b.elementId)}</div>
      <div class="sim-dash__bottleneck-type">${esc(shortType(b.elementType))}</div>
      <div class="sim-dash__bottleneck-stats">
        <div class="sim-dash__stat">
          <span class="sim-dash__stat-label">Execuções</span>
          <span class="sim-dash__stat-value">${fmtInt(b.visits)}</span>
        </div>
        <div class="sim-dash__stat">
          <span class="sim-dash__stat-label">Tempo Total de Processamento</span>
          <span class="sim-dash__stat-value">${fmtTime(b.totalTime)}</span>
        </div>
        <div class="sim-dash__stat">
          <span class="sim-dash__stat-label">Duração Média</span>
          <span class="sim-dash__stat-value">${fmtTime(b.avgTime)}</span>
        </div>
        <div class="sim-dash__stat">
          <span class="sim-dash__stat-label">Tempo Total em Fila</span>
          <span class="sim-dash__stat-value sim-dash__stat-value--warn">${fmtTime(b.waitTime)}</span>
        </div>
        <div class="sim-dash__stat">
          <span class="sim-dash__stat-label">Espera Média por Caso</span>
          <span class="sim-dash__stat-value">${fmtTime(b.avgWaitTime || 0)}</span>
        </div>
      </div>
      <div class="sim-dash__bottleneck-tip">
        💡 <em>Possíveis ações:</em> adicionar mais recursos (capacidade) nesta lane, reduzir a duração da atividade, ou redistribuir a carga.
      </div>
    </div>
  `,
    )
    .join("");

  pane.innerHTML = `
    <h4>Gargalos Identificados</h4>
    <div class="sim-dash__explainer">
      <p><strong>Gargalo</strong> é a atividade que mais limita a capacidade do processo. É o ponto onde os casos mais esperam em fila e/ou onde se acumula o maior tempo total.</p>
      <p>Na prática, melhorar o gargalo é a forma mais efetiva de reduzir o tempo de ciclo geral.</p>
    </div>
    ${items}
  `;
}

// ─── LOG TAB ─────────────────────────────────────────────────────────
function renderLog(pane, log) {
  if (!log || log.length === 0) {
    pane.innerHTML = '<p class="sim-dash__empty">Nenhum evento registrado.</p>';
    return;
  }

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
      <input id="sim-log-search" type="text" placeholder="Buscar por elemento, caso ou mensagem..." />
      <span class="sim-dash__log-count" id="sim-log-count">${fmtInt(log.length)} registros</span>
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
            <th>${tip("Tempo", "Tempo simulado (em minutos) em que o evento ocorreu")}</th>
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

    const MAX_ROWS = 500;
    const shown = filtered.slice(0, MAX_ROWS);

    tbody.innerHTML = shown
      .map(
        (e) => `
      <tr class="sim-log-${e.level || "info"}">
        <td class="num">${e.seq}</td>
        <td class="num">${fmtTime(e.simTime)}</td>
        <td>${esc(e.eventType)}</td>
        <td>${esc(e.caseId)}</td>
        <td title="ID: ${esc(e.elementId)}">${esc(e.elementName || e.elementId)}</td>
        <td>${esc(e.message)}</td>
        <td><span class="sim-badge sim-badge--${e.level || "info"}">${e.level || "info"}</span></td>
      </tr>
    `,
      )
      .join("");

    countEl.textContent =
      filtered.length > MAX_ROWS
        ? `Mostrando ${MAX_ROWS} de ${fmtInt(filtered.length)}`
        : `${fmtInt(filtered.length)} registros`;
  }

  filterType.addEventListener("change", applyFilters);
  filterLevel.addEventListener("change", applyFilters);
  search.addEventListener("input", applyFilters);
  applyFilters();
}

// ─── ANALYSIS TAB ────────────────────────────────────────────────────
function renderNotes(pane, notes) {
  if (!notes || notes.length === 0) {
    pane.innerHTML = '<p class="sim-dash__empty">Nenhuma observação.</p>';
    return;
  }

  pane.innerHTML = `
    <h4>Análise Qualitativa</h4>
    <div class="sim-dash__explainer">
      <p>Observações geradas automaticamente a partir dos resultados da simulação. Baseadas em práticas de <strong>análise de valor agregado</strong>, <strong>teoria das filas</strong> e <strong>identificação de desperdícios</strong> (Lean/BPM).</p>
    </div>
    <ul class="sim-dash__notes">
      ${notes.map((n) => `<li class="sim-dash__note-item">${n}</li>`).join("")}
    </ul>
    <div class="sim-dash__glossary">
      <h5>📖 Glossário rápido</h5>
      <dl>
        <dt>CTE (Cycle Time Efficiency)</dt>
        <dd>Percentual do tempo de ciclo gasto em trabalho produtivo. Ideal &gt; 70%.</dd>
        <dt>ρ (Utilização)</dt>
        <dd>Fração do tempo que um recurso está ocupado. Acima de 85% as filas crescem exponencialmente.</dd>
        <dt>Gargalo</dt>
        <dd>Atividade que mais restringe a capacidade total do processo. Melhorar o gargalo é a ação com maior impacto.</dd>
        <dt>Lei de Little</dt>
        <dd>WIP = Throughput × Cycle Time. Se o WIP simulado diverge muito deste produto, há efeitos transientes na simulação.</dd>
        <dt>P90 / P95</dt>
        <dd>Percentis que indicam o tempo dentro do qual 90% ou 95% dos casos são concluídos. Usados para definir SLAs.</dd>
      </dl>
    </div>
  `;
}

// ─── Utilities ───────────────────────────────────────────────────────
function shortType(t) {
  return (t || "").replace("bpmn:", "");
}

function esc(s) {
  if (!s) return "";
  const d = document.createElement("div");
  d.textContent = String(s);
  return d.innerHTML;
}
