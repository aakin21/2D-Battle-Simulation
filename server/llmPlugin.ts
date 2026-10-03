import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

// Layer 3 (D10): the strategic LLM runs in the dev server through the Claude Agent SDK,
// using the developer's own Claude login. One persistent session per side, so a decision
// takes ~1–2 s instead of ~8 s (R2), and the LLM remembers earlier decisions within a match
// (in-match memory, D11). A new match id starts a fresh session.
//
// POST /api/llm  { side, matchId, system, prompt }  →  { text, latencyMs, model }

// The system prompt (rulebook) is built in the browser from the engine's own constants
// (src/ai/GameRules.ts) and sent with each request; it is used when a session starts.

// Model chosen per side in the menu (D29). Only these aliases are accepted.
const MODELS = ['haiku', 'sonnet', 'opus'] as const;
type Model = (typeof MODELS)[number];
const DEFAULT_MODEL: Model = (MODELS as readonly string[]).includes(process.env.LLM_MODEL ?? '')
  ? (process.env.LLM_MODEL as Model)
  : 'sonnet';

// A long-lived Agent SDK session. Messages are pushed into an async queue that the SDK
// reads from; each reply arrives as a "result" message.
class Session {
  private queue: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  private waiting: Array<{ resolve: (text: string) => void; reject: (err: Error) => void }> = [];
  private q: Query;

  constructor(
    readonly matchId: string,
    readonly model: Model,
    systemPrompt: string
  ) {
    this.q = query({
      prompt: this.input(),
      options: {
        model,
        systemPrompt,
        tools: [],
        settingSources: [],
        persistSession: false,
        env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
      },
    });
    void this.readLoop();
  }

  private async *input(): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      const next = this.queue.shift();
      if (next) {
        yield next;
        continue;
      }
      await new Promise<void>((r) => (this.wake = r));
    }
  }

  private async readLoop(): Promise<void> {
    try {
      for await (const message of this.q) {
        if (message.type !== 'result') continue;
        const pending = this.waiting.shift();
        if (!pending) continue;
        if (message.subtype === 'success') pending.resolve(message.result);
        else pending.reject(new Error(`LLM error: ${message.subtype}`));
      }
    } catch (err) {
      for (const p of this.waiting.splice(0)) p.reject(err as Error);
    }
  }

  ask(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.waiting.push({ resolve, reject });
      this.queue.push({
        type: 'user',
        message: { role: 'user', content: prompt },
        parent_tool_use_id: null,
      } as SDKUserMessage);
      this.wake?.();
      this.wake = null;
    });
  }

  close(): void {
    this.closed = true;
    this.wake?.();
    this.q.close();
  }
}

const sessions = new Map<string, Session>();

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

export function llmPlugin(): Plugin {
  return {
    name: 'battle-llm',
    configureServer(server) {
      server.middlewares.use('/api/llm', async (req, res) => {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
        try {
          const {
            side,
            matchId,
            system,
            prompt,
            model: requested,
          } = JSON.parse(await readBody(req)) as {
            model?: string;
            side: string;
            matchId: string;
            system: string;
            prompt: string;
          };
          if (!side || !matchId || !system || !prompt)
            return send(res, 400, { error: 'side, matchId, system and prompt are required' });

          let session = sessions.get(side);
          const model: Model = (MODELS as readonly string[]).includes(requested ?? '')
            ? (requested as Model)
            : DEFAULT_MODEL;
          if (!session || session.matchId !== matchId || session.model !== model) {
            session?.close();
            session = new Session(matchId, model, system);
            sessions.set(side, session);
          }

          const started = Date.now();
          const text = await session.ask(prompt);
          send(res, 200, { text, latencyMs: Date.now() - started, model });
        } catch (err) {
          send(res, 500, { error: String(err) });
        }
      });

      server.httpServer?.on('close', () => {
        for (const s of sessions.values()) s.close();
        sessions.clear();
      });
    },
  };
}
