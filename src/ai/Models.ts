// The models a side can be commanded by. Shared by the menu, the AI panel, the match log and the
// dev server (server/llmPlugin.ts), so a model has one id and one label everywhere.

// Strategic layer (D29, D44, D52). The Claude models run through the Agent SDK on the author's
// own login; "openrouter:<id>" runs the OpenRouter model <id> with OPENROUTER_API_KEY, for the
// comparison of LLMs of different companies (D52), where every compared model, Claude included,
// goes through OpenRouter. "local:<name>" runs the model <name> on the user's own computer, or any
// OpenAI-compatible chat API, at the dev server's LOCAL_LLM_URL.
export type ClaudeModel = 'haiku' | 'sonnet' | 'opus';
export type LlmModel = ClaudeModel | `openrouter:${string}` | `local:${string}`;

export const CLAUDE_MODELS: ClaudeModel[] = ['haiku', 'sonnet', 'opus'];

interface OpenRouterModel {
  id: string; // OpenRouter's model id
  label: string;
  company: string;
}

// A short list of each company's current models (OpenRouter's catalog of 2026-10-16); any other
// id can be typed in the menu
export const OPENROUTER_MODELS: OpenRouterModel[] = [
  { id: 'anthropic/claude-haiku-5.5', label: 'Claude Haiku 5.5', company: 'Anthropic' },
  { id: 'anthropic/claude-sonnet-5.5', label: 'Claude Sonnet 5.5', company: 'Anthropic' },
  { id: 'anthropic/claude-opus-5.5', label: 'Claude Opus 5.5', company: 'Anthropic' },
  { id: 'google/gemini-3.8-flash', label: 'Gemini 3.8 Flash', company: 'Google' },
  { id: 'google/gemini-4-argon', label: 'Gemini 4 Argon', company: 'Google' },
  { id: 'openai/gpt-6-luna', label: 'GPT-6 Luna', company: 'OpenAI' },
  { id: 'openai/gpt-6.1-sol', label: 'GPT-6.1 Sol', company: 'OpenAI' },
  { id: 'x-ai/grok-4.7', label: 'Grok 4.7', company: 'xAI' },
  { id: 'deepseek/deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', company: 'DeepSeek' },
  { id: 'deepseek/deepseek-v4-pro-0813', label: 'DeepSeek V4 Pro', company: 'DeepSeek' },
  { id: 'qwen/qwen3.8-max-0902', label: 'Qwen3.8 Max', company: 'Qwen' },
  { id: 'mistralai/mistral-large-4-0', label: 'Mistral Large 4', company: 'Mistral' },
];

// An OpenRouter id as the API takes it: "publisher/model", optionally with a ":variant"
const OPENROUTER_ID = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(:[a-z0-9._-]+)?$/i;

export function isOpenRouterId(id: string): boolean {
  return id.length <= 100 && OPENROUTER_ID.test(id);
}

// The OpenRouter id of a model, or null for any other model
export function openRouterId(model: string): string | null {
  if (!model.startsWith('openrouter:')) return null;
  const id = model.slice('openrouter:'.length);
  return isOpenRouterId(id) ? id : null;
}

// A model's name as a local server knows it: "qwen3:14b", "llama3.3", "qwen/qwen3-14b",
// "hf.co/user/repo:Q4_K_M". It goes into the request's body (and the server's messages), never
// into its address.
const LOCAL_NAME = /^[a-z0-9][a-z0-9._:/-]*$/i;

export function isLocalModelName(name: string): boolean {
  return name.length <= 100 && LOCAL_NAME.test(name);
}

// The local server's name for a model, or null for any other model
export function localModelId(model: string): string | null {
  if (!model.startsWith('local:')) return null;
  const name = model.slice('local:'.length);
  return isLocalModelName(name) ? name : null;
}

export function isLlmModel(model: unknown): model is LlmModel {
  return (
    typeof model === 'string' &&
    ((CLAUDE_MODELS as string[]).includes(model) ||
      openRouterId(model) !== null ||
      localModelId(model) !== null)
  );
}

// "Sonnet", "Gemini 3.8 Flash (OpenRouter)", "x/y (OpenRouter)", "qwen3:14b (Local)"
export function modelLabel(model: string | undefined): string {
  if (!model) return '';
  const local = localModelId(model);
  if (local !== null) return `${local} (Local)`;
  const id = openRouterId(model);
  if (id === null) return model[0].toUpperCase() + model.slice(1);
  const known = OPENROUTER_MODELS.find((m) => m.id === id);
  return `${known ? known.label : id} (OpenRouter)`;
}

// Tactical layer (D51): two decision models with the same request format, raced as conditions
export type TacticalModel = 'jev' | 'snap';

export const TACTICAL_NAME: Record<TacticalModel, string> = { jev: 'Jev', snap: 'Snap' };
