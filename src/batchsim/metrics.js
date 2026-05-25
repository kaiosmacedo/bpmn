/**
 * Metrics Calculator
 *
 * Computes performance metrics from raw simulation engine output.
 *
 * Reference: Dumas, La Rosa, Mendling, Reijers - "Fundamentals of Business
 * Process Management", Ch. 6 (Quantitative Process Analysis):
 *   - Little's Law:   WIP = throughput × cycleTime
 *   - Resource utilization:  ρ = busyTime / (capacity × simEndTime)
 *   - Bottleneck rule of thumb:  ρ > 0.85
 *   - Cycle Time Efficiency:  CTE = processingTime / cycleTime
 */

export function computeMetrics(rawResults, elementsById, cfg) {
  const { eventsRows, summaryRows, casesRows, taskRows } = rawResults;
  const config = cfg || {};

  // ───────────────── Cases / Cycle time ─────────────────
  const allCompleted = (casesRows || [])
    .filter((c) => c.completed && c.cycleTime != null && c.cycleTime > 0);

  // Prefer customer (root) cases as the SLA driver. Sub-instances of
  // correlated pools have a "|" separator (rootCaseId|processId).
  const rootCases = allCompleted.filter((c) => !(c.caseId || '').includes('|'));
  const cycleTimes = (rootCases.length > 0 ? rootCases : allCompleted)
    .map((c) => c.cycleTime)
    .sort((a, b) => a - b);

  const completedCases = cycleTimes.length;
  const totalCases =
    (casesRows || []).filter((c) => !(c.caseId || '').includes('|')).length
    || (casesRows || []).length;

  const avgCycleTime = mean(cycleTimes);
  const minCycleTime = cycleTimes[0] || 0;
  const maxCycleTime = cycleTimes[cycleTimes.length - 1] || 0;
  const medianCycleTime = percentile(cycleTimes, 0.5);
  const p90CycleTime = percentile(cycleTimes, 0.9);
  const p95CycleTime = percentile(cycleTimes, 0.95);
  const stdCycleTime = stddev(cycleTimes, avgCycleTime);

  // ───────────────── Throughput / WIP / sim end ─────────────────
  const reps = summaryRows.length || 1;
  const throughput =
    summaryRows.reduce((a, b) => a + (b.throughput || 0), 0) / reps;
  const avgWip = summaryRows.reduce((a, b) => a + (b.avgWip || 0), 0) / reps;
  const simEndTime =
    summaryRows.reduce((a, b) => a + (b.simEndTime || 0), 0) / reps;

  // Little's Law check
  const wipByLittle = throughput * avgCycleTime;
  const littleResidual =
    avgWip > 0 ? Math.abs(avgWip - wipByLittle) / avgWip : 0;

  // ───────────────── Element metrics ─────────────────
  const elementMetrics = computeElementMetrics(
    eventsRows, taskRows, elementsById,
  );

  // ───────────────── Resource (lane) metrics ─────────────────
  const resourceMetrics = computeResourceMetrics(
    taskRows, summaryRows, config,
  );

  // ───────────────── Per-process metrics ─────────────────
  const processMetrics = computeProcessMetrics(casesRows);

  // ───────────────── CTE ─────────────────
  const cteAnalysis = computeCycleTimeEfficiency(rootCases, taskRows);

  // ───────────────── Bottlenecks ─────────────────
  const bottlenecks = detectBottlenecks(elementMetrics, resourceMetrics);

  // ───────────────── Qualitative notes ─────────────────
  const qualitativeNotes = generateQualitativeNotes(
    elementMetrics, bottlenecks, resourceMetrics,
    avgCycleTime, completedCases, totalCases,
    littleResidual, cteAnalysis,
  );

  return {
    avgCycleTime: round(avgCycleTime),
    minCycleTime: round(minCycleTime),
    maxCycleTime: round(maxCycleTime),
    medianCycleTime: round(medianCycleTime),
    p90CycleTime: round(p90CycleTime),
    p95CycleTime: round(p95CycleTime),
    stdCycleTime: round(stdCycleTime),
    completedCases,
    totalCases,
    throughput: round(throughput),
    avgWip: round(avgWip),
    wipByLittle: round(wipByLittle),
    littleResidual: round(littleResidual),
    simEndTime: round(simEndTime),
    elementMetrics,
    resourceMetrics,
    processMetrics,
    cycleTimeEfficiency: round(cteAnalysis.cte),
    avgProcessingTime: round(cteAnalysis.avgProcessing),
    avgWaitingTime: round(cteAnalysis.avgWaiting),
    bottlenecks,
    qualitativeNotes,
  };
}

