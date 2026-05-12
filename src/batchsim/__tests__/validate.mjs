/**
 * Smoke validation for metrics.js and logger.js
 *
 * Run: node --experimental-vm-modules src/batchsim/__tests__/validate.mjs
 *
 * No external test framework required.
 */

import { computeMetrics } from "../metrics.js";
import { buildStructuredLog } from "../logger.js";
import { SimulationEventType } from "../models.js";

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

function test(name, fn) {
  console.log(`\n▶ ${name}`);
  try {
    fn();
  } catch (e) {
    failed++;
    console.error(`  EXCEPTION: ${e.message}`);
  }
}

// ────────────────────────────────────────────
// metrics.js tests
// ────────────────────────────────────────────

test("computeMetrics - empty input", () => {
  const result = computeMetrics(
    {
      eventsRows: [],
      summaryRows: [],
      casesRows: [],
      taskRows: [],
      pathRows: [],
    },
    new Map(),
  );

  assert(result.avgCycleTime === 0, "avgCycleTime should be 0");
  assert(result.completedCases === 0, "completedCases should be 0");
  assert(result.totalCases === 0, "totalCases should be 0");
  assert(result.throughput === 0, "throughput should be 0");
  assert(result.bottlenecks.length === 0, "no bottlenecks");
  assert(Array.isArray(result.elementMetrics), "elementMetrics is array");
  assert(Array.isArray(result.qualitativeNotes), "qualitativeNotes is array");
});

test("computeMetrics - with completed cases", () => {
  const casesRows = [
    { caseId: "C1", completed: 1, cycleTime: 10, startTime: 0, endTime: 10 },
    { caseId: "C2", completed: 1, cycleTime: 20, startTime: 0, endTime: 20 },
    { caseId: "C3", completed: 1, cycleTime: 30, startTime: 0, endTime: 30 },
    {
      caseId: "C4",
      completed: 0,
      cycleTime: null,
      startTime: 0,
      endTime: null,
    },
  ];

  const summaryRows = [{ throughput: 0.1, avgWip: 2.0, completedCases: 3 }];
  const eventsRows = [
    { eventType: "enter", elementId: "task1", simTime: 1 },
    { eventType: "enter", elementId: "task1", simTime: 2 },
    { eventType: "enter", elementId: "task1", simTime: 3 },
  ];
  const taskRows = [
    { taskId: "task1", duration: 5, startTime: 1, endTime: 6 },
    { taskId: "task1", duration: 3, startTime: 2, endTime: 5 },
  ];

  const elementsById = new Map([
    ["task1", { $type: "bpmn:UserTask", id: "task1", name: "Review Order" }],
  ]);

  const result = computeMetrics(
    { eventsRows, summaryRows, casesRows, taskRows, pathRows: [] },
    elementsById,
  );

  assert(
    result.completedCases === 3,
    `completedCases is 3, got ${result.completedCases}`,
  );
  assert(result.totalCases === 4, `totalCases is 4, got ${result.totalCases}`);
  assert(
    result.avgCycleTime === 20,
    `avgCycleTime is 20, got ${result.avgCycleTime}`,
  );
  assert(
    result.minCycleTime === 10,
    `minCycleTime is 10, got ${result.minCycleTime}`,
  );
  assert(
    result.maxCycleTime === 30,
    `maxCycleTime is 30, got ${result.maxCycleTime}`,
  );
  assert(
    result.throughput === 0.1,
    `throughput is 0.1, got ${result.throughput}`,
  );
  assert(result.avgWip === 2, `avgWip is 2, got ${result.avgWip}`);
  assert(result.elementMetrics.length > 0, "has element metrics");

  const task1 = result.elementMetrics.find((m) => m.elementId === "task1");
  assert(task1 !== undefined, "task1 metric exists");
  assert(task1.visits === 3, `task1 visits is 3, got ${task1?.visits}`);
  assert(task1.avgTime === 4, `task1 avgTime is 4, got ${task1?.avgTime}`);
  assert(task1.elementName === "Review Order", `task1 name correct`);
});

test("computeMetrics - no divide by zero in bottlenecks", () => {
  const eventsRows = [{ eventType: "enter", elementId: "gw1", simTime: 1 }];
  const elementsById = new Map([
    ["gw1", { $type: "bpmn:ExclusiveGateway", id: "gw1", name: "Decision" }],
  ]);

  const result = computeMetrics(
    {
      eventsRows,
      summaryRows: [{ throughput: 0, avgWip: 0 }],
      casesRows: [],
      taskRows: [],
      pathRows: [],
    },
    elementsById,
  );

  assert(result.bottlenecks.length === 0, "gateway should not be bottleneck");
});

