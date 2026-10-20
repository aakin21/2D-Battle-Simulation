import type { JevController } from '../ai/JevController';
import type { LlmController } from '../ai/LlmController';
import { groupStats, GroupStats } from '../ai/Observations';
import { sameCommand } from '../engine/HeroCommands';
import { positionToSubsector } from '../engine/Sectors';
import type { Side } from '../engine/Sides';
import { BehaviorState, Faction, IHero, SimConfig } from '../types/types';
import type { StateManager } from '../state/StateManager';
import type { AiSides } from './MatchLog';
import { AiRequestLog } from './AiRequestLog';
import { describeCommand, escapeHtml, prettyKey, SIDE_NAME } from './format';
import { modelLabel } from '../ai/Models';

// The AI panels in the side panel, below Map, Armies and Area: one for each side with AI
// layers, West and East side by side when both have them. Each shows when the LLM and Jev last
// answered and when they ask next, the LLM's stance, plan and situation, then one block per
// hero with a line for each layer: the order running now and whose it is (the LLM's, Jev agreeing,
// or Jev overriding the LLM), the LLM's latest order with its reason (D41), Jev's latest
// choice with its assessment, and the hero's state; below, that side's requests and answers.

type JevDecision = JevController['decisions'][number];

const STATS_EVERY_MS = 500; // followers are counted at most this often (every unit is visited)

// Kept here for code that imports it from the AI panel
export { escapeHtml } from './format';

