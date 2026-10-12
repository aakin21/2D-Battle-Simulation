import type { JevController } from '../ai/JevController';
import type { LlmController } from '../ai/LlmController';
import { groupStats, GroupStats } from '../ai/Observations';
import { sameCommand } from '../engine/HeroCommands';
import { positionToSubsector } from '../engine/Sectors';
import { BehaviorState, Faction, IHero, SimConfig } from '../types/types';
import type { StateManager } from '../state/StateManager';
import type { AiSides } from './MatchLog';
import { AiRequestLog } from './AiRequestLog';
import { describeCommand } from './Hud';

// The AI panels in the side panel, below Map, Armies and Area: one for each side with AI
// layers, West and East side by side when both have them. Each shows when the LLM and Jev last
// answered and when they ask next, the LLM's stance, plan and situation, then one block per
// hero with a line for each layer: the order running now and whose it is (the LLM's, or Jev's,
// which then overrides the LLM), the LLM's latest order with its reason (D41), Jev's latest
// choice with its assessment, and the hero's state; below, that side's requests and answers.

const SIDE_NAME = { west: 'West', east: 'East' } as const;
type Side = 'west' | 'east';
type JevDecision = JevController['decisions'][number];

const STATS_EVERY_MS = 500; // followers are counted at most this often (every unit is visited)

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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
  return key
    .replace(/_/g, ' ')
    .replace(/(north|south) (east|west)/, '$1-$2')
    .replace('continue llm', 'follow the LLM');
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

const SOURCE_NAME: Record<string, string> = { llm: 'LLM', jev: 'Jev', rule: 'rules', user: 'user' };

interface Panel {
  el: HTMLElement;
  main: HTMLElement;
  log: AiRequestLog;
  last: string;
}

export class AiPanel {
  private elSide = document.getElementById('side-panel')!;
  private panels: Record<Side, Panel>;
  private stats = new Map<string, GroupStats>();
  private statsAt = 0;

  constructor() {
    const panel = (side: Side): Panel => {
      const el = document.getElementById(`ai-col-${side}`)!;
      return {
        el,
        main: el.querySelector('.ai-col-main')!,
        log: new AiRequestLog(side, el),
        last: '',
      };
    };
    this.panels = { west: panel('west'), east: panel('east') };
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
    const name = model ? ` ${model[0].toUpperCase()}${model.slice(1)}` : '';
    const who = [llm ? `LLM${name}` : '', jev ? 'Jev' : ''].filter(Boolean).join(' + ');
    let html =
      `<div class="ai-head"><span class="ai-side-name ${side}-text">${SIDE_NAME[side]}</span>` +
      `<span class="army-who">${escapeHtml(who)}</span></div>`;
    if (llm) html += this.statusHtml('LLM', llm, now);
    if (jev) html += this.statusHtml('Jev', jev, now);
    if (llm) html += this.strategyHtml(llm);
    const faction = side === 'west' ? Faction.FRIENDLY : Faction.ENEMY;
    const mine = heroes
      .filter((h) => h.faction === faction && h.controller === 'ai')
      .sort((a, b) => a.heroIndex - b.heroIndex);
    const latestJev = new Map<number, JevDecision>();
    for (const d of jev?.decisions ?? []) latestJev.set(d.heroIndex, d);
    html += mine.map((h) => this.heroHtml(h, jev, latestJev.get(h.heroIndex), now)).join('');
    return html + this.metaHtml(llm, jev);
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

  // The LLM's latest reading of the battle: stance, plan, situation, rejected orders
  private strategyHtml(llm: LlmController): string {
    const d = llm.decisions[llm.decisions.length - 1];
    if (!d) return '';
    let html = '<div class="ai-strategy">';
    if (d.stance) html += `<span class="stance stance-${d.stance}">${d.stance}</span> `;
    if (d.plan) html += `<span class="ai-plan">${escapeHtml(d.plan)}</span>`;
    if (d.situation) html += `<div class="ai-situation">${escapeHtml(d.situation)}</div>`;
    if (d.rejected.length)
      html += `<div class="ai-fail">${d.rejected.map((o) => `rejected: ${escapeHtml(o)}`).join('<br>')}</div>`;
    return html + '</div>';
  }

  // One block per hero: running now (and whose), what the LLM ordered and why, what Jev said,
  // the hero's state
  private heroHtml(
    h: IHero,
    jev: JevController | undefined,
    d: JevDecision | undefined,
    now: number
  ): string {
    const name = `<span class="ai-hero-name">Hero ${h.heroIndex}</span>`;
    if (h.hp <= 0)
      return `<div class="ai-hero dead"><div class="ai-hero-head">${name}<span>dead</span></div></div>`;
    const g = this.stats.get(h.id);
    const vitals = `HP ${Math.round((100 * h.hp) / h.maxHp)}%${g ? ` · ${count(g.followers, 'soldier')}` : ''}`;
    let html = `<div class="ai-hero-head">${name}<span class="faint">${vitals}</span></div>`;

    // Running now and whose it is. Jev's "follow the LLM" puts the LLM's order back in effect,
    // so it counts as the LLM's; a Jev order that differs from the LLM's overrides it.
    const c = h.command;
    const resumes = c?.type === 'continueLlm';
    const effective = resumes ? h.lastLlmCommand : c;
    const source = resumes ? 'llm' : (h.commandSource ?? 'rule');
    const overrides =
      source === 'jev' &&
      !!h.lastLlmCommand &&
      !!effective &&
      !sameCommand(effective, h.lastLlmCommand);
    // Jev following the LLM's order while it runs changes nothing, so it shows here only (if
    // Jev answered after that order was given)
    const agreed =
      resumes ||
      (source === 'llm' && d?.applied && d.choice === 'continue_llm' && d.time >= h.lastLlmTime);
    let running = `<span class="ai-src ai-src-${source}">${SOURCE_NAME[source] ?? source}</span> `;
    running += effective
      ? escapeHtml(describeCommand(effective))
      : '<span class="faint">no order</span>';
    if (agreed) running += ' <span class="faint">(Jev agreed)</span>';
    if (overrides) running += '<div class="ai-override">Jev overrides the LLM</div>';
    html += line('now', running);

    const o = h.lastLlmCommand;
    html += line(
      'LLM',
      o
        ? `${escapeHtml(describeCommand(o))} <span class="faint">· ${ago(now, h.lastLlmTime)}</span>` +
            (o.reason ? `<div class="ai-why">why: ${escapeHtml(o.reason)}</div>` : '')
        : '<span class="faint">no order yet</span>'
    );

    if (jev) {
      let said = '<span class="faint">nothing yet</span>';
      if (d) {
        const a = jev.assessmentFor(h.heroIndex);
        const notes = [
          a.threat === undefined ? '' : `threat ${a.threat}`,
          a.surrounded === undefined ? '' : `surrounded ${percent(a.surrounded)}`,
          a.orderStillFits === undefined ? '' : `LLM order fits ${percent(a.orderStillFits)}`,
        ].filter(Boolean);
        said =
          `${escapeHtml(prettyChoice(d.choice))} ${percent(d.confidence)} <span class="faint">· ${ago(now, d.time)}</span>` +
          (d.applied ? '' : '<div class="faint">too unsure: not applied</div>') +
          (notes.length ? `<div class="faint">${notes.join(' · ')}</div>` : '');
      }
      html += line('Jev', said);
    }

    html += line('state', `${heroState(h)} · ${positionToSubsector(h.position)}`);
    return `<div class="ai-hero${overrides ? ' override' : ''}">${html}</div>`;
  }

  private metaHtml(llm: LlmController | undefined, jev: JevController | undefined): string {
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