// ───────────────── Element metrics ─────────────────
function computeElementMetrics(eventsRows, taskRows, elementsById) {
  const visitCounts = new Map();
  for (const ev of eventsRows) {
    if (ev.eventType === 'enter' && ev.elementId) {
      visitCounts.set(ev.elementId, (visitCounts.get(ev.elementId) || 0) + 1);
    }
  }

  const taskAgg = new Map();
  for (const ts of taskRows || []) {
    if (!ts.taskId) continue;
    if (ts.outcome === 'canceled_by_boundary_timer') continue;
    const id = ts.taskId;
    const dur = ts.duration || 0;
    const wait = ts.waitTime || 0;
    const agg = taskAgg.get(id) || {
      totalDur: 0, minDur: Infinity, maxDur: -Infinity,
      totalWait: 0, maxWait: -Infinity, count: 0,
    };
    agg.totalDur += dur;
    agg.minDur = Math.min(agg.minDur, dur);
    agg.maxDur = Math.max(agg.maxDur, dur);
    agg.totalWait += wait;
    agg.maxWait = Math.max(agg.maxWait, wait);
    agg.count += 1;
    taskAgg.set(id, agg);
  }

  const metrics = [];
  const allIds = new Set([...visitCounts.keys(), ...taskAgg.keys()]);

  for (const elId of allIds) {
    const el = elementsById ? elementsById.get(elId) : null;
    const elType = el ? el.$type || '' : '';
    const elName = el ? el.name || '' : '';
    const visits = visitCounts.get(elId) || 0;
    const ta = taskAgg.get(elId);

    metrics.push({
      elementId: elId,
      elementType: elType,
      elementName: elName,
      visits,
      totalTime: ta ? round(ta.totalDur) : 0,
      avgTime: ta ? round(ta.totalDur / ta.count) : 0,
      minTime: ta && ta.minDur !== Infinity ? round(ta.minDur) : 0,
      maxTime: ta && ta.maxDur !== -Infinity ? round(ta.maxDur) : 0,
      waitTime: ta ? round(ta.totalWait) : 0,
      avgWaitTime: ta ? round(ta.totalWait / ta.count) : 0,
      maxWaitTime:
        ta && ta.maxWait !== -Infinity ? round(ta.maxWait) : 0,
      isBottleneck: false,
    });
  }

  metrics.sort(
    (a, b) => (b.totalTime + b.waitTime) - (a.totalTime + a.waitTime),
  );
  return metrics;
}

// ───────────────── Resource (lane) metrics ─────────────────
function computeResourceMetrics(taskRows, summaryRows, cfg) {
  const resCfg = cfg?.resources || {};
  if (Object.keys(resCfg).length === 0) return [];

  const laneById = new Map();
  for (const [laneId, spec] of Object.entries(resCfg)) {
    laneById.set(laneId, {
      laneId,
      name: spec.name || laneId,
      capacity: Number(spec.capacity ?? 1),
      busyTime: 0,
      taskCount: 0,
      totalWait: 0,
      maxWait: 0,
    });
  }

  const laneByTask = cfg?._laneOfElement || null;

  for (const ts of taskRows || []) {
    if (!ts.taskId) continue;
    const laneId = laneByTask ? laneByTask.get(ts.taskId) : null;
    if (!laneId || !laneById.has(laneId)) continue;
    const r = laneById.get(laneId);
    r.busyTime += (ts.duration || 0);
    r.taskCount += 1;
    r.totalWait += (ts.waitTime || 0);
    r.maxWait = Math.max(r.maxWait, ts.waitTime || 0);
  }

  const reps = summaryRows.length || 1;
  const totalSimTime = summaryRows.reduce((a, b) => a + (b.simEndTime || 0), 0);

  const out = [];
  for (const r of laneById.values()) {
    const denom = r.capacity * totalSimTime;
    const utilization = denom > 0 ? r.busyTime / denom : 0;
    const avgWait = r.taskCount > 0 ? r.totalWait / r.taskCount : 0;
    out.push({
      laneId: r.laneId,
      name: r.name,
      capacity: r.capacity,
      utilization: round(utilization),
      busyTime: round(r.busyTime / reps),
      avgSimTime: round(totalSimTime / reps),
      taskCount: r.taskCount,
      avgWait: round(avgWait),
      maxWait: round(r.maxWait),
      isOverloaded: utilization > 0.85,
      isUnderused: utilization < 0.3,
    });
  }
  out.sort((a, b) => b.utilization - a.utilization);
  return out;
}