function ago(now: number, then: number): string {
  return `${Math.max(0, Math.round(now - then))} s ago`;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function percent(v: number | undefined): string {
  return v === undefined ? '–' : `${Math.round(v * 100)}%`;
}

// "step_north_east" → "step north-east", "attack_hero_2" → "attack hero 2"
function prettyChoice(key: string): string {
  return prettyKey(key).replace('continue llm', 'follow the LLM');
}

function heroState(h: IHero): string {
  switch (h.state) {
    case BehaviorState.ATTACK:
      return 'fighting';
    case BehaviorState.FLEE:
      return 'falling back (reflex)';
    case BehaviorState.REST:
      return 'resting';
    default:
      return h.path.length > 0 ? 'moving' : 'standing';
  }
}

// A labelled line: "LLM   move to F4-NW · 12 s ago"
function line(label: string, value: string): string {
  return `<div class="ai-kv"><span class="ai-k">${label}</span><span>${value}</span></div>`;
}

// Above this many characters a text written by the LLM is cut to two lines, with "more" to
// open it in place (it stays open while the panel is redrawn)
const LONG_TEXT = 90;

const SOURCE_NAME: Record<string, string> = { llm: 'LLM', jev: 'Jev', rule: 'rules', user: 'user' };

interface Panel {
  el: HTMLElement;
  main: HTMLElement;
  log: AiRequestLog;
  last: string;
  // The footer's counts, kept until a layer answers again or counts a skip or a failure
  meta: { llm?: LlmController; jev?: JevController; key: string; html: string } | null;
}

// Each hero's latest tactical decision, brought up to date with the decisions added since
interface LatestJev {
  seen: number;
  byHero: Map<number, JevDecision>;
}

export class AiPanel {
  private elSide = document.getElementById('side-panel')!;
  private panels: Record<Side, Panel>;
  private stats = new Map<string, GroupStats>();
  private statsAt = 0;
  private open = new Set<string>(); // long texts the viewer opened, by key
  private latest = new WeakMap<JevController, LatestJev>();

  constructor() {
    const panel = (side: Side): Panel => {
      const el = document.getElementById(`ai-col-${side}`)!;
      const p: Panel = {
        el,
        main: el.querySelector('.ai-col-main')!,
        log: new AiRequestLog(side, el),
        last: '',
        meta: null,
      };
      // "more" / "less" on a long text: open or close it, then draw again at once
      p.main.addEventListener('click', (e) => {
        const key = (e.target as HTMLElement).closest<HTMLElement>('[data-toggle]')?.dataset.toggle;
        if (!key) return;
        if (this.open.has(key)) this.open.delete(key);
        else this.open.add(key);
        p.last = '';
      });
      return p;
    };
    this.panels = { west: panel('west'), east: panel('east') };
  }

  // Draw both panels again at the next update (after a replay wrote its own HTML into them)
  redraw(): void {
    this.panels.west.last = '';
    this.panels.east.last = '';
  }

  update(
    sides: AiSides,
    config: SimConfig,
    simTime: number,
    heroes: IHero[] = [],
    sm?: StateManager
  ): void {
    const active = (['west', 'east'] as const).filter((s) => sides[s].llm || sides[s].jev);
    this.elSide.classList.toggle('ai-two', active.length === 2);
    if (active.length > 0 && sm && performance.now() - this.statsAt > STATS_EVERY_MS) {
      this.statsAt = performance.now();
      this.stats = new Map([...groupStats(sm, Faction.FRIENDLY), ...groupStats(sm, Faction.ENEMY)]);
    }
    for (const side of ['west', 'east'] as const) {
      const p = this.panels[side];
      const on = active.includes(side);
      if (p.el.hidden === on) p.el.hidden = !on;
      if (!on) continue;
      p.log.update(sides);
      const { llm, jev } = sides[side];
      const html = this.sideHtml(side, llm, jev, config, simTime, heroes);
      if (html === p.last) continue;
      p.last = html;
      p.main.innerHTML = html;
    }
  }

  private sideHtml(
    side: Side,
    llm: LlmController | undefined,
    jev: JevController | undefined,
    config: SimConfig,
    now: number,
    heroes: IHero[]
  ): string {
    const model = side === 'west' ? config.friendlyModel : config.enemyModel;
    const name = model ? ` ${modelLabel(model)}` : '';
    const who = [llm ? `LLM${name}` : '', jev ? jev.name : ''].filter(Boolean).join(' + ');
    let html =
      `<div class="ai-head"><span class="ai-side-name ${side}-text">${SIDE_NAME[side]}</span>` +
      `<span class="army-who">${escapeHtml(who)}</span></div>`;
    if (llm) html += this.statusHtml('LLM', llm, now);
    if (jev) html += this.statusHtml(jev.name, jev, now);
    if (llm) html += this.strategyHtml(side, llm);
    const faction = side === 'west' ? Faction.FRIENDLY : Faction.ENEMY;
    const mine = heroes
      .filter((h) => h.faction === faction && h.controller === 'ai')
      .sort((a, b) => a.heroIndex - b.heroIndex);
    const latestJev = jev ? this.latestJev(jev) : null;
    for (const h of mine) html += this.heroHtml(side, h, jev, latestJev?.get(h.heroIndex), now);
    return html + this.metaHtml(this.panels[side], llm, jev);
  }

  private latestJev(jev: JevController): Map<number, JevDecision> {
    let l = this.latest.get(jev);
    if (!l) this.latest.set(jev, (l = { seen: 0, byHero: new Map() }));
    const all = jev.decisions;
    for (; l.seen < all.length; l.seen++) l.byHero.set(all[l.seen].heroIndex, all[l.seen]);
    return l.byHero;
  }

  // "LLM  answered 4 s ago in 3.2 s · next in 16 s", "thinking… 12 s", or why it stopped
  private statusHtml(name: string, layer: LlmController | JevController, now: number): string {
    let text: string;
    if (layer.failure) {
      text = `<span class="ai-fail">stopped: ${escapeHtml(layer.failure)}</span>`;
    } else if (layer.isWaiting()) {
      const open = layer.exchanges[layer.exchanges.length - 1];
      const waited = open && open.latencyMs === null ? ` ${Math.round(now - open.time)} s` : '';
      text = `<span class="ai-busy">thinking…</span>${waited}`;
    } else {
      const last = layer.decisions[layer.decisions.length - 1];
      const next = Math.max(0, Math.round(layer.nextDecisionAt - now));
      text = last
        ? `answered ${ago(now, last.time)} in ${seconds(last.latencyMs)} · next in ${next} s`
        : `first answer in ${next} s`;
    }
    if (!layer.failure && layer.lastError)
      text += `<div class="ai-warn">last request failed: ${escapeHtml(layer.lastError)} (asking again)</div>`;
    return `<div class="ai-status"><span class="ai-k">${name}</span><span>${text}</span></div>`;
  }

  // A text written by the LLM; a long one is cut to two lines with "more" to open it
  private text(key: string, cls: string, prefix: string, text: string): string {
    const t = escapeHtml(text);
    if (text.length <= LONG_TEXT) return `<div class="${cls}">${prefix}${t}</div>`;
    const open = this.open.has(key);
    const toggle = `<span class="ai-more" data-toggle="${key}">${open ? '▾ less' : '▸ more'}</span>`;
    return `<div class="${cls}${open ? '' : ' ai-clamp'}">${prefix}${t}</div>${toggle}`;
  }

  // The LLM's latest reading of the battle: stance and plan, the situation it read, rejected
  // orders. Long texts open with "more".
  private strategyHtml(side: Side, llm: LlmController): string {
    const d = llm.decisions[llm.decisions.length - 1];
    if (!d) return '';
    let html = '<div class="ai-strategy">';
    if (d.stance) html += `<span class="stance stance-${d.stance}">${d.stance}</span>`;
    if (d.plan) html += this.text(`${side}-plan`, 'ai-plan', '', d.plan);
    if (d.situation) html += this.text(`${side}-situation`, 'ai-situation', '', d.situation);
    if (d.rejected.length)
      html += `<div class="ai-fail">${d.rejected.map((o) => `rejected: ${escapeHtml(o)}`).join('<br>')}</div>`;
    return html + '</div>';
  }

  // One card per hero, a labelled line per layer: "now" is the order running and whose it is,
  // "LLM" the LLM's latest order with its reason, then what the tactical layer chose and whether
  // it was applied. A tactical order that differs from the LLM's overrides it (outlined).
  private heroHtml(
    side: Side,
    h: IHero,
    jev: JevController | undefined,
    d: JevDecision | undefined,
    now: number
  ): string {
    const name = `<span class="ai-hero-name">Hero ${h.heroIndex}</span>`;
    if (h.hp <= 0)
      return `<div class="ai-hero dead"><div class="ai-hero-head">${name}<span>dead</span></div></div>`;
    const g = this.stats.get(h.id);
    const vitals = [
      `HP ${Math.round((100 * h.hp) / h.maxHp)}%`,
      g ? count(g.followers, 'soldier') : '',
      heroState(h),
      positionToSubsector(h.position),
    ]
      .filter(Boolean)
      .join(' · ');
    let html = `<div class="ai-hero-head">${name}<span class="faint">${vitals}</span></div>`;

    // Jev's "follow the LLM" puts the LLM's order back in effect, so it counts as the LLM's
    const c = h.command;
    const resumes = c?.type === 'continueLlm';
    const effective = resumes ? h.lastLlmCommand : c;
    const source = resumes ? 'llm' : (h.commandSource ?? 'rule');
    const llmOrder = h.lastLlmCommand;
    const overrides =
      source === 'jev' && !!llmOrder && !!effective && !sameCommand(effective, llmOrder);
    // Following the LLM's order while it runs changes nothing, so the agreement shows here only
    // (if the tactical layer answered after that order was given)
    const agreed =
      resumes ||
      (source === 'llm' && d?.applied && d.choice === 'continue_llm' && d.time >= h.lastLlmTime);
    const tactical = jev?.name ?? 'Jev';
    const sourceName = source === 'jev' ? tactical : (SOURCE_NAME[source] ?? source);
    const since = source === 'llm' ? h.lastLlmTime : h.commandTime;

    let running = `<span class="ai-src ai-src-${source}">${sourceName}</span> `;
    running += effective
      ? `${escapeHtml(describeCommand(effective))} <span class="faint">· ${ago(now, since)}</span>`
      : '<span class="faint">no order yet</span>';
    if (agreed) running += ` <span class="ai-agree">· ${tactical} agrees</span>`;
    if (overrides) running += `<div class="ai-override">${tactical} overrides the LLM</div>`;
    html += line('now', running);

    html += line(
      'LLM',
      llmOrder
        ? `${escapeHtml(describeCommand(llmOrder))} <span class="faint">· ${ago(now, h.lastLlmTime)}</span>` +
            (llmOrder.reason
              ? this.text(`${side}-h${h.heroIndex}-why`, 'ai-why', 'why: ', llmOrder.reason)
              : '')
        : '<span class="faint">no order yet</span>'
    );

    if (jev) {
      let said = '<span class="faint">nothing yet</span>';
      if (d) {
        const a = jev.assessmentFor(h.heroIndex);
        const applied = d.applied
          ? '<span class="ai-agree">applied</span>'
          : `<span class="ai-warn">not applied: below ${percent(jev.minConfidence)}</span>`;
        const notes = [
          a.threat === undefined ? '' : `threat ${a.threat.toFixed(1)}/3`,
          a.surrounded === undefined ? '' : `surrounded ${percent(a.surrounded)}`,
          a.orderStillFits === undefined ? '' : `LLM order fits ${percent(a.orderStillFits)}`,
        ].filter(Boolean);
        said =
          `${escapeHtml(prettyChoice(d.choice))} · ${percent(d.confidence)} sure · ${applied} <span class="faint">· ${ago(now, d.time)}</span>` +
          (notes.length ? `<div class="faint">${notes.join(' · ')}</div>` : '');
      }
      html += line(tactical, said);
    }
    return `<div class="ai-hero${overrides ? ' override' : ''}">${html}</div>`;
  }

  // Decisions are only ever added, so their count stands for them
  private metaHtml(
    p: Panel,
    llm: LlmController | undefined,
    jev: JevController | undefined
  ): string {
    const key =
      `${llm?.decisions.length},${llm?.skippedRequests},${llm?.failedRequests},` +
      `${jev?.decisions.length},${jev?.skippedRequests},${jev?.failedRequests}`;
    const m = p.meta;
    if (m && m.llm === llm && m.jev === jev && m.key === key) return m.html;
    const html = this.buildMetaHtml(llm, jev);
    p.meta = { llm, jev, key, html };
    return html;
  }

  private buildMetaHtml(llm: LlmController | undefined, jev: JevController | undefined): string {
    const parts: string[] = [];
    if (llm && llm.decisions.length) {
      const avg = llm.decisions.reduce((sum, x) => sum + x.latencyMs, 0) / llm.decisions.length;
      const costs = llm.decisions.map((x) => x.usage?.costUsd).filter((c) => typeof c === 'number');
      const cost = costs.length ? ` · ≈$${costs.reduce((a, b) => a + b, 0).toFixed(3)}` : '';
      const failed = llm.failedRequests ? ` · ${llm.failedRequests} failed` : '';
      parts.push(
        `LLM: ${count(llm.decisions.length, 'answer')}, avg ${seconds(avg)}, ${llm.skippedRequests} skipped${failed}${cost}`
      );
    }
    if (jev && jev.decisions.length) {
      const requests = new Set(jev.decisions.map((d) => d.time)).size;
      const failed = jev.failedRequests ? ` · ${jev.failedRequests} failed` : '';
      const last = jev.decisions[jev.decisions.length - 1];
      const model = last.model ? ` · ${escapeHtml(last.model)}` : '';
      parts.push(
        `Jev: ${count(requests, 'request')}, ${jev.skippedRequests} skipped${failed}${model}`
      );
    }
    return parts.map((p) => `<div class="ai-meta faint">${p}</div>`).join('');
  }
}
