/**
 * Structured Simulation Logger
 *
 * Wraps raw engine events into structured SimulationLogEntry records,
 * enriches with element names and human-readable messages,
 * and tracks unsupported/warning conditions.
 */

import { SimulationEventType, createLogEntry } from "./models.js";

/**
 * Build a structured log from raw engine event rows.
 *
 * @param {Array}  eventsRows   - Raw engine events
 * @param {Map}    elementsById - graph.elementsById for name resolution
 * @param {Object} cfg          - Simulation config (for parameter logging)
 * @returns {import('./models.js').SimulationLogEntry[]}
 */
export function buildStructuredLog(eventsRows, elementsById, cfg) {
  const log = [];
  let seq = 0;

  // Start entry
  log.push(
    createLogEntry(++seq, SimulationEventType.SIM_START, 0, {
      message: `Simulação iniciada. Replicações: ${cfg.replications || 1}, Seed: ${cfg.seed || "N/A"}`,
      level: "info",
      details: {
        replications: cfg.replications,
        seed: cfg.seed,
        maxSimTime: cfg.maxSimTime,
        startEventId: cfg.startEventId,
      },
    }),
  );

  // Track unsupported element types
  const unsupported = new Set();
  const supportedTypes = new Set([
    "bpmn:StartEvent",
    "bpmn:EndEvent",
    "bpmn:Task",
    "bpmn:UserTask",
    "bpmn:ServiceTask",
    "bpmn:SendTask",
    "bpmn:ReceiveTask",
    "bpmn:ManualTask",
    "bpmn:BusinessRuleTask",
    "bpmn:ScriptTask",
    "bpmn:ExclusiveGateway",
    "bpmn:ParallelGateway",
    "bpmn:InclusiveGateway",
    "bpmn:EventBasedGateway",
    "bpmn:IntermediateCatchEvent",
    "bpmn:IntermediateThrowEvent",
    "bpmn:BoundaryEvent",
    "bpmn:SubProcess",
    "bpmn:SequenceFlow",
  ]);

  for (const ev of eventsRows) {
    const el = ev.elementId ? elementsById.get(ev.elementId) : null;
    const elName = el ? el.name || "" : "";
    const elType = ev.elementType || (el ? el.$type : "") || "";

    // Check for unsupported elements (only flag genuine bpmn:* types)
    if (
      ev.elementId &&
      elType &&
      elType.startsWith("bpmn:") &&
      !supportedTypes.has(elType) &&
      !unsupported.has(ev.elementId)
    ) {
      unsupported.add(ev.elementId);
      log.push(
        createLogEntry(
          ++seq,
          SimulationEventType.UNSUPPORTED_ELEMENT,
          ev.simTime,
          {
            elementId: ev.elementId,
            elementType: elType,
            elementName: elName,
            message: `Elemento BPMN não suportado: ${elType} (${elName || ev.elementId})`,
            level: "warn",
          },
        ),
      );
    }

    const mapped = mapEventType(ev.eventType);

    log.push(
      createLogEntry(++seq, mapped, ev.simTime, {
        caseId: ev.caseId || "",
        tokenId: ev.tokenId || "",
        elementId: ev.elementId || "",
        elementType: elType,
        elementName: elName,
        fromId: ev.fromId || "",
        toId: ev.toId || "",
        flowId: ev.flowId || "",
        message: buildMessage(mapped, ev, elName),
        level: mapped === SimulationEventType.TOKEN_ERROR ? "error" : "info",
      }),
    );
  }

  // End entry
  const lastTime =
    eventsRows.length > 0 ? eventsRows[eventsRows.length - 1].simTime : 0;
  log.push(
    createLogEntry(++seq, SimulationEventType.SIM_END, lastTime, {
      message: `Simulação encerrada. Total de eventos processados: ${eventsRows.length}`,
      level: "info",
      details: {
        totalEvents: eventsRows.length,
        unsupportedElements: [...unsupported],
      },
    }),
  );

  return log;
}

function mapEventType(raw) {
  switch (raw) {
    case "case_start":
      return SimulationEventType.CASE_START;
    case "case_end":
      return SimulationEventType.CASE_END;
    case "token_end":
      return SimulationEventType.CASE_END;
    case "enter":
      return SimulationEventType.ENTER;
    case "leave":
      return SimulationEventType.LEAVE;
    case "task_complete":
      return SimulationEventType.TASK_COMPLETE;
    case "boundary_timer_fire":
      return SimulationEventType.BOUNDARY_FIRE;
    case "token_error":
      return SimulationEventType.TOKEN_ERROR;
    case "queue_wait":
      return SimulationEventType.QUEUE_WAIT;
    case "message_sent":
    case "message_received":
      return raw;
    default:
      return raw;
  }
}

function buildMessage(type, ev, elName) {
  const label = elName || ev.elementId || "";

  switch (type) {
    case SimulationEventType.CASE_START:
      return `Caso ${ev.caseId} iniciado`;
    case SimulationEventType.CASE_END:
      return `Caso ${ev.caseId} concluído`;
    case SimulationEventType.ENTER:
      return `Token ${ev.tokenId} entrou em "${label}"`;
    case SimulationEventType.LEAVE:
      return `Token ${ev.tokenId} saiu para "${ev.toId}"`;
    case SimulationEventType.TASK_COMPLETE:
      return `Tarefa "${label}" concluída pelo token ${ev.tokenId}`;
    case SimulationEventType.BOUNDARY_FIRE:
      return `Evento de contorno disparou em "${label}" (cancelou atividade ${ev.fromId || ""})`;
    case SimulationEventType.QUEUE_WAIT:
      return `Token ${ev.tokenId} entrou na fila do recurso para "${label}"`;
    case "message_sent":
      return `Mensagem enviada de "${label}" para ${ev.toId}`;
    case "message_received":
      return `Mensagem recebida em "${label}" (de caso ${ev.fromId})`;
    case SimulationEventType.TOKEN_ERROR:
      return `Erro de token em "${label}": elemento não encontrado no grafo`;
    default:
      return `${type} em "${label}"`;
  }
}