// ───────────────── Per-process metrics ─────────────────
function computeProcessMetrics(casesRows) {
  const byProcess = new Map();
  for (const c of casesRows || []) {
    const pid = c.processId || 'unknown';
    if (!byProcess.has(pid)) byProcess.set(pid, []);
    byProcess.get(pid).push(c);
  }
  const out = [];
  for (const [pid, cases] of byProcess.entries()) {
    const completed = cases.filter((c) => c.completed && c.cycleTime != null);
    const cts = completed.map((c) => c.cycleTime).sort((a, b) => a - b);
    out.push({
      processId: pid,
      totalCases: cases.length,
      completedCases: completed.length,
      completionRate:
        cases.length > 0 ? round(completed.length / cases.length) : 0,
      avgCycleTime: round(mean(cts)),
      medianCycleTime: round(percentile(cts, 0.5)),
      p90CycleTime: round(percentile(cts, 0.9)),
      maxCycleTime: round(cts[cts.length - 1] || 0),
    });
  }
  return out;
}

// ───────────────── Cycle Time Efficiency ─────────────────
function computeCycleTimeEfficiency(rootCases, taskRows) {
  if (!rootCases || rootCases.length === 0 || !taskRows || taskRows.length === 0) {
    return { cte: 0, avgProcessing: 0, avgWaiting: 0 };
  }
  // For collaboration: a "root case" customer triggers sub-instances.
  // Aggregate by rootCaseId from the engine (taskRows carry caseId of the
  // sub-instance — we map back via the "|" separator).
  const taskByRoot = new Map();
  for (const ts of taskRows) {
    if (!ts.caseId) continue;
    const root = String(ts.caseId).split('|')[0];
    if (!taskByRoot.has(root)) taskByRoot.set(root, { dur: 0, wait: 0 });
    const agg = taskByRoot.get(root);
    agg.dur += ts.duration || 0;
    agg.wait += ts.waitTime || 0;
  }
  let sumProc = 0;
  let sumWait = 0;
  let sumCT = 0;
  let n = 0;
  for (const c of rootCases) {
    const t = taskByRoot.get(c.caseId);
    if (!t) continue;
    sumProc += t.dur;
    sumWait += t.wait;
    sumCT += c.cycleTime;
    n += 1;
  }
  if (n === 0) return { cte: 0, avgProcessing: 0, avgWaiting: 0 };
  const avgProcessing = sumProc / n;
  const avgWaiting = sumWait / n;
  const avgCT = sumCT / n;
  const cte = avgCT > 0 ? avgProcessing / avgCT : 0;
  return { cte, avgProcessing, avgWaiting };
}

// ───────────────── Bottleneck detection ─────────────────
function detectBottlenecks(elementMetrics, resourceMetrics) {
  const tasks = elementMetrics.filter(
    (m) => (m.elementType.endsWith('Task')
        || m.elementType === 'bpmn:Task'
        || m.elementType === 'bpmn:SubProcess')
      && (m.totalTime > 0 || m.waitTime > 0),
  );
  if (tasks.length === 0) return [];

  const maxTotal = Math.max(...tasks.map((m) => m.totalTime), 0);
  const maxAvg = Math.max(...tasks.map((m) => m.avgTime), 0);
  const maxWait = Math.max(...tasks.map((m) => m.waitTime), 0);

  const bottlenecks = [];
  const hasWaitSignal = maxWait > 0;
  for (const m of tasks) {
    const totalRatio = maxTotal > 0 ? m.totalTime / maxTotal : 0;
    const avgRatio = maxAvg > 0 ? m.avgTime / maxAvg : 0;
    const waitRatio = maxWait > 0 ? m.waitTime / maxWait : 0;
    // When the engine produced no wait signal (no resource contention modelled),
    // fall back to the legacy duration-only score. Otherwise privilege queueing
    // time, the canonical BPM bottleneck signal.
    const score = hasWaitSignal
      ? totalRatio * 0.3 + avgRatio * 0.2 + waitRatio * 0.5
      : totalRatio * 0.6 + avgRatio * 0.4;
    if (score >= 0.6 || waitRatio >= 0.85) {
      m.isBottleneck = true;
      bottlenecks.push(m);
    }
  }
  return bottlenecks;
}

