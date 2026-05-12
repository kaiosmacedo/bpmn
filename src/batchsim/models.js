/**
 * Simulation Models / DTOs
 *
 * Strongly-typed structures for simulation logging, metrics and run tracking.
 */

export const SimulationEventType = Object.freeze({
  SIM_START: "sim_start",
  SIM_END: "sim_end",
  CASE_START: "case_start",
  CASE_END: "case_end",
  ENTER: "enter",
  LEAVE: "leave",
  TASK_COMPLETE: "task_complete",
  BOUNDARY_FIRE: "boundary_fire",
  GATEWAY_DECISION: "gateway_decision",
  TOKEN_ERROR: "token_error",
  WARNING: "warning",
  UNSUPPORTED_ELEMENT: "unsupported_element",
  QUEUE_WAIT: "queue_wait",
});

export const SimulationStatus = Object.freeze({
  IDLE: "idle",
  RUNNING: "running",
  PAUSED: "paused",
  COMPLETED: "completed",
  ERROR: "error",
});

/**
 * @typedef {Object} SimulationLogEntry
 * @property {number}  seq          - Sequential log number
 * @property {string}  eventType    - One of SimulationEventType
 * @property {number}  simTime      - Simulation clock time
 * @property {string}  timestamp    - Wall-clock ISO timestamp
 * @property {string}  [caseId]
 * @property {string}  [tokenId]
 * @property {string}  [elementId]
 * @property {string}  [elementType]
 * @property {string}  [elementName]
 * @property {string}  [fromId]
 * @property {string}  [toId]
 * @property {string}  [flowId]
 * @property {string}  [message]    - Human-readable description
 * @property {string}  [level]      - 'info' | 'warn' | 'error'
 * @property {Object}  [details]    - Extra data (parameters, durations, etc.)
 */

/**
 * @typedef {Object} ElementPerformanceMetric
 * @property {string}  elementId
 * @property {string}  elementType
 * @property {string}  elementName
 * @property {number}  visits          - Total enter count
 * @property {number}  totalTime       - Cumulative processing time
 * @property {number}  avgTime         - Average processing time per visit
 * @property {number}  minTime
 * @property {number}  maxTime
 * @property {number}  waitTime        - Cumulative wait/queue time
 * @property {number}  avgWaitTime
 * @property {boolean} isBottleneck
 */

/**
 * @typedef {Object} SimulationMetrics
 * @property {number}  avgCycleTime
 * @property {number}  minCycleTime
 * @property {number}  maxCycleTime
 * @property {number}  medianCycleTime
 * @property {number}  completedCases
 * @property {number}  totalCases
 * @property {number}  throughput
 * @property {number}  avgWip
 * @property {ElementPerformanceMetric[]} elementMetrics
 * @property {ElementPerformanceMetric[]} bottlenecks
 * @property {string[]}  qualitativeNotes
 */

/**
 * @typedef {Object} SimulationRun
 * @property {string}   runId
 * @property {string}   status      - One of SimulationStatus
 * @property {string}   startedAt   - ISO timestamp
 * @property {string}   [endedAt]
 * @property {Object}   parameters  - The cfg used
 * @property {SimulationLogEntry[]}  log
 * @property {SimulationMetrics}     [metrics]
 * @property {Object}   rawResults  - Original engine output
 */

let _runSeq = 0;

export function createSimulationRun(parameters) {
  return {
    runId: `run_${++_runSeq}_${Date.now()}`,
    status: SimulationStatus.IDLE,
    startedAt: null,
    endedAt: null,
    parameters: { ...parameters },
    log: [],
    metrics: null,
    rawResults: null,
  };
}

export function createLogEntry(seq, eventType, simTime, overrides = {}) {
  return {
    seq,
    eventType,
    simTime,
    timestamp: new Date().toISOString(),
    caseId: "",
    tokenId: "",
    elementId: "",
    elementType: "",
    elementName: "",
    fromId: "",
    toId: "",
    flowId: "",
    message: "",
    level: "info",
    details: null,
    ...overrides,
  };
}
