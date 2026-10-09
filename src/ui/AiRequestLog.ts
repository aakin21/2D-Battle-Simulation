import type { AiExchange } from '../ai/Exchange';
import type { JevController } from '../ai/JevController';
import type { LlmController } from '../ai/LlmController';
import type { AiSides } from './MatchLog';
import { escapeHtml } from './AiPanel';

// The AI panel's request log: every request to Jev and the LLM with its answer, newest first.
// The summary line gives the answer at a glance; opening an entry shows what was offered and
// answered per hero (Jev) or the stance, plan and orders (LLM), and the raw request and answer.
// Entries are added and updated in place, never rebuilt, and an entry's details and JSON are
// only built when it is opened, so a long match does not slow the page.

const MAX_SHOWN = 80; // older entries stay in the match log
const SIDE_NAME = { west: 'West', east: 'East' } as const;

type Side = 'west' | 'east';
type Source =
  | { side: Side; layer: 'jev'; controller: JevController }
  | { side: Side; layer: 'llm'; controller: LlmController };

interface Shown {
  el: HTMLDetailsElement | null; // null once trimmed from the page
  answered: boolean;
  source: Source;
  exchange: AiExchange;
}

type JevAnswers = Record<
  string,
  { choice?: unknown; confidence?: unknown; score?: unknown; noul?: unknown }
>;

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function percent(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) ? `${Math.round(v * 100)}%` : '–';
}

function value(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) ? String(Math.round(v * 100) / 100) : '–';
}

function kb(text: string): string {
  return text.length < 1024 ? `${text.length} B` : `${(text.length / 1024).toFixed(1)} KB`;
}

// "step_north_east" → "step north-east"
function pretty(key: string): string {
  return key.replace(/_/g, ' ').replace(/(north|south) (east|west)/, '$1-$2');
}

// A collapsed block whose text is only produced when it is opened
function lazyBlock(title: string, text: () => string): HTMLDetailsElement {
  const block = document.createElement('details');
  block.className = 'ai-x-raw';
  block.innerHTML = `<summary>${escapeHtml(title)}</summary><pre></pre>`;
  block.addEventListener('toggle', () => {
    const pre = block.querySelector('pre')!;
    if (block.open && !pre.textContent) pre.textContent = text();
  });
  return block;
}

export class AiRequestLog {
  private elList = document.getElementById('ai-log-list')!;
  private elCount = document.getElementById('ai-log-count')!;
  private sides: AiSides | null = null;
  private shown = new Map<number, Shown>(); // by exchange seq

  update(sides: AiSides): void {
    if (sides !== this.sides) {
      // A new match: its controllers are new, so the log starts empty
      this.sides = sides;
      this.shown.clear();
      this.elList.textContent = '';
    }
    const fresh: Array<[Source, AiExchange]> = [];
    let total = 0;
    for (const source of this.sources(sides)) {
      for (const x of source.controller.exchanges) {
        total++;
        const known = this.shown.get(x.seq);
        if (!known) fresh.push([source, x]);
        else if (!known.answered && x.latencyMs !== null) this.refresh(known);
      }
    }
    // Oldest first, so the newest ends up on top
    fresh.sort((a, b) => a[1].seq - b[1].seq);
    for (const [source, x] of fresh) this.add(source, x);
    this.trim();
    const count = String(total);
    if (this.elCount.textContent !== count) this.elCount.textContent = count;
  }

  private sources(sides: AiSides): Source[] {
    const out: Source[] = [];
    for (const side of ['west', 'east'] as const) {
      const { jev, llm } = sides[side];
      if (jev) out.push({ side, layer: 'jev', controller: jev });
      if (llm) out.push({ side, layer: 'llm', controller: llm });
    }
    return out;
  }

  private add(source: Source, x: AiExchange): void {
    const el = document.createElement('details');
    el.className = 'ai-x';
    const item: Shown = { el, answered: x.latencyMs !== null, source, exchange: x };
    this.shown.set(x.seq, item);
    el.innerHTML = this.summaryHtml(source, x);
    // Details are built on first open, and again if the answer arrived since
    let builtFor: number | null = null;
    el.addEventListener('toggle', () => {
      if (!el.open || builtFor === x.latencyMs) return;
      builtFor = x.latencyMs;
      el.querySelector('.ai-x-body')?.remove();
      el.appendChild(this.body(source, x));
    });
    this.elList.prepend(el);
  }

  private refresh(item: Shown): void {
    item.answered = true;
    if (!item.el) return;
    const summary = item.el.querySelector('summary');
    if (summary) summary.outerHTML = this.summaryHtml(item.source, item.exchange);
    if (item.el.open) item.el.dispatchEvent(new Event('toggle')); // rebuild the open details
  }

  private trim(): void {
    while (this.elList.childElementCount > MAX_SHOWN) {
      const last = this.elList.lastElementChild!;
      for (const item of this.shown.values()) if (item.el === last) item.el = null;
      last.remove();
    }
  }

