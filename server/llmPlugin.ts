import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

// Layer 3 (D10): the strategic LLM runs in the dev server through the Claude Agent SDK,
// using the developer's own Claude login. One persistent session per side, so a decision
// takes ~1–2 s instead of ~8 s (R2), and the LLM remembers earlier decisions within a match
// (in-match memory, D11). A new match id starts a fresh session.
//
// POST /api/llm  { side, matchId, prompt }  →  { text, latencyMs, model }

const SYSTEM_PROMPT = `You are the strategic commander of one side in a 2D battle simulation.
Every message is a JSON report of the whole battlefield at one moment. Reply with orders for your heroes.

How the battle works:
- Each side has heroes and soldiers. Soldiers follow the nearest hero of their side.
- Soldiers have courage. It drops when wounded or outnumbered and rises near a hero. Soldiers with low courage flee; nobody can force them to fight.
- A hero's death removes its courage bonus from its soldiers, so heroes are valuable targets and must be protected.
- A fast tactical system adjusts each hero every few seconds based on its surroundings. You set the overall plan.
- Terrain: forest and swamp slow movement and reduce sight; mountains are impassable.
- Locations are sectors of a 10x10 grid: columns A-J from west to east, rows 1-10 from north to south.

Reply with ONLY a JSON object, no other text:
{"plan": "<one short sentence>", "orders": [{"hero": <number>, "command": "<command>", "sector": "<sector, only for move>", "target_hero": <number, only for attack_hero>}]}
Commands: "move" (needs sector), "hold", "retreat", "attack" (nearest enemy), "attack_hero" (needs target_hero).
Give exactly one order per living hero of yours.`;

const MODEL = process.env.LLM_MODEL || 'sonnet';

// A long-lived Agent SDK session. Messages are pushed into an async queue that the SDK
// reads from; each reply arrives as a "result" message.
class Session {
  private queue: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  private waiting: Array<{ resolve: (text: string) => void; reject: (err: Error) => void }> = [];
  private q: Query;

  constructor(readonly matchId: string) {
    this.q = query({
      prompt: this.input(),
      options: {
        model: MODEL,
        systemPrompt: SYSTEM_PROMPT,
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
          const { side, matchId, prompt } = JSON.parse(await readBody(req)) as {
            side: string;
            matchId: string;
            prompt: string;
          };
          if (!side || !matchId || !prompt)
            return send(res, 400, { error: 'side, matchId and prompt are required' });

          let session = sessions.get(side);
          if (!session || session.matchId !== matchId) {
            session?.close();
            session = new Session(matchId);
            sessions.set(side, session);
          }

          const started = Date.now();
          const text = await session.ask(prompt);
          send(res, 200, { text, latencyMs: Date.now() - started, model: MODEL });
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
