import type { JevController } from '../ai/JevController';
import type { LlmController } from '../ai/LlmController';
import { SimConfig } from '../types/types';
import type { AiSides } from './MatchLog';
import { AiRequestLog } from './AiRequestLog';

// Side-panel section showing what the AI layers decided, so a live test can be followed
// without the browser console: the LLM's stance, plan and orders, and Jev's latest choice
// per hero, with response times, skipped requests and failures.

const SIDE_NAME = { west: 'West', east: 'East' } as const;

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

// "step_north_east" → "step north-east", "attack_hero_2" → "attack hero 2"
function prettyChoice(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/(north|south) (east|west)/, '$1-$2')
    .replace('continue llm', 'follow LLM');
}

export class AiPanel {
  private elSection = document.getElementById('ai-section')!;
  private elBody = document.getElementById('ai-body')!;
  private last = '';
  private requestLog = new AiRequestLog();

  update(sides: AiSides, config: SimConfig, simTime: number): void {
    const active = (['west', 'east'] as const).filter((s) => sides[s].jev || sides[s].llm);
    this.elSection.hidden = active.length === 0;
    this.requestLog.update(sides);
    if (active.length === 0) return;
    const html = active
      .map((s) => this.sideHtml(s, sides[s].llm, sides[s].jev, config, simTime))
      .join('');
    if (html === this.last) return;
    this.last = html;
    this.elBody.innerHTML = html;
  }

  private sideHtml(
    side: 'west' | 'east',
    llm: LlmController | undefined,
    jev: JevController | undefined,
    config: SimConfig,
    now: number
  ): string {
    const model = side === 'west' ? config.friendlyModel : config.enemyModel;
    const name = model ? ` ${model[0].toUpperCase()}${model.slice(1)}` : '';
    const who = [llm ? `LLM${name}` : '', jev ? 'Jev' : ''].filter(Boolean).join(' + ');
    let html = `<div class="ai-side"><div class="army-head"><span class="${side}-text">${SIDE_NAME[side]}</span><span class="army-who">${who}</span></div>`;
    if (llm) html += this.llmHtml(llm, now);
    if (jev) html += this.jevHtml(jev, now);
    return html + '</div>';
  }

  private llmHtml(llm: LlmController, now: number): string {
    const d = llm.decisions[llm.decisions.length - 1];
    let html = '<div class="ai-layer"><span class="ai-name">LLM</span>';
    if (d) {
      html += d.stance ? `<span class="stance stance-${d.stance}">${d.stance}</span>` : '';
      html += `<span class="faint">${ago(now, d.time)} · ${seconds(d.latencyMs)}</span>`;
    }
    if (llm.isWaiting()) html += '<span class="ai-busy">thinking…</span>';
    html += '</div>';
    if (llm.failure) html += `<div class="ai-fail">Stopped: ${escapeHtml(llm.failure)}</div>`;
    else if (llm.lastError)
      html += `<div class="ai-warn">Last request failed: ${escapeHtml(llm.lastError)} (asking again)</div>`;
    if (!d) return html + (llm.failure ? '' : '<div class="faint">no decision yet</div>');
    if (d.plan)
      html += `<div class="ai-plan" title="${escapeHtml(d.situation)}">${escapeHtml(d.plan)}</div>`;
    if (d.orders.length)
      html += `<div class="ai-orders">${d.orders.map((o) => escapeHtml(o)).join('<br>')}</div>`;
    if (d.rejected.length)
      html += `<div class="ai-fail" title="${escapeHtml(d.rejected.join(' | '))}">${d.rejected.length} order${d.rejected.length > 1 ? 's' : ''} rejected</div>`;
    const avg = llm.decisions.reduce((sum, x) => sum + x.latencyMs, 0) / llm.decisions.length;
    const costs = llm.decisions.map((x) => x.usage?.costUsd).filter((c) => typeof c === 'number');
    const cost = costs.length ? ` · ≈$${costs.reduce((a, b) => a + b, 0).toFixed(3)}` : '';
    const failed = llm.failedRequests ? ` · ${llm.failedRequests} failed` : '';
    html += `<div class="ai-meta faint">${count(llm.decisions.length, 'decision')} · avg ${seconds(avg)} · ${llm.skippedRequests} skipped${failed}${cost}</div>`;
    return html;
  }

  private jevHtml(jev: JevController, now: number): string {
    const all = jev.decisions;
    const last = all[all.length - 1];
    let html = '<div class="ai-layer"><span class="ai-name">Jev</span>';
    if (last)
      html += `<span class="faint">${ago(now, last.time)} · ${seconds(last.latencyMs)}</span>`;
    if (jev.isWaiting()) html += '<span class="ai-busy">thinking…</span>';
    html += '</div>';
    if (jev.failure) html += `<div class="ai-fail">Stopped: ${escapeHtml(jev.failure)}</div>`;
    else if (jev.lastError)
      html += `<div class="ai-warn">Last request failed: ${escapeHtml(jev.lastError)} (asking again)</div>`;
    if (!last) return html + (jev.failure ? '' : '<div class="faint">no decision yet</div>');

    // Latest decision for each hero that has one
    const latest = new Map<number, (typeof all)[number]>();
    for (const d of all) latest.set(d.heroIndex, d);
    const rows = [...latest.values()]
      .sort((a, b) => a.heroIndex - b.heroIndex)
      .map((d) => {
        const conf = `${Math.round(d.confidence * 100)}%`;
        const threat = d.threat === undefined ? '' : ` · threat ${d.threat}`;
        const kept = d.applied ? '' : ' <span class="faint">(kept order)</span>';
        return `<div class="ai-hero">Hero ${d.heroIndex}: ${escapeHtml(prettyChoice(d.choice))} ${conf}${threat}${kept}</div>`;
      })
      .join('');
    const requests = new Set(all.map((d) => d.time)).size;
    const failed = jev.failedRequests ? ` · ${jev.failedRequests} failed` : '';
    const model = last.model ? ` · ${escapeHtml(last.model)}` : '';
    return (
      html +
      rows +
      `<div class="ai-meta faint">${count(requests, 'request')} · ${jev.skippedRequests} skipped${failed}${model}</div>`
    );
  }
}