test("computeMetrics - bottleneck detection", () => {
  const taskRows = [
    { taskId: "slow", duration: 100, startTime: 0, endTime: 100 },
    { taskId: "fast", duration: 1, startTime: 0, endTime: 1 },
  ];
  const eventsRows = [
    { eventType: "enter", elementId: "slow", simTime: 0 },
    { eventType: "enter", elementId: "fast", simTime: 0 },
  ];
  const elementsById = new Map([
    ["slow", { $type: "bpmn:ServiceTask", id: "slow", name: "Slow Task" }],
    ["fast", { $type: "bpmn:UserTask", id: "fast", name: "Fast Task" }],
  ]);

  const result = computeMetrics(
    {
      eventsRows,
      summaryRows: [{ throughput: 0.5, avgWip: 1 }],
      casesRows: [{ caseId: "C1", completed: 1, cycleTime: 101 }],
      taskRows,
      pathRows: [],
    },
    elementsById,
  );

  assert(
    result.bottlenecks.length >= 1,
    `at least 1 bottleneck, got ${result.bottlenecks.length}`,
  );
  const slowBn = result.bottlenecks.find((b) => b.elementId === "slow");
  assert(slowBn !== undefined, "slow task is a bottleneck");
});

// ────────────────────────────────────────────
// logger.js tests
// ────────────────────────────────────────────

test("buildStructuredLog - basic events", () => {
  const eventsRows = [
    {
      simTime: 0,
      eventType: "case_start",
      caseId: "C1",
      tokenId: "T1",
      elementId: "start1",
      elementType: "bpmn:StartEvent",
    },
    {
      simTime: 1,
      eventType: "enter",
      caseId: "C1",
      tokenId: "T1",
      elementId: "task1",
      elementType: "bpmn:UserTask",
    },
    {
      simTime: 5,
      eventType: "task_complete",
      caseId: "C1",
      tokenId: "T1",
      elementId: "task1",
      elementType: "bpmn:UserTask",
    },
    {
      simTime: 5,
      eventType: "case_end",
      caseId: "C1",
      tokenId: "T1",
      elementId: "end1",
      elementType: "bpmn:EndEvent",
    },
  ];

  const elementsById = new Map([
    ["start1", { $type: "bpmn:StartEvent", id: "start1", name: "" }],
    ["task1", { $type: "bpmn:UserTask", id: "task1", name: "Process Order" }],
    ["end1", { $type: "bpmn:EndEvent", id: "end1", name: "" }],
  ]);

  const cfg = {
    replications: 1,
    seed: 42,
    maxSimTime: 100,
    startEventId: "start1",
  };
  const log = buildStructuredLog(eventsRows, elementsById, cfg);

  assert(
    log.length >= 6,
    `log has sim_start + 4 events + sim_end, got ${log.length}`,
  );
  assert(
    log[0].eventType === SimulationEventType.SIM_START,
    "first entry is sim_start",
  );
  assert(
    log[log.length - 1].eventType === SimulationEventType.SIM_END,
    "last entry is sim_end",
  );

  const taskEntry = log.find(
    (e) => e.elementId === "task1" && e.eventType === SimulationEventType.ENTER,
  );
  assert(taskEntry !== undefined, "has enter event for task1");
  assert(taskEntry.elementName === "Process Order", "element name resolved");
  assert(taskEntry.message.includes("Process Order"), "message includes name");
});

test("buildStructuredLog - unsupported elements", () => {
  const eventsRows = [
    {
      simTime: 0,
      eventType: "enter",
      caseId: "C1",
      tokenId: "T1",
      elementId: "weird1",
      elementType: "bpmn:ComplexGateway",
    },
    {
      simTime: 1,
      eventType: "enter",
      caseId: "C1",
      tokenId: "T1",
      elementId: "weird1",
      elementType: "bpmn:ComplexGateway",
    },
  ];

  const elementsById = new Map([
    ["weird1", { $type: "bpmn:ComplexGateway", id: "weird1", name: "Complex" }],
  ]);

  const cfg = { replications: 1, seed: 1 };
  const log = buildStructuredLog(eventsRows, elementsById, cfg);

  const warnings = log.filter(
    (e) => e.eventType === SimulationEventType.UNSUPPORTED_ELEMENT,
  );
  assert(
    warnings.length === 1,
    `exactly 1 unsupported warning (not duplicated), got ${warnings.length}`,
  );
  assert(warnings[0].level === "warn", "level is warn");
});

test("buildStructuredLog - empty events", () => {
  const log = buildStructuredLog([], new Map(), { replications: 1 });
  assert(log.length === 2, `has sim_start and sim_end, got ${log.length}`);
  assert(
    log[0].eventType === SimulationEventType.SIM_START,
    "starts with sim_start",
  );
  assert(log[1].eventType === SimulationEventType.SIM_END, "ends with sim_end");
});

// ────────────────────────────────────────────
// Summary
// ────────────────────────────────────────────
console.log(`\n${"═".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("═".repeat(40));
process.exit(failed > 0 ? 1 : 0);
