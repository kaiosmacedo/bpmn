/**
 * Metrics Calculator
 *
 * Computes performance metrics from raw simulation engine output.
 * Identifies bottlenecks and generates qualitative analysis notes.
 */

/**
 * Compute full simulation metrics from engine raw results.
 *
 * @param {Object}   rawResults  - { eventsRows, summaryRows, pathRows, casesRows, taskRows }
 * @param {Map}      elementsById - graph.elementsById
 * @returns {import('./models.js').SimulationMetrics}
 */
export function computeMetrics(rawResults, elementsById) {
  const { eventsRows, summaryRows, casesRows, taskRows } = rawResults;

  // ── Cycle time analysis ──
  const cycleTimes = (casesRows || [])
    .filter((c) => c.completed && c.cycleTime != null && c.cycleTime > 0)
    .map((c) => c.cycleTime);

  cycleTimes.sort((a, b) => a - b);

  const completedCases = cycleTimes.length;
  const totalCases = (casesRows || []).length;

  const avgCycleTime =
    completedCases > 0
      ? cycleTimes.reduce((a, b) => a + b, 0) / completedCases
      : 0;
  const minCycleTime = completedCases > 0 ? cycleTimes[0] : 0;
  const maxCycleTime =
    completedCases > 0 ? cycleTimes[cycleTimes.length - 1] : 0;
  const medianCycleTime =
    completedCases > 0 ? cycleTimes[Math.floor(completedCases / 2)] : 0;

  // ── Throughput & WIP (averaged across replications) ──
  const reps = summaryRows.length || 1;
  const throughput =
    summaryRows.reduce((a, b) => a + (b.throughput || 0), 0) / reps;
  const avgWip = summaryRows.reduce((a, b) => a + (b.avgWip || 0), 0) / reps;

  // ── Per-element metrics ──
  const elementMetrics = computeElementMetrics(
    eventsRows,
    taskRows,
    elementsById,
  );

  // ── Bottleneck detection ──
  const bottlenecks = detectBottlenecks(elementMetrics);

  // ── Qualitative analysis notes ──
  const qualitativeNotes = generateQualitativeNotes(
    elementMetrics,
    bottlenecks,
    avgCycleTime,
    completedCases,
    totalCases,
  );

  return {
    avgCycleTime: round(avgCycleTime),
    minCycleTime: round(minCycleTime),
    maxCycleTime: round(maxCycleTime),
    medianCycleTime: round(medianCycleTime),
    completedCases,
    totalCases,
    throughput: round(throughput),
    avgWip: round(avgWip),
    elementMetrics,
    bottlenecks,
    qualitativeNotes,
  };
}

/**
 * Build per-element performance metrics from event rows and task spans.
 */
function computeElementMetrics(eventsRows, taskRows, elementsById) {
  // Count visits per element from 'enter' events
  const visitCounts = new Map();
  for (const ev of eventsRows) {
    if (ev.eventType === "enter" && ev.elementId) {
      visitCounts.set(ev.elementId, (visitCounts.get(ev.elementId) || 0) + 1);
    }
  }

  // Aggregate task durations from taskRows
  const taskAgg = new Map(); // elementId -> { total, min, max, count }
  for (const ts of taskRows || []) {
    const id = ts.taskId;
    const dur = ts.duration || 0;
    const agg = taskAgg.get(id) || {
      total: 0,
      min: Infinity,
      max: -Infinity,
      count: 0,
    };
    agg.total += dur;
    agg.min = Math.min(agg.min, dur);
    agg.max = Math.max(agg.max, dur);
    agg.count += 1;
    taskAgg.set(id, agg);
  }

  // Compute waiting time from taskRows (resource queueing wait)
  const waitAgg = computeWaitTimes(taskRows, eventsRows);

  const metrics = [];

  // Combine all element IDs
  const allIds = new Set([...visitCounts.keys(), ...taskAgg.keys()]);

  for (const elId of allIds) {
    const el = elementsById ? elementsById.get(elId) : null;
    const elType = el ? el.$type || "" : "";
    const elName = el ? el.name || "" : "";
    const visits = visitCounts.get(elId) || 0;

    const ta = taskAgg.get(elId);
    const totalTime = ta ? round(ta.total) : 0;
    const avgTime = ta ? round(ta.total / ta.count) : 0;
    const minTime = ta ? round(ta.min === Infinity ? 0 : ta.min) : 0;
    const maxTime = ta ? round(ta.max === -Infinity ? 0 : ta.max) : 0;

    const wa = waitAgg.get(elId);
    const waitTime = wa ? round(wa.total) : 0;
    const avgWaitTime = wa ? round(wa.total / wa.count) : 0;

    metrics.push({
      elementId: elId,
      elementType: elType,
      elementName: elName,
      visits,
      totalTime,
      avgTime,
      minTime,
      maxTime,
      waitTime,
      avgWaitTime,
      isBottleneck: false,
    });
  }

  // Sort by totalTime descending
  metrics.sort((a, b) => b.totalTime - a.totalTime);

  return metrics;
}

