/**
 * Discrete-event simulation engine for BPMN 2.0 collaborations.
 *
 * Supports:
 *  - Multiple pools (processes) in a collaboration
 *  - Message flows synchronizing process instances by correlationId
 *  - Message Start Events (instantiate a new process instance on message arrival)
 *  - Intermediate Message Catch Events (wait for matching message)
 *  - Event-Based Gateway with real race between message and timer subscriptions
 *  - Parallel Gateway split (clones token; join not supported in current scenarios)
 *  - Exclusive Gateway with weighted policies
 *  - Resource pools per lane (cfg.resources[laneId].capacity) with FIFO queueing
 *  - Boundary Timer Events (cancelActivity)
 *  - Terminate End Event (cancels all tokens of the process instance)
 *  - Stochastic durations via distributions.js (fixed / uniform / normal / exponential)
 *
 * Reference: Dumas, La Rosa, Mendling, Reijers - "Fundamentals of Business Process
 * Management", chapter 6 (Quantitative Process Analysis).
 */

import TinyQueue from 'tinyqueue';
import { sampleDist } from './distributions.js';

// ───────────────────────────── helpers ──────────────────────────────
function elementType(el) { return el?.$type || ''; }
function isTask(t) {
  return t === 'bpmn:Task'
    || t === 'bpmn:UserTask'
    || t === 'bpmn:ServiceTask'
    || t === 'bpmn:SendTask'
    || t === 'bpmn:ReceiveTask'
    || t === 'bpmn:ManualTask'
    || t === 'bpmn:BusinessRuleTask'
    || t === 'bpmn:ScriptTask';
}
function isXor(t) { return t === 'bpmn:ExclusiveGateway'; }
function isEventBased(t) { return t === 'bpmn:EventBasedGateway'; }
function isParallel(t) { return t === 'bpmn:ParallelGateway'; }
function isStart(t) { return t === 'bpmn:StartEvent'; }
function isEnd(t) { return t === 'bpmn:EndEvent'; }
function hasDef(el, type) { return (el?.eventDefinitions || []).some((d) => d.$type === type); }
function hasTimerDef(el) { return hasDef(el, 'bpmn:TimerEventDefinition'); }
function hasMessageDef(el) { return hasDef(el, 'bpmn:MessageEventDefinition'); }
function hasTerminateDef(el) { return hasDef(el, 'bpmn:TerminateEventDefinition'); }

function pickWeightedFlow(outFlowIds, weightsByFlowId, rng) {
  const weights = outFlowIds.map((fid) => Number(weightsByFlowId?.[fid] ?? 0));
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return outFlowIds[Math.floor(rng() * outFlowIds.length)];
  let r = rng() * sum;
  for (let i = 0; i < outFlowIds.length; i++) {
    r -= weights[i];
    if (r <= 0) return outFlowIds[i];
  }
  return outFlowIds[outFlowIds.length - 1];
}

// ──────────────────────────── public api ────────────────────────────
export async function runBatch({ graph, cfg, rng }) {
  const replications = Math.max(1, Number(cfg.replications || 1));
  const seedBase = Number(cfg.seed ?? 123);

  const eventsRows = [];
  const summaryRows = [];
  const pathRows = [];
  const proofRows = [];
  const casesRows = [];
  const taskRows = [];

  for (let rep = 1; rep <= replications; rep++) {
    const repRng = rng(seedBase + rep * 1009);
    const res = runOne({ graph, cfg, rep, rng: repRng });
    eventsRows.push(...res.events);
    summaryRows.push(res.summary);
    pathRows.push(...res.paths);
    if (res.proofRows) proofRows.push(...res.proofRows);
    if (res.casesRows) casesRows.push(...res.casesRows);
    if (res.taskSpans) taskRows.push(...res.taskSpans);
  }

  return { eventsRows, summaryRows, pathRows, proofRows, casesRows, taskRows };
}

