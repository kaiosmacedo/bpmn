/**
 * Deterministic Integration Test
 * 
 * Validates the simulation engine produces EXACT expected results
 * for a simple linear process with fixed durations and fixed arrivals.
 *
 * Process: Start → Registrar(5min) → Analisar(10min) → Aprovar(5min) → End
 * Resource: 1 "Analista" (capacity=1), shared across all tasks (via lane)
 * Arrivals: fixed every 15 min, maxSimTime=100 → 7 instances
 *
 * Because inter-arrival(15) < processing(20), queuing builds up.
 * All values are deterministic (fixed distributions, 1 replication).
 *
 * Run: node src/batchsim/__tests__/validate-deterministic.mjs
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

import BpmnModdle from "bpmn-moddle";
import { buildGraph } from "../graph.js";
import { runBatch } from "../engine.js";
import { mulberry32 } from "../utils.js";
import { computeMetrics } from "../metrics.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`    ✔ ${msg}`);
  } else {
    failed++;
    console.error(`    ✘ FAIL: ${msg}`);
  }
}

function assertApprox(actual, expected, tolerance, msg) {
  const diff = Math.abs(actual - expected);
  if (diff <= tolerance) {
    passed++;
    console.log(`    ✔ ${msg} (got ${actual.toFixed(2)}, expected ${expected})`);
  } else {
    failed++;
    console.error(`    ✘ FAIL: ${msg} — got ${actual.toFixed(4)}, expected ${expected}, diff=${diff.toFixed(4)}`);
  }
}

function test(name, fn) {
  console.log(`\n▶ ${name}`);
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      return result.catch((e) => {
        failed++;
        console.error(`  EXCEPTION: ${e.message}\n${e.stack}`);
      });
    }
  } catch (e) {
    failed++;
    console.error(`  EXCEPTION: ${e.message}\n${e.stack}`);
  }
}

// ── Load and parse simple-deterministic.bpmn ──
const bpmnPath = resolve(__dirname, "../../../diagrams/simple-deterministic.bpmn");
const bpmnXml = readFileSync(bpmnPath, "utf-8");

const moddle = new BpmnModdle();
const { rootElement: definitions } = await moddle.fromXML(bpmnXml);

// ── Load sim config ──
const cfgPath = resolve(__dirname, "../../../diagrams/simulations/simple-deterministic.sim.json");
const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));

// ── Build graph ──
const graph = buildGraph(definitions);

test("Graph - correct structure", () => {
  assert(graph.elementsById.has("StartEvent_1"), "StartEvent_1 exists");
  assert(graph.elementsById.has("Task_Registrar"), "Task_Registrar exists");
  assert(graph.elementsById.has("Task_Analisar"), "Task_Analisar exists");
  assert(graph.elementsById.has("Task_Aprovar"), "Task_Aprovar exists");
  assert(graph.elementsById.has("EndEvent_1"), "EndEvent_1 exists");

  // Lane mapping — each task in its own lane
  assert(
    graph.laneOfElement.get("Task_Registrar") === "Lane_Registro",
    "Task_Registrar → Lane_Registro"
  );
  assert(
    graph.laneOfElement.get("Task_Analisar") === "Lane_Analise",
    "Task_Analisar → Lane_Analise"
  );
  assert(
    graph.laneOfElement.get("Task_Aprovar") === "Lane_Aprovacao",
    "Task_Aprovar → Lane_Aprovacao"
  );
});

// ── Run simulation ──
const results = await runBatch({ graph, cfg, rng: mulberry32 });
const events = results.eventsRows;

test("Simulation completes", () => {
  assert(results != null, "runBatch returned results");
  assert(events.length > 0, `has events (${events.length})`);
});

// ── Analyze taskRows for each case (most reliable timing data) ──
const caseTimelines = new Map(); // caseId → { arrive, tasks: { taskId: {start, end, wait} }, endTime }

// Get arrival times from events
for (const ev of events) {
  if (!ev.caseId) continue;
  if (!caseTimelines.has(ev.caseId)) {
    caseTimelines.set(ev.caseId, { arrive: null, tasks: {}, endTime: null });
  }
  const c = caseTimelines.get(ev.caseId);
  if (ev.eventType === "case_start") c.arrive = ev.simTime;
  if (ev.eventType === "case_end") c.endTime = ev.simTime;
}

// Get task timings from taskRows (precise start/end/wait)
for (const span of results.taskRows) {
  const c = caseTimelines.get(span.caseId);
  if (!c) continue;
  c.tasks[span.taskId] = { start: span.startTime, end: span.endTime, wait: span.waitTime };
}

// Sort cases by arrival time
const cases = [...caseTimelines.entries()]
  .sort((a, b) => a[1].arrive - b[1].arrive);

// ── Expected values (hand-calculated) ──
// 3 separate resources. Only Analisar creates queue (dur=10 > inter-arrival=9).
// Registrar_start(n) = 9*(n-1), Registrar_end(n) = 9*(n-1)+5
// Analisar_start(n) = max(Reg_end(n), Ana_end(n-1)) = 5 + 10*(n-1)
// Analisar_end(n) = 5 + 10*n
// Aprovar_start(n) = Ana_end(n) [Gerente always free]
// cycle(n) = 20 + (n-1)
const expected = [
  { arrive: 0,  reg: [0, 5],   ana: [5, 15],  apr: [15, 20], cycle: 20, anaWait: 0 },
  { arrive: 9,  reg: [9, 14],  ana: [15, 25], apr: [25, 30], cycle: 21, anaWait: 1 },
  { arrive: 18, reg: [18, 23], ana: [25, 35], apr: [35, 40], cycle: 22, anaWait: 2 },
  { arrive: 27, reg: [27, 32], ana: [35, 45], apr: [45, 50], cycle: 23, anaWait: 3 },
  { arrive: 36, reg: [36, 41], ana: [45, 55], apr: [55, 60], cycle: 24, anaWait: 4 },
  { arrive: 45, reg: [45, 50], ana: [55, 65], apr: [65, 70], cycle: 25, anaWait: 5 },
];

test(`Correct number of instances (expect 6)`, () => {
  assert(cases.length === 6, `generated ${cases.length} cases, expected 6`);
});

test("Per-instance timing validation", () => {
  const tolerance = 0.01; // floating point tolerance

  for (let i = 0; i < Math.min(cases.length, expected.length); i++) {
    const [caseId, actual] = cases[i];
    const exp = expected[i];
    const label = `Case ${i + 1} (${caseId})`;

    assertApprox(actual.arrive, exp.arrive, tolerance, `${label} arrive`);

    if (actual.tasks["Task_Registrar"]) {
      assertApprox(actual.tasks["Task_Registrar"].start, exp.reg[0], tolerance, `${label} Registrar start`);
      assertApprox(actual.tasks["Task_Registrar"].end, exp.reg[1], tolerance, `${label} Registrar end`);
    } else {
      failed++;
      console.error(`    ✘ ${label} missing Task_Registrar`);
    }

    if (actual.tasks["Task_Analisar"]) {
      assertApprox(actual.tasks["Task_Analisar"].start, exp.ana[0], tolerance, `${label} Analisar start`);
      assertApprox(actual.tasks["Task_Analisar"].end, exp.ana[1], tolerance, `${label} Analisar end`);
    } else {
      failed++;
      console.error(`    ✘ ${label} missing Task_Analisar`);
    }

    if (actual.tasks["Task_Aprovar"]) {
      assertApprox(actual.tasks["Task_Aprovar"].start, exp.apr[0], tolerance, `${label} Aprovar start`);
      assertApprox(actual.tasks["Task_Aprovar"].end, exp.apr[1], tolerance, `${label} Aprovar end`);
    } else {
      failed++;
      console.error(`    ✘ ${label} missing Task_Aprovar`);
    }

    // Cycle time = endTime - arrive
    if (actual.endTime != null) {
      assertApprox(actual.endTime - actual.arrive, exp.cycle, tolerance, `${label} cycle time`);
    }
  }
});

test("Aggregate metrics validation", () => {
  // Compute metrics using the engine's raw output
  const metrics = computeMetrics(results, graph.elementsById, cfg);

  console.log(`    Process metrics:`, JSON.stringify({
    avgCycleTime: metrics.avgCycleTime,
    avgProcessingTime: metrics.avgProcessingTime,
    avgWaitingTime: metrics.avgWaitingTime,
    throughput: metrics.throughput,
    completedCases: metrics.completedCases,
    simEndTime: metrics.simEndTime,
  }, null, 2));

  // avgCycleTime should be mean(20,21,22,23,24,25) = 22.5
  if (metrics.avgCycleTime != null) {
    assertApprox(metrics.avgCycleTime, 22.5, 0.5, "avgCycleTime ≈ 22.5");
  }

  // avgProcessingTime should be constant = 20.0
  if (metrics.avgProcessingTime != null) {
    assertApprox(metrics.avgProcessingTime, 20.0, 0.5, "avgProcessingTime ≈ 20.0");
  }

  // avgWaitTime should be mean(0,1,2,3,4,5) = 2.5
  if (metrics.avgWaitingTime != null) {
    assertApprox(metrics.avgWaitingTime, 2.5, 0.5, "avgWaitingTime ≈ 2.5");
  }

  // Throughput = 6 cases / 70 time-units ≈ 0.0857
  if (metrics.throughput != null) {
    assertApprox(metrics.throughput, 0.0857, 0.015, "throughput ≈ 0.086");
  }

  // Resource utilization: Analista (Lane_Analise) busy 60/70 ≈ 85.7%
  if (metrics.resourceMetrics) {
    const keys = metrics.resourceMetrics instanceof Map
      ? [...metrics.resourceMetrics.keys()]
      : Object.keys(metrics.resourceMetrics);
    console.log(`    Resource metrics keys:`, keys);
    const analista = metrics.resourceMetrics instanceof Map
      ? metrics.resourceMetrics.get("Lane_Analise")
      : metrics.resourceMetrics["Lane_Analise"];
    if (analista) {
      console.log(`    Analista metrics:`, JSON.stringify(analista));
      const util = analista.utilization ?? analista.avgUtilization ?? 0;
      assertApprox(util, 0.857, 0.05, "Analista utilization ≈ 85.7%");
    }
  }
});

// ── Print summary ──
console.log(`\n${"═".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("═".repeat(40));
if (failed > 0) process.exit(1);