/**
 * Compute wait times per element from taskRows (resource queueing).
 * Falls back to approximate enter-timing gaps if taskRows have no waitTime field.
 */
function computeWaitTimes(taskRows, eventsRows) {
  const waitAgg = new Map();

  // Primary: use waitTime field from taskRows (accurate resource wait)
  if (taskRows && taskRows.length > 0 && taskRows[0].waitTime !== undefined) {
    for (const ts of taskRows) {
      const wt = ts.waitTime || 0;
      if (wt > 0) {
        const agg = waitAgg.get(ts.taskId) || { total: 0, count: 0 };
        agg.total += wt;
        agg.count += 1;
        waitAgg.set(ts.taskId, agg);
      }
    }
    return waitAgg;
  }

  // Fallback: approximate from consecutive enter events
  const enterTimes = new Map();

  for (const ev of eventsRows) {
    if (ev.eventType === "enter" && ev.elementId) {
      const id = ev.elementId;
      if (!enterTimes.has(id)) enterTimes.set(id, []);
      const times = enterTimes.get(id);
      times.push(ev.simTime);

      if (times.length > 1) {
        const waitDelta = ev.simTime - times[times.length - 2];
        if (waitDelta >= 0) {
          const agg = waitAgg.get(id) || { total: 0, count: 0 };
          agg.total += waitDelta;
          agg.count += 1;
          waitAgg.set(id, agg);
        }
      }
    }

    if (ev.eventType === "task_complete" && ev.elementId) {
      const times = enterTimes.get(ev.elementId);
      if (times && times.length > 0) times.shift();
    }
  }

  return waitAgg;
}

/**
 * Detect bottlenecks using multiple heuristics:
 * - Top elements by total accumulated time
 * - High average time relative to others
 * - High visit count with high time
 * - High wait time
 */
function detectBottlenecks(elementMetrics) {
  if (elementMetrics.length === 0) return [];

  // Only consider tasks/activities for bottleneck detection
  const tasks = elementMetrics.filter(
    (m) =>
      (m.elementType.endsWith("Task") ||
        m.elementType === "bpmn:Task" ||
        m.elementType === "bpmn:UserTask" ||
        m.elementType === "bpmn:ServiceTask" ||
        m.elementType === "bpmn:SubProcess") &&
      m.totalTime > 0,
  );

  if (tasks.length === 0) return [];

  const maxTotal = Math.max(...tasks.map((m) => m.totalTime));
  const maxAvg = Math.max(...tasks.map((m) => m.avgTime));
  const maxWait = Math.max(...tasks.map((m) => m.waitTime));

  const bottlenecks = [];

  for (const m of tasks) {
    const totalRatio = maxTotal > 0 ? m.totalTime / maxTotal : 0;
    const avgRatio = maxAvg > 0 ? m.avgTime / maxAvg : 0;
    const waitRatio = maxWait > 0 ? m.waitTime / maxWait : 0;

    // Bottleneck if in top 25% by total OR avg time, or has significant wait
    const score = totalRatio * 0.4 + avgRatio * 0.35 + waitRatio * 0.25;

    if (score >= 0.6) {
      m.isBottleneck = true;
      bottlenecks.push(m);
    }
  }

  return bottlenecks;
}