// ──────────────────────── single replication ────────────────────────
function runOne({ graph, cfg, rep, rng }) {
  const maxSimTime = Number(cfg.maxSimTime ?? 1000);
  const maxEvents = Number(cfg.maxEvents ?? 200000);

  // Arrival generator instantiates only NONE start events (BPMN semantics).
  // Message start events are instantiated when a correlated message arrives.
  const arrivalStartId = cfg.startEventId
    || graph.noneStartEvents?.[0]
    || graph.startEvents?.[0];
  if (!arrivalStartId) throw new Error('No startEvent found; set cfg.startEventId.');

  const arrivalSpec = cfg.caseArrival || { type: 'fixed', value: 0 };

  // ── Resource pools per lane ──
  const resources = new Map(); // laneId -> { capacity, available, queue: [{token, taskId, enqueuedAt}] }
  for (const [laneId, spec] of Object.entries(cfg.resources || {})) {
    const cap = Number(spec.capacity ?? Infinity);
    resources.set(laneId, { capacity: cap, available: cap, queue: [] });
  }

  // ── State ──
  let activeCases = 0;
  let lastTime = 0;
  let wipArea = 0;
  let completedCases = 0;

  const caseRegistry = new Map(); // caseId -> { startTime, endTime, completed, rootCaseId, processId }
  const proofRows = [];
  const taskSpans = [];
  const taskStartTime = new Map(); // tokenId -> { taskId, enqueuedAt, startedAt }
  const taskInProgress = new Map(); // tokenId -> { taskId, doneAt, canceled, laneId, caseId }
  const tokensByCase = new Map();   // caseId -> Set(tokenId)
  const canceledCases = new Set();
  const ebgState = new Map();       // tokenId -> { resolved, cancelers: [fn] }
  const messageQueues = new Map();      // key -> [{ deliverAt, fromCaseId }]
  const messageSubscribers = new Map(); // key -> [{ token, resolve, canceled }]

  const flowTraversals = new Map();
  const xorTotals = new Map();
  const events = [];
  const q = new TinyQueue([], (a, b) => a.t - b.t);

  let caseSeq = 0;
  let tokenSeq = 0;
  let subInstanceSeq = 0;

  // ─────────────────────────── logging / metrics ──────────────────────
  function updateWip(t) {
    const dt = t - lastTime;
    if (dt > 0) wipArea += activeCases * dt;
    proofRows.push({
      scenarioId: String(cfg.scenarioId || 'scenario'),
      replication: rep,
      time: Number(t.toFixed(6)),
      dt: Number(dt.toFixed(6)),
      activeCases,
      completedCases,
      wipAreaCum: Number(wipArea.toFixed(6)),
      throughputCum: Number((completedCases / Math.max(1e-9, t)).toFixed(6)),
    });
    lastTime = t;
  }

  function log(row) {
    events.push({
      scenarioId: String(cfg.scenarioId || 'scenario'),
      replication: rep,
      simTime: Number(row.simTime.toFixed(6)),
      eventType: row.eventType,
      caseId: row.caseId || '',
      tokenId: row.tokenId || '',
      elementId: row.elementId || '',
      elementType: row.elementType || '',
      fromId: row.fromId || '',
      toId: row.toId || '',
      flowId: row.flowId || '',
    });
  }

  function schedule(t, payload) { q.push({ t, ...payload }); }
  function outgoing(nodeId) { return graph.outgoingById.get(nodeId) || []; }

  // ─────────────────────── token / case bookkeeping ───────────────────
  function registerToken(token) {
    let set = tokensByCase.get(token.caseId);
    if (!set) { set = new Set(); tokensByCase.set(token.caseId, set); }
    set.add(token.tokenId);
  }
  function unregisterToken(token) {
    const set = tokensByCase.get(token.caseId);
    if (set) set.delete(token.tokenId);
  }
  function isCanceled(token) { return canceledCases.has(token.caseId); }

  function endCase(caseId, t) {
    const cr = caseRegistry.get(caseId);
    if (!cr || cr.completed) return;
    cr.endTime = t;
    cr.completed = true;
    caseRegistry.set(caseId, cr);
    activeCases -= 1;
    completedCases += 1;
  }

  function terminateCase(t, caseId) {
    if (canceledCases.has(caseId)) return;
    canceledCases.add(caseId);
    const cr = caseRegistry.get(caseId);
    if (cr && !cr.completed) {
      cr.endTime = t;
      cr.completed = true;
      caseRegistry.set(caseId, cr);
      activeCases -= 1;
      completedCases += 1;
    }
    // Cancel in-progress tasks of this case + free their resources
    for (const [, st] of taskInProgress.entries()) {
      if (st.caseId === caseId && !st.canceled) {
        st.canceled = true;
        if (st.laneId) releaseResource(st.laneId, t);
      }
    }
    // Remove waiters from lane queues
    for (const r of resources.values()) {
      r.queue = r.queue.filter((w) => w.token.caseId !== caseId);
    }
    // Drop message subscribers
    for (const [key, subs] of messageSubscribers.entries()) {
      messageSubscribers.set(key, subs.filter((s) => s.token.caseId !== caseId));
    }
    tokensByCase.delete(caseId);
  }

  // ───────────────────────── resource management ──────────────────────
  function requestResource(laneId, token, taskId, now) {
    if (!laneId || !resources.has(laneId)) {
      startTaskExecution(now, token, taskId, null);
      return;
    }
    const r = resources.get(laneId);
    if (r.available > 0) {
      r.available -= 1;
      startTaskExecution(now, token, taskId, laneId);
    } else {
      r.queue.push({ token, taskId, enqueuedAt: now });
      log({
        simTime: now, eventType: 'queue_wait',
        caseId: token.caseId, tokenId: token.tokenId,
        elementId: taskId, elementType: 'queue',
      });
    }
  }

  function releaseResource(laneId, now) {
    if (!laneId || !resources.has(laneId)) return;
    const r = resources.get(laneId);
    while (r.queue.length > 0) {
      const next = r.queue.shift();
      if (isCanceled(next.token)) continue;          // skip canceled waiters
      startTaskExecution(now, next.token, next.taskId, laneId);
      return;
    }
    r.available += 1;
  }

  function startTaskExecution(t, token, taskId, laneId) {
    if (isCanceled(token)) {
      if (laneId) releaseResource(laneId, t);
      return;
    }
    const dur = sampleDist(cfg.activityDurations?.[taskId] || { type: 'fixed', value: 1 }, rng);
    const doneAt = t + dur;
    taskInProgress.set(token.tokenId, {
      taskId, doneAt, canceled: false, laneId, caseId: token.caseId,
    });
    const ts = taskStartTime.get(token.tokenId) || { taskId, enqueuedAt: t };
    ts.startedAt = t;
    taskStartTime.set(token.tokenId, ts);

    // Boundary timers (cancelActivity)
    const boundaries = graph.boundaryByAttached.get(taskId) || [];
    for (const b of boundaries) {
      if (!hasTimerDef(b)) continue;
      if (b.cancelActivity === false) continue;
      const bDelay = sampleDist(cfg.boundaryTimers?.[b.id] || { type: 'fixed', value: dur + 1 }, rng);
      schedule(t + bDelay, { kind: 'BOUNDARY', token, boundaryId: b.id, attachedTaskId: taskId });
    }

    schedule(doneAt, { kind: 'TASK_DONE', token, taskId });
  }

  // ─────────────────────────── message handling ───────────────────────
  function msgKey(catchEventId, correlationId) {
    return `${catchEventId}::${correlationId || ''}`;
  }

  function sendMessagesFromSource(t, sourceElementId, token) {
    const flows = graph.messageFlowsBySource?.get(sourceElementId) || [];
    for (const mf of flows) {
      const targetId = mf.targetRef?.id;
      if (!targetId) continue;
      const targetEl = graph.elementsById.get(targetId);
      if (!targetEl) continue;
      // Only deliver to elements that actually consume messages
      const isMsgCatch = targetEl.$type === 'bpmn:IntermediateCatchEvent' && hasMessageDef(targetEl);
      const isMsgStart = targetEl.$type === 'bpmn:StartEvent' && hasMessageDef(targetEl);
      const isReceiveTask = targetEl.$type === 'bpmn:ReceiveTask';
      if (!isMsgCatch && !isMsgStart && !isReceiveTask) continue;
      const delay = sampleDist(
        cfg.messageFlowDelays?.[mf.id] || { type: 'fixed', value: 0 },
        rng,
      );
      log({
        simTime: t, eventType: 'message_sent',
        caseId: token.caseId, tokenId: token.tokenId,
        elementId: sourceElementId, toId: targetId, flowId: mf.id,
      });
      schedule(t + delay, {
        kind: 'MSG_DELIVER',
        catchEventId: targetId,
        correlationId: token.rootCaseId,
        fromCaseId: token.caseId,
      });
    }
  }

  function subscribeMessage(catchEventId, correlationId, token, resolve) {
    const key = msgKey(catchEventId, correlationId);
    const queue = messageQueues.get(key);
    if (queue && queue.length > 0) {
      const msg = queue.shift();
      messageQueues.set(key, queue);
      // Deliver immediately at current scheduler time
      schedule(msg.deliverAt, {
        kind: 'MSG_IMMEDIATE_RESOLVE', token, catchEventId, resolve, fromCaseId: msg.fromCaseId,
      });
      return { cancel: () => {} };
    }
    const sub = { token, resolve, canceled: false };
    const subs = messageSubscribers.get(key) || [];
    subs.push(sub);
    messageSubscribers.set(key, subs);
    return {
      cancel: () => {
        sub.canceled = true;
        const cur = messageSubscribers.get(key) || [];
        const idx = cur.indexOf(sub);
        if (idx >= 0) cur.splice(idx, 1);
        messageSubscribers.set(key, cur);
      },
    };
  }

  function onMsgDeliver(t, catchEventId, correlationId, fromCaseId) {
    updateWip(t);
    const key = msgKey(catchEventId, correlationId);
    const subs = messageSubscribers.get(key) || [];
    while (subs.length > 0) {
      const sub = subs.shift();
      if (sub.canceled || isCanceled(sub.token)) continue;
      messageSubscribers.set(key, subs);
      log({
        simTime: t, eventType: 'message_received',
        caseId: sub.token.caseId, tokenId: sub.token.tokenId,
        elementId: catchEventId, fromId: fromCaseId,
      });
      sub.resolve(t);
      return;
    }
    messageSubscribers.set(key, subs);

    // Message start event → instantiate a new process instance
    if (graph.messageStartEvents?.has(catchEventId)) {
      createCase(t, catchEventId, correlationId, fromCaseId);
      return;
    }
    // Otherwise queue for future subscriber
    const queue = messageQueues.get(key) || [];
    queue.push({ deliverAt: t, fromCaseId });
    messageQueues.set(key, queue);
  }

  // ─────────────────────── case / token creation ──────────────────────
  function createCase(t, startEventId, rootCaseId, parentCaseId) {
    const processId = graph.processOfElement?.get(startEventId) || '';
    const newCaseId = parentCaseId
      ? `${rootCaseId}|${processId || `S${++subInstanceSeq}`}`
      : `C${rep}_${++caseSeq}`;
    const newTokenId = `T${rep}_${++tokenSeq}`;
    const rootId = rootCaseId || newCaseId;

    activeCases += 1;
    caseRegistry.set(newCaseId, {
      startTime: t,
      endTime: null,
      completed: false,
      rootCaseId: rootId,
      processId,
    });

    const token = { caseId: newCaseId, tokenId: newTokenId, nodeId: startEventId, rootCaseId: rootId };
    registerToken(token);

    log({
      simTime: t, eventType: 'case_start',
      caseId: newCaseId, tokenId: newTokenId,
      elementId: startEventId, elementType: 'bpmn:StartEvent',
    });
    schedule(t, { kind: 'ENTER', token });
    return token;
  }

  // ─────────────────────────── arrival generator ──────────────────────
  schedule(0, { kind: 'ARRIVAL' });

  function onArrival(t) {
    updateWip(t);
    if (t > maxSimTime) return;
    createCase(t, arrivalStartId, null, null);
    const ia = sampleDist(arrivalSpec, rng);
    if (Number.isFinite(ia) && ia >= 0) schedule(t + ia, { kind: 'ARRIVAL' });
  }

  // ─────────────────────────── token flow ─────────────────────────────
  function moveToken(t, token, flowId) {
    const flow = graph.flowsById.get(flowId);
    if (!flow) return;
    flowTraversals.set(flowId, (flowTraversals.get(flowId) || 0) + 1);
    const fromId = flow.sourceRef?.id || token.nodeId;
    const toId = flow.targetRef?.id;
    log({
      simTime: t, eventType: 'leave',
      caseId: token.caseId, tokenId: token.tokenId,
      fromId, toId, flowId,
    });
    token.nodeId = toId;
    schedule(t, { kind: 'ENTER', token });
  }

  function proceedToFirstOutgoing(t, token, fromId) {
    const outs = outgoing(fromId);
    if (!outs.length) return;
    moveToken(t, token, outs[0]);
  }

  function onEnter(t, token) {
    updateWip(t);
    if (isCanceled(token)) return;
    const el = graph.elementsById.get(token.nodeId);
    if (!el) {
      log({
        simTime: t, eventType: 'token_error',
        caseId: token.caseId, tokenId: token.tokenId, elementId: token.nodeId,
      });
      return;
    }
    const tpe = elementType(el);
    log({
      simTime: t, eventType: 'enter',
      caseId: token.caseId, tokenId: token.tokenId,
      elementId: el.id, elementType: tpe,
    });

    if (isStart(tpe)) {
      sendMessagesFromSource(t, el.id, token);
      proceedToFirstOutgoing(t, token, el.id);
      return;
    }

    if (isEnd(tpe)) {
      sendMessagesFromSource(t, el.id, token);
      unregisterToken(token);
      if (hasTerminateDef(el)) {
        log({
          simTime: t, eventType: 'case_end',
          caseId: token.caseId, tokenId: token.tokenId,
          elementId: el.id, elementType: tpe,
        });
        terminateCase(t, token.caseId);
      } else {
        const set = tokensByCase.get(token.caseId);
        if (!set || set.size === 0) {
          endCase(token.caseId, t);
          log({
            simTime: t, eventType: 'case_end',
            caseId: token.caseId, tokenId: token.tokenId,
            elementId: el.id, elementType: tpe,
          });
        } else {
          log({
            simTime: t, eventType: 'token_end',
            caseId: token.caseId, tokenId: token.tokenId,
            elementId: el.id, elementType: tpe,
          });
        }
      }
      return;
    }

    if (tpe === 'bpmn:IntermediateCatchEvent' && hasTimerDef(el)) {
      const delay = sampleDist(cfg.timerEvents?.[el.id] || { type: 'fixed', value: 1 }, rng);
      schedule(t + delay, { kind: 'PROCEED', token, fromId: el.id });
      return;
    }

    if (tpe === 'bpmn:IntermediateCatchEvent' && hasMessageDef(el)) {
      enterMessageCatch(t, token, el);
      return;
    }

    if (tpe === 'bpmn:IntermediateThrowEvent') {
      sendMessagesFromSource(t, el.id, token);
      proceedToFirstOutgoing(t, token, el.id);
      return;
    }

    if (isTask(tpe)) {
      taskStartTime.set(token.tokenId, { taskId: el.id, enqueuedAt: t, startedAt: null });
      const laneId = graph.laneOfElement?.get(el.id);
      requestResource(laneId, token, el.id, t);
      return;
    }

    if (isXor(tpe)) {
      const outs = outgoing(el.id);
      const policy = cfg.xorPolicies?.[el.id];
      let fid;
      if (policy?.type === 'weighted') fid = pickWeightedFlow(outs, policy.weightsByFlowId, rng);
      else fid = outs[Math.floor(rng() * outs.length)];
      xorTotals.set(el.id, (xorTotals.get(el.id) || 0) + 1);
      moveToken(t, token, fid);
      return;
    }

    if (isEventBased(tpe)) {
      handleEventBasedGateway(t, token, el);
      return;
    }

    if (isParallel(tpe)) {
      handleParallelGateway(t, token, el);
      return;
    }

    // Fallback: first outgoing
    proceedToFirstOutgoing(t, token, el.id);
  }

  // ─────────────────────── intermediate message catch ─────────────────
  function enterMessageCatch(t, token, el) {
    const incomingMf = graph.messageFlowsByTarget?.get(el.id);
    if (incomingMf && incomingMf.length > 0) {
      subscribeMessage(el.id, token.rootCaseId, token, (msgT) => {
        proceedToFirstOutgoing(msgT, token, el.id);
      });
      return;
    }
    // No real message flow → fallback to configured delay (legacy behavior)
    const delay = sampleDist(cfg.messageDelays?.[el.id] || { type: 'fixed', value: 0 }, rng);
    schedule(t + delay, { kind: 'PROCEED', token, fromId: el.id });
  }

  // ─────────────────────────── EBG with racing ────────────────────────
  function handleEventBasedGateway(t, token, gw) {
    xorTotals.set(gw.id, (xorTotals.get(gw.id) || 0) + 1);
    const outs = outgoing(gw.id);
    const state = { resolved: false, cancelers: [] };
    ebgState.set(token.tokenId, state);

    for (const fid of outs) {
      const flow = graph.flowsById.get(fid);
      if (!flow) continue;
      const target = graph.elementsById.get(flow.targetRef?.id);
      if (!target) continue;

      if (target.$type === 'bpmn:IntermediateCatchEvent' && hasTimerDef(target)) {
        const delay = sampleDist(cfg.timerEvents?.[target.id] || { type: 'fixed', value: 1 }, rng);
        const fireT = t + delay;
        const evt = { kind: 'EBG_RESOLVE', token, gatewayId: gw.id, catchEventId: target.id, flowId: fid };
        schedule(fireT, evt);
        state.cancelers.push(() => { evt.kind = '__CANCELED__'; });
      } else if (target.$type === 'bpmn:IntermediateCatchEvent' && hasMessageDef(target)) {
        const incomingMf = graph.messageFlowsByTarget?.get(target.id);
        if (incomingMf && incomingMf.length > 0) {
          const sub = subscribeMessage(target.id, token.rootCaseId, token, (msgT) => {
            ebgResolve(msgT, token, gw.id, target.id, fid);
          });
          state.cancelers.push(() => sub.cancel());
        } else {
          const delay = sampleDist(cfg.messageDelays?.[target.id] || { type: 'fixed', value: 0 }, rng);
          const evt = { kind: 'EBG_RESOLVE', token, gatewayId: gw.id, catchEventId: target.id, flowId: fid };
          schedule(t + delay, evt);
          state.cancelers.push(() => { evt.kind = '__CANCELED__'; });
        }
      } else {
        // Non-event target: immediate fire
        const evt = { kind: 'EBG_RESOLVE', token, gatewayId: gw.id, catchEventId: target.id, flowId: fid };
        schedule(t, evt);
        state.cancelers.push(() => { evt.kind = '__CANCELED__'; });
      }
    }
  }

  function ebgResolve(t, token, gatewayId, catchEventId, flowId) {
    const state = ebgState.get(token.tokenId);
    if (!state || state.resolved) return;
    if (isCanceled(token)) return;
    state.resolved = true;
    for (const c of state.cancelers) {
      try { c(); } catch (_) { /* noop */ }
    }
    ebgState.delete(token.tokenId);

    flowTraversals.set(flowId, (flowTraversals.get(flowId) || 0) + 1);
    log({
      simTime: t, eventType: 'leave',
      caseId: token.caseId, tokenId: token.tokenId,
      fromId: gatewayId, toId: catchEventId, flowId,
    });
    token.nodeId = catchEventId;
    log({
      simTime: t, eventType: 'enter',
      caseId: token.caseId, tokenId: token.tokenId,
      elementId: catchEventId,
      elementType: graph.elementsById.get(catchEventId)?.$type || '',
    });
    proceedToFirstOutgoing(t, token, catchEventId);
  }

  // ───────────────────────── parallel gateway ─────────────────────────
  function handleParallelGateway(t, token, el) {
    const outs = outgoing(el.id);
    if (!outs.length) return;
    // AND-join requires waiting for all incomings; for now we only handle split.
    // Detect split heuristically: outs > 1.
    if (outs.length === 1) {
      moveToken(t, token, outs[0]);
      return;
    }
    for (let i = 0; i < outs.length; i++) {
      const fid = outs[i];
      if (i === 0) {
        moveToken(t, token, fid);
      } else {
        const cloneToken = {
          caseId: token.caseId,
          tokenId: `T${rep}_${++tokenSeq}`,
          nodeId: token.nodeId,
          rootCaseId: token.rootCaseId,
        };
        registerToken(cloneToken);
        moveToken(t, cloneToken, fid);
      }
    }
  }

  // ─────────────────────────── task completion ────────────────────────
  function onTaskDone(t, token, taskId) {
    updateWip(t);
    const st = taskInProgress.get(token.tokenId);
    if (!st || st.taskId !== taskId || st.canceled) return;

    log({
      simTime: t, eventType: 'task_complete',
      caseId: token.caseId, tokenId: token.tokenId,
      elementId: taskId, elementType: 'bpmn:Task',
    });

    const ts = taskStartTime.get(token.tokenId);
    if (ts && ts.taskId === taskId) {
      const enq = ts.enqueuedAt ?? ts.startedAt ?? t;
      const startedAt = ts.startedAt ?? t;
      taskSpans.push({
        scenarioId: String(cfg.scenarioId || 'scenario'),
        replication: rep,
        caseId: token.caseId,
        taskId,
        enqueueTime: Number(enq.toFixed(6)),
        startTime: Number(startedAt.toFixed(6)),
        endTime: Number(t.toFixed(6)),
        waitTime: Number((startedAt - enq).toFixed(6)),
        duration: Number((t - startedAt).toFixed(6)),
        outcome: 'completed',
      });
      taskStartTime.delete(token.tokenId);
    }
    taskInProgress.delete(token.tokenId);
    releaseResource(st.laneId, t);

    // Emit any outgoing messages associated with this task
    sendMessagesFromSource(t, taskId, token);
    proceedToFirstOutgoing(t, token, taskId);
  }

  // ───────────────────────── boundary timer fire ──────────────────────
  function onBoundary(t, token, boundaryId, attachedTaskId) {
    updateWip(t);
    const st = taskInProgress.get(token.tokenId);
    if (!st || st.taskId !== attachedTaskId || st.canceled) return;
    if (t >= st.doneAt) return;

    st.canceled = true;
    taskInProgress.set(token.tokenId, st);
    if (st.laneId) releaseResource(st.laneId, t);

    log({
      simTime: t, eventType: 'boundary_timer_fire',
      caseId: token.caseId, tokenId: token.tokenId,
      elementId: boundaryId, elementType: 'boundary_timer',
      fromId: attachedTaskId,
    });
    const ts = taskStartTime.get(token.tokenId);
    if (ts && ts.taskId === attachedTaskId) {
      taskSpans.push({
        scenarioId: String(cfg.scenarioId || 'scenario'),
        replication: rep,
        caseId: token.caseId,
        taskId: attachedTaskId,
        enqueueTime: Number((ts.enqueuedAt ?? t).toFixed(6)),
        startTime: Number((ts.startedAt ?? t).toFixed(6)),
        endTime: Number(t.toFixed(6)),
        waitTime: Number(((ts.startedAt ?? t) - (ts.enqueuedAt ?? t)).toFixed(6)),
        duration: Number((t - (ts.startedAt ?? t)).toFixed(6)),
        outcome: 'canceled_by_boundary_timer',
        boundaryId,
      });
      taskStartTime.delete(token.tokenId);
    }
    proceedToFirstOutgoing(t, token, boundaryId);
  }

  // ───────────────────────────── main loop ────────────────────────────
  let processed = 0;
  while (q.length && processed < maxEvents) {
    const ev = q.pop();
    const t = ev.t;

    if (t > maxSimTime && activeCases === 0) break;

    switch (ev.kind) {
      case 'ARRIVAL':
        onArrival(t);
        break;
      case 'ENTER':
        onEnter(t, ev.token);
        break;
      case 'TASK_DONE':
        onTaskDone(t, ev.token, ev.taskId);
        break;
      case 'BOUNDARY':
        onBoundary(t, ev.token, ev.boundaryId, ev.attachedTaskId);
        break;
      case 'PROCEED':
        updateWip(t);
        if (!isCanceled(ev.token)) proceedToFirstOutgoing(t, ev.token, ev.fromId);
        break;
      case 'EBG_RESOLVE':
        ebgResolve(t, ev.token, ev.gatewayId, ev.catchEventId, ev.flowId);
        break;
      case 'MSG_DELIVER':
        onMsgDeliver(t, ev.catchEventId, ev.correlationId, ev.fromCaseId);
        break;
      case 'MSG_IMMEDIATE_RESOLVE':
        updateWip(t);
        if (!isCanceled(ev.token)) {
          log({
            simTime: t, eventType: 'message_received',
            caseId: ev.token.caseId, tokenId: ev.token.tokenId,
            elementId: ev.catchEventId, fromId: ev.fromCaseId,
          });
          ev.resolve(t);
        }
        break;
      case '__CANCELED__':
        // EBG sibling timer/proceed event – ignored after resolution
        break;
      default:
        break;
    }
    processed++;
  }

  // ─────────────────────────── summarization ──────────────────────────
  const simEndTime = Math.max(lastTime, 1e-9);
  const avgWip = wipArea / simEndTime;
  const throughput = completedCases / simEndTime;

  const summary = {
    scenarioId: String(cfg.scenarioId || 'scenario'),
    replication: rep,
    simEndTime: Number(simEndTime.toFixed(6)),
    completedCases,
    throughput: Number(throughput.toFixed(6)),
    avgWip: Number(avgWip.toFixed(6)),
    processedEvents: processed,
  };

  const paths = [];
  for (const [gatewayId, total] of xorTotals.entries()) {
    const outs = outgoing(gatewayId);
    for (const fid of outs) {
      const c = flowTraversals.get(fid) || 0;
      paths.push({
        scenarioId: String(cfg.scenarioId || 'scenario'),
        replication: rep,
        gatewayId,
        flowId: fid,
        traversals: c,
        totalGatewayExits: total,
        pathProbability: total > 0 ? Number((c / total).toFixed(6)) : 0,
      });
    }
  }

  const casesRows = [];
  for (const [caseId, cr] of caseRegistry.entries()) {
    if (cr.startTime == null) continue;
    const endTime = cr.endTime == null ? null : Number(cr.endTime.toFixed(6));
    const cycleTime = cr.endTime == null ? null : Number((cr.endTime - cr.startTime).toFixed(6));
    casesRows.push({
      scenarioId: String(cfg.scenarioId || 'scenario'),
      replication: rep,
      caseId,
      startTime: Number(cr.startTime.toFixed(6)),
      endTime,
      cycleTime,
      completed: cr.completed ? 1 : 0,
      processId: cr.processId || '',
      rootCaseId: cr.rootCaseId || caseId,
    });
  }

  return { events, summary, paths, proofRows, casesRows, taskSpans };
}
