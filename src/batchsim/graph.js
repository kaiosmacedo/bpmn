
function hasDef(el, type) {
  return (el?.eventDefinitions || []).some((d) => d.$type === type);
}

export function buildGraph(definitions) {
  const rootElements = definitions.rootElements || [];
  const processes = rootElements.filter((e) => e.$type === 'bpmn:Process');
  const collaborations = rootElements.filter((e) => e.$type === 'bpmn:Collaboration');

  if (processes.length === 0) throw new Error('No bpmn:Process found in definitions.');

  const elementsById = new Map();
  const outgoingById = new Map();
  const incomingById = new Map();
  const flowsById = new Map();
  const boundaryByAttached = new Map();

  const processOfElement = new Map();      // elementId -> processId
  const laneOfElement = new Map();         // elementId -> laneId
  const lanesByProcess = new Map();        // processId -> [laneObj]
  const elementsByProcess = new Map();     // processId -> [elementId]
  const messageFlowsBySource = new Map();  // sourceRef.id -> [messageFlow]
  const messageFlowsByTarget = new Map();  // targetRef.id -> [messageFlow]

  function collect(container, processId) {
    const flowElements = container.flowElements || [];
    for (const el of flowElements) {
      if (!el?.id) continue;
      elementsById.set(el.id, el);
      processOfElement.set(el.id, processId);

      const arr = elementsByProcess.get(processId) || [];
      arr.push(el.id);
      elementsByProcess.set(processId, arr);

      if (el.$type === 'bpmn:SequenceFlow') {
        flowsById.set(el.id, el);
      }

      if (el.$type === 'bpmn:BoundaryEvent' && el.attachedToRef?.id) {
        const taskId = el.attachedToRef.id;
        const arr2 = boundaryByAttached.get(taskId) || [];
        arr2.push(el);
        boundaryByAttached.set(taskId, arr2);
      }

      if (el.$type === 'bpmn:SubProcess') {
        collect(el, processId);
      }
    }
  }

  for (const process of processes) {
    collect(process, process.id);

    const laneSets = process.laneSets || [];
    const lanes = [];
    for (const ls of laneSets) {
      for (const lane of ls.lanes || []) {
        lanes.push(lane);
        for (const ref of lane.flowNodeRef || []) {
          const refId = typeof ref === 'string' ? ref : ref?.id;
          if (refId) laneOfElement.set(refId, lane.id);
        }
      }
    }
    lanesByProcess.set(process.id, lanes);
  }

  for (const [flowId, flow] of flowsById.entries()) {
    const src = flow.sourceRef?.id;
    const tgt = flow.targetRef?.id;
    if (src) {
      const out = outgoingById.get(src) || [];
      out.push(flowId);
      outgoingById.set(src, out);
    }
    if (tgt) {
      const inc = incomingById.get(tgt) || [];
      inc.push(flowId);
      incomingById.set(tgt, inc);
    }
  }

  for (const collab of collaborations) {
    for (const mf of collab.messageFlows || []) {
      const src = mf.sourceRef?.id;
      const tgt = mf.targetRef?.id;
      if (src) {
        const arr = messageFlowsBySource.get(src) || [];
        arr.push(mf);
        messageFlowsBySource.set(src, arr);
      }
      if (tgt) {
        const arr = messageFlowsByTarget.get(tgt) || [];
        arr.push(mf);
        messageFlowsByTarget.set(tgt, arr);
      }
    }
  }

  const startEvents = [];
  const noneStartEvents = [];     // only these instantiate via arrival generator
  const messageStartEvents = new Set();
  const terminateEnds = new Set();

  for (const el of elementsById.values()) {
    if (el.$type === 'bpmn:StartEvent') {
      startEvents.push(el.id);
      if (hasDef(el, 'bpmn:MessageEventDefinition')) {
        messageStartEvents.add(el.id);
      } else if ((el.eventDefinitions || []).length === 0) {
        noneStartEvents.push(el.id);
      }
    }
    if (el.$type === 'bpmn:EndEvent' && hasDef(el, 'bpmn:TerminateEventDefinition')) {
      terminateEnds.add(el.id);
    }
  }

  return {
    processId: processes[0].id,
    processes: processes.map((p) => p.id),
    elementsById,
    outgoingById,
    incomingById,
    flowsById,
    boundaryByAttached,
    processOfElement,
    laneOfElement,
    lanesByProcess,
    elementsByProcess,
    messageFlowsBySource,
    messageFlowsByTarget,
    startEvents,
    noneStartEvents,
    messageStartEvents,
    terminateEnds,
  };
}