/**
 * Generate qualitative analysis notes based on metrics.
 * Inspired by: value-added analysis, waste analysis, bottleneck identification.
 */
function generateQualitativeNotes(
  elementMetrics,
  bottlenecks,
  avgCycleTime,
  completed,
  total,
) {
  const notes = [];

  // Completion rate
  if (total > 0 && completed < total) {
    const pct = ((completed / total) * 100).toFixed(1);
    notes.push(
      `⚠️ Taxa de conclusão: ${pct}% (${completed}/${total} casos). Casos incompletos podem indicar deadlocks ou tempo de simulação insuficiente.`,
    );
  }

  // Bottlenecks
  if (bottlenecks.length > 0) {
    const names = bottlenecks
      .map((b) => b.elementName || b.elementId)
      .join(", ");
    notes.push(
      `🔴 Gargalos identificados: ${names}. Estas atividades concentram o maior tempo acumulado e/ou espera.`,
    );
  }

  // High cycle time variance
  const tasks = elementMetrics.filter((m) => m.totalTime > 0);
  if (tasks.length > 0) {
    const topTask = tasks[0]; // already sorted by totalTime desc
    if (topTask.maxTime > topTask.avgTime * 3 && topTask.avgTime > 0) {
      notes.push(
        `⚠️ "${topTask.elementName || topTask.elementId}" apresenta alta variabilidade (max ${topTask.maxTime.toFixed(2)} vs avg ${topTask.avgTime.toFixed(2)}). Pode indicar retrabalho ou condições excepcionais.`,
      );
    }
  }

  // Wait time analysis
  const waiters = elementMetrics
    .filter((m) => m.waitTime > 0)
    .sort((a, b) => b.waitTime - a.waitTime);
  if (waiters.length > 0) {
    const top = waiters[0];
    notes.push(
      `⏳ Maior tempo de espera acumulado: "${top.elementName || top.elementId}" (${top.waitTime.toFixed(2)} unidades). Considere adicionar recursos ou paralelizar.`,
    );
  }

  // Activities without visits (potential dead branches)
  const unvisited = elementMetrics.filter(
    (m) =>
      m.visits === 0 &&
      (m.elementType.endsWith("Task") || m.elementType === "bpmn:SubProcess"),
  );
  if (unvisited.length > 0) {
    const names = unvisited.map((u) => u.elementName || u.elementId).join(", ");
    notes.push(
      `ℹ️ Atividades sem visitas na simulação: ${names}. Podem ser caminhos nunca atingidos ou elementos não conectados.`,
    );
  }

  // Potential non-value-added activities (very short tasks visited often)
  const shortFrequent = elementMetrics.filter(
    (m) => m.visits > 5 && m.avgTime > 0 && m.avgTime < 0.1 && m.totalTime > 0,
  );
  if (shortFrequent.length > 0) {
    const names = shortFrequent
      .map((s) => s.elementName || s.elementId)
      .join(", ");
    notes.push(
      `💡 Atividades muito rápidas e frequentes: ${names}. Avalie se agregam valor ou se podem ser eliminadas/automatizadas.`,
    );
  }

  if (notes.length === 0) {
    notes.push(
      "✅ Nenhum problema qualitativo significativo detectado nesta simulação.",
    );
  }

  return notes;
}

function round(v, d = 4) {
  const f = Math.pow(10, d);
  return Math.round(v * f) / f;
}
