// One request to an AI layer and what came back, kept for the AI panel's request log and the
// match log, so what each layer was asked and what it answered can be read during and after a
// match.

export interface AiExchange {
  seq: number; // unique on the page, so the request log can tell entries apart
  time: number; // simulation time when the request was sent
  latencyMs: number | null; // null while the answer is awaited
  request: Record<string, unknown>; // the body as sent (the LLM's rulebook is kept once, in `system`)
  response: unknown; // the parsed answer; null while waiting or after a failure
  error: string | null; // why there is no usable answer
}

// A 500 s match makes ~125 Jev and ~25 LLM requests per side; this only bounds memory
const MAX_EXCHANGES = 1000;
let nextSeq = 1;

export function startExchange(
  list: AiExchange[],
  time: number,
  request: Record<string, unknown>
): AiExchange {
  const exchange: AiExchange = {
    seq: nextSeq++,
    time,
    latencyMs: null,
    request,
    response: null,
    error: null,
  };
  list.push(exchange);
  if (list.length > MAX_EXCHANGES) list.shift();
  return exchange;
}

export function finishExchange(
  exchange: AiExchange,
  latencyMs: number,
  response: unknown,
  error: string | null = null
): void {
  exchange.latencyMs = latencyMs;
  exchange.response = response;
  exchange.error = error;
}