// ───────────────── Qualitative notes ─────────────────
function generateQualitativeNotes(
  elementMetrics, bottlenecks, resourceMetrics,
  avgCycleTime, completed, total,
  littleResidual, cte,
) {
  const notes = [];

  if (total > 0 && completed < total) {
    const pct = ((completed / total) * 100).toFixed(1);
    notes.push(
      `⚠️ Taxa de conclusão: ${pct}% (${completed}/${total} casos). Considere aumentar o tempo de simulação ou verificar gargalos/deadlocks.`,
    );
  }

  if (cte && cte.cte > 0) {
    const ctePct = (cte.cte * 100).toFixed(1);
    if (cte.cte < 0.3) {
      notes.push(
        `🐢 Eficiência do tempo de ciclo (CTE) baixa: ${ctePct}% — processamento ${cte.avgProcessing.toFixed(2)} de ${(cte.avgProcessing + cte.avgWaiting).toFixed(2)} unidades. A maior parte do cycle time é espera em fila.`,
      );
    } else if (cte.cte > 0.7) {
      notes.push(
        `⚡ Eficiência do tempo de ciclo (CTE) alta: ${ctePct}%. Pouca espera no processo.`,
      );
    } else {
      notes.push(
        `📊 Eficiência do tempo de ciclo (CTE): ${ctePct}% (processamento ${cte.avgProcessing.toFixed(2)} / espera ${cte.avgWaiting.toFixed(2)}).`,
      );
    }
  }

  const overloaded = (resourceMetrics || []).filter((r) => r.isOverloaded);
  if (overloaded.length > 0) {
    const list = overloaded
      .map((r) => `${r.name} (ρ=${(r.utilization * 100).toFixed(1)}%)`)
      .join(', ');
    notes.push(
      `🔥 Recursos saturados (ρ>85%): ${list}. Pela teoria das filas, o tempo de espera cresce exponencialmente próximo de ρ=1.`,
    );
  }

  const idle = (resourceMetrics || []).filter((r) => r.isUnderused);
  if (idle.length > 0 && overloaded.length === 0) {
    const list = idle
      .map((r) => `${r.name} (ρ=${(r.utilization * 100).toFixed(1)}%)`)
      .join(', ');
    notes.push(`💤 Recursos subutilizados: ${list}.`);
  }

  if (bottlenecks.length > 0) {
    const names = bottlenecks
      .map((b) => b.elementName || b.elementId)
      .join(', ');
    notes.push(`🔴 Gargalos identificados: ${names}.`);
  }

  const waiters = elementMetrics
    .filter((m) => m.waitTime > 0)
    .sort((a, b) => b.waitTime - a.waitTime);
  if (waiters.length > 0) {
    const top = waiters[0];
    notes.push(
      `⏳ Maior tempo de espera em fila: "${top.elementName || top.elementId}" (total ${top.waitTime.toFixed(2)}, médio ${top.avgWaitTime.toFixed(2)}).`,
    );
  }

  if (littleResidual > 0.2 && avgCycleTime > 0) {
    notes.push(
      `📐 Lei de Little: WIP diverge ${(littleResidual * 100).toFixed(1)}% do produto throughput×CT. Considere aumentar replicações ou warm-up para reduzir efeito transiente.`,
    );
  }

  if (notes.length === 0) {
    notes.push('✅ Nenhum problema qualitativo significativo detectado nesta simulação.');
  }
  return notes;
}

// ───────────────── helpers ─────────────────
function mean(arr) {
  if (!arr || arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
function stddev(arr, mu) {
  if (!arr || arr.length < 2) return 0;
  const variance =
    arr.reduce((a, b) => a + (b - mu) * (b - mu), 0) / (arr.length - 1);
  return Math.sqrt(variance);
}
function percentile(sorted, p) {
  if (!sorted || sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}
function round(v, d = 4) {
  if (!Number.isFinite(v)) return 0;
  const f = Math.pow(10, d);
  return Math.round(v * f) / f;
}
