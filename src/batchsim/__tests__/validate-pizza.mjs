/**
 * Integration test: buildGraph + runBatch with the actual pizza-collaboration BPMN.
 *
 * Run: node --experimental-vm-modules src/batchsim/__tests__/validate-pizza.mjs
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

import BpmnModdle from "bpmn-moddle";
import { buildGraph } from "../graph.js";
import { runBatch } from "../engine.js";
import { mulberry32 } from "../utils.js";
import { computeMetrics } from "../metrics.js";
import { buildStructuredLog } from "../logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
    console.error(`  EXCEPTION: ${e.message}\n${e.stack}`);
  }
}

// ── Load and parse pizza-collaboration.bpmn ──
const bpmnPath = resolve(
  __dirname,
  "../../../diagrams/pizza-collaboration.bpmn",
);
const bpmnXml = readFileSync(bpmnPath, "utf-8");

const moddle = new BpmnModdle();
const { rootElement: definitions } = await moddle.fromXML(bpmnXml);

// ── Load sim config ──
const cfgPath = resolve(
  __dirname,
  "../../../diagrams/simulations/pizza-collaboration.sim.json",
);
const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));

test("buildGraph - parses all processes in collaboration", () => {
  const graph = buildGraph(definitions);

  assert(
    graph.elementsById.size > 0,
    `has elements, got ${graph.elementsById.size}`,
  );
  assert(
    graph.startEvents.length >= 2,
    `has ≥2 start events (collaboration), got ${graph.startEvents.length}: ${graph.startEvents.join(", ")}`,
  );

  // _6-61 is the customer start event
  assert(
    graph.elementsById.has("_6-61"),
    "_6-61 (Hungry for pizza) exists in graph",
  );

  // _6-450 is the vendor start event
  assert(
    graph.elementsById.has("_6-450"),
    "_6-450 (Order received) exists in graph",
  );

  // Check some tasks
  assert(graph.elementsById.has("_6-74"), "_6-74 (Select a pizza) exists");
  assert(graph.elementsById.has("_6-463"), "_6-463 (Bake the pizza) exists");

  // Check event-based gateway
  assert(graph.elementsById.has("_6-180"), "_6-180 (EventBasedGateway) exists");
  const gw = graph.elementsById.get("_6-180");
  assert(
    gw.$type === "bpmn:EventBasedGateway",
    `_6-180 type is EventBasedGateway, got ${gw.$type}`,
  );

  // Check parallel gateway
  assert(graph.elementsById.has("_6-652"), "_6-652 (ParallelGateway) exists");
  const pg = graph.elementsById.get("_6-652");
  assert(
    pg.$type === "bpmn:ParallelGateway",
    `_6-652 type is ParallelGateway, got ${pg.$type}`,
  );

  // outgoing flows
  const gwOuts = graph.outgoingById.get("_6-180") || [];
  assert(
    gwOuts.length === 2,
    `EventBasedGateway _6-180 has 2 outgoing flows, got ${gwOuts.length}`,
  );
});

test("runBatch - pizza collaboration with startEventId=_6-61", async () => {
  const graph = buildGraph(definitions);

  // Small run: 3 replications
  const smallCfg = { ...cfg, replications: 3, maxSimTime: 200 };
  const rngFactory = (seed) => mulberry32(seed);
  const results = await runBatch({ graph, cfg: smallCfg, rng: rngFactory });

  assert(
    results.eventsRows.length > 0,
    `has event rows, got ${results.eventsRows.length}`,
  );
  assert(
    results.summaryRows.length === 3,
    `has 3 summary rows, got ${results.summaryRows.length}`,
  );
  assert(
    results.casesRows.length > 0,
    `has case rows, got ${results.casesRows.length}`,
  );

  // Check that tokens actually proceed past the start event (no token_error)
  const errors = results.eventsRows.filter(
    (e) => e.eventType === "token_error",
  );
  assert(errors.length === 0, `no token_error events, got ${errors.length}`);

  // Check that some cases completed
  const completedCases = results.casesRows.filter((c) => c.completed === 1);
  assert(
    completedCases.length > 0,
    `has completed cases, got ${completedCases.length}`,
  );

  // Check cycle times exist
  const withCycleTime = completedCases.filter(
    (c) => c.cycleTime != null && c.cycleTime > 0,
  );
  assert(
    withCycleTime.length > 0,
    `has cases with cycle time, got ${withCycleTime.length}`,
  );

  console.log(`    Events: ${results.eventsRows.length}`);
  console.log(
    `    Completed cases: ${completedCases.length}/${results.casesRows.length}`,
  );
  if (withCycleTime.length > 0) {
    const avg =
      withCycleTime.reduce((a, c) => a + c.cycleTime, 0) / withCycleTime.length;
    console.log(`    Avg cycle time: ${avg.toFixed(2)}`);
  }
});

test("computeMetrics - pizza collaboration results", async () => {
  const graph = buildGraph(definitions);
  const smallCfg = { ...cfg, replications: 3, maxSimTime: 200 };
  const rngFactory = (seed) => mulberry32(seed);
  const results = await runBatch({ graph, cfg: smallCfg, rng: rngFactory });
  const metrics = computeMetrics(results, graph.elementsById);

  assert(
    metrics.completedCases > 0,
    `completed cases > 0, got ${metrics.completedCases}`,
  );
  assert(
    metrics.avgCycleTime > 0,
    `avg cycle time > 0, got ${metrics.avgCycleTime}`,
  );
  assert(metrics.throughput > 0, `throughput > 0, got ${metrics.throughput}`);
  assert(metrics.elementMetrics.length > 0, `has element metrics`);

  console.log(`    Avg cycle: ${metrics.avgCycleTime}`);
  console.log(`    Throughput: ${metrics.throughput}`);
  console.log(`    Bottlenecks: ${metrics.bottlenecks.length}`);
  console.log(`    Qualitative notes: ${metrics.qualitativeNotes.length}`);
});

test("buildStructuredLog - pizza collaboration", async () => {
  const graph = buildGraph(definitions);
  const smallCfg = { ...cfg, replications: 1, maxSimTime: 100 };
  const rngFactory = (seed) => mulberry32(seed);
  const results = await runBatch({ graph, cfg: smallCfg, rng: rngFactory });
  const log = buildStructuredLog(
    results.eventsRows,
    graph.elementsById,
    smallCfg,
  );

  assert(log.length > 2, `log has entries beyond start/end, got ${log.length}`);
  assert(log[0].eventType === "sim_start", "first is sim_start");
  assert(log[log.length - 1].eventType === "sim_end", "last is sim_end");

  const errors = log.filter((e) => e.level === "error");
  assert(errors.length === 0, `no error-level entries, got ${errors.length}`);

  console.log(`    Log entries: ${log.length}`);
  console.log(`    Warnings: ${log.filter((e) => e.level === "warn").length}`);
});

// ────────────────────────────────────────────
// Summary
// ────────────────────────────────────────────
console.log(`\n${"═".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("═".repeat(40));
process.exit(failed > 0 ? 1 : 0);