  private summaryHtml(source: Source, x: AiExchange): string {
    const timing =
      x.latencyMs === null
        ? '<span class="ai-busy">waiting…</span>'
        : `<span class="faint">${(x.latencyMs / 1000).toFixed(1)} s</span>`;
    const head =
      `<span class="faint">${clock(x.time)}</span> ` +
      `<span class="${source.side}-text">${SIDE_NAME[source.side]}</span> ` +
      `${source.layer === 'jev' ? 'Jev' : 'LLM'} ${timing}`;
    let what = '';
    if (x.error) what = `<span class="ai-fail">${escapeHtml(x.error)}</span>`;
    else if (x.latencyMs !== null)
      what = escapeHtml(
        source.layer === 'jev' ? this.jevLine(x) : this.llmLine(source.controller, x)
      );
    else
      what = `<span class="faint">${source.layer === 'jev' ? this.jevAsked(x) : 'report sent'}</span>`;
    return `<summary><span class="ai-x-head">${head}</span><span class="ai-x-sum">${what}</span></summary>`;
  }

  // "3 heroes asked"
  private jevAsked(x: AiExchange): string {
    const n = this.jevHeroKeys(x).length;
    return `${n} hero${n === 1 ? '' : 'es'} asked`;
  }

  private jevHeroKeys(x: AiExchange): string[] {
    const questions = (x.request.questions ?? {}) as Record<string, { type?: unknown }>;
    return Object.keys(questions).filter((k) => questions[k]?.type === 'choice');
  }

  // "H1 hold 82% · H2 retreat 64%"
  private jevLine(x: AiExchange): string {
    const answers = ((x.response as { answers?: JevAnswers } | null)?.answers ?? {}) as JevAnswers;
    const parts = this.jevHeroKeys(x).map((key) => {
      const a = answers[key];
      const choice = typeof a?.choice === 'string' ? pretty(a.choice) : 'no answer';
      return `H${key.replace('hero', '')} ${choice} ${percent(a?.confidence)}`;
    });
    return parts.join(' · ') || 'no heroes';
  }

  // "aggressive · 3 orders · 1 rejected"
  private llmLine(llm: LlmController, x: AiExchange): string {
    const d = llm.decisions.find((dec) => dec.time === x.time);
    if (!d) return 'answered';
    const parts = [
      d.stance || 'no stance',
      `${d.orders.length} order${d.orders.length === 1 ? '' : 's'}`,
    ];
    if (d.rejected.length) parts.push(`${d.rejected.length} rejected`);
    return parts.join(' · ');
  }

  private body(source: Source, x: AiExchange): HTMLElement {
    const body = document.createElement('div');
    body.className = 'ai-x-body';
    if (source.layer === 'jev') body.innerHTML = this.jevDetails(x);
    else body.innerHTML = this.llmDetails(source.controller, x);
    const json = (v: unknown) => JSON.stringify(v, null, 2) ?? '';
    const sent = JSON.stringify(x.request) ?? '';
    body.appendChild(lazyBlock(`Request (${kb(sent)})`, () => json(x.request)));
    if (x.response !== null) body.appendChild(lazyBlock('Answer', () => json(x.response)));
    if (source.layer === 'llm')
      body.appendChild(
        lazyBlock('Rulebook (system prompt, once per match)', () => source.controller.system)
      );
    return body;
  }

  // Per hero: the options Jev was offered, its choice and its assessments
  private jevDetails(x: AiExchange): string {
    const questions = (x.request.questions ?? {}) as Record<
      string,
      { criteria?: Record<string, unknown> }
    >;
    const answers = ((x.response as { answers?: JevAnswers } | null)?.answers ?? {}) as JevAnswers;
    return this.jevHeroKeys(x)
      .map((key) => {
        const offered = Object.keys(questions[key]?.criteria ?? {}).map(pretty);
        const a = answers[key];
        const choice = typeof a?.choice === 'string' ? pretty(a.choice) : '–';
        const extra = [
          `threat ${value(answers[`${key}_threat`]?.score)}`,
          `surrounded ${percent(answers[`${key}_surrounded`]?.noul)}`,
          ...(questions[`${key}_order_fits`]
            ? [`order fits ${percent(answers[`${key}_order_fits`]?.noul)}`]
            : []),
        ];
        return (
          `<div class="ai-x-hero">Hero ${escapeHtml(key.replace('hero', ''))}: ` +
          `<span class="ai-x-choice">${escapeHtml(choice)} ${percent(a?.confidence)}</span>` +
          `<div class="faint">${escapeHtml(extra.join(' · '))}</div>` +
          `<div class="faint">offered: ${escapeHtml(offered.join(', '))}</div></div>`
        );
      })
      .join('');
  }

  // The stance, plan, orders and rejected orders read from the reply
  private llmDetails(llm: LlmController, x: AiExchange): string {
    const d = llm.decisions.find((dec) => dec.time === x.time);
    if (!d) return x.error ? '' : '<div class="faint">waiting for the reply</div>';
    let html = '';
    if (d.situation) html += `<div class="faint">${escapeHtml(d.situation)}</div>`;
    if (d.plan) html += `<div>${escapeHtml(d.plan)}</div>`;
    if (d.orders.length) html += `<div>${d.orders.map((o) => escapeHtml(o)).join('<br>')}</div>`;
    if (d.rejected.length)
      html += `<div class="ai-fail">${d.rejected.map((o) => escapeHtml(o)).join('<br>')}</div>`;
    return html;
  }
}
