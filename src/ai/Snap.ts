// D51: SubQ Snap (Subquadratic) as the tactical layer, raced against Jev. Snap takes Jev's
// request format (POST /v1/systemone with model, state and typed questions, same answers) with
// two differences, handled here so both models get the same option names and descriptions:
// a choice option is described by one text (Jev: what it is for and what it is not for), and
// a question's instructions are one text. Also used by the shadow comparison script that
// resends logged Jev requests to Snap (tests/smoke/tools/shadow-snap.ts, outside the repository).

export const SNAP_MODEL = 'subq-snap-preview';
export const SNAP_MAX_QUESTIONS = 16; // per request (Snap's API reference)

interface JevQuestion {
  type?: unknown;
  instructions?: unknown;
  criteria?: unknown;
}

// Jev's choice option: { what, not_for }; Snap's: one text
function optionText(option: unknown): string | null {
  if (option === null || typeof option === 'string') return option;
  if (typeof option !== 'object') return String(option);
  const { what, not_for } = option as { what?: unknown; not_for?: unknown };
  const parts = [
    typeof what === 'string' ? what : '',
    typeof not_for === 'string' && not_for ? `Not for: ${not_for}` : '',
  ];
  return parts.filter(Boolean).join(' ') || null;
}

// Jev's choice instructions: { hero, question }; Snap's: one text
function instructionsText(instructions: unknown): string {
  if (typeof instructions === 'string') return instructions;
  if (instructions && typeof instructions === 'object') {
    const { question } = instructions as { question?: unknown };
    if (typeof question === 'string') return question;
  }
  return JSON.stringify(instructions ?? '');
}

export function toSnapRequest(request: { state: unknown; questions: Record<string, unknown> }): {
  model: string;
  state: unknown;
  questions: Record<string, unknown>;
} {
  const questions: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(request.questions)) {
    const q = raw as JevQuestion;
    if (q.type === 'choice' && q.criteria && typeof q.criteria === 'object') {
      questions[key] = {
        type: 'choice',
        instructions: instructionsText(q.instructions),
        criteria: Object.fromEntries(
          Object.entries(q.criteria as Record<string, unknown>).map(([name, option]) => [
            name,
            optionText(option),
          ])
        ),
      };
    } else {
      // noul and score have the same shape; a yes/no question needs a criteria object
      questions[key] = {
        ...q,
        instructions: instructionsText(q.instructions),
        criteria: q.criteria ?? (q.type === 'noul' ? {} : undefined),
      };
    }
  }
  return { model: SNAP_MODEL, state: request.state, questions };
}
