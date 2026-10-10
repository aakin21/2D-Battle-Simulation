import { SimulationEngine, MatchResult } from '../engine/SimulationEngine';
import { StateManager } from '../state/StateManager';
import type { Renderer } from '../rendering/Renderer';
import {
  IUnit,
  IHero,
  UnitType,
  Faction,
  BehaviorState,
  HeroCommand,
  SimConfig,
  SideAI,
} from '../types/types';
import { positionToSubsector } from '../engine/Sectors';
import { escapeHtml } from './AiPanel';

// What the player sees around the map: the match banner in the top bar, the armies in the
// side panel, the selected-unit card, area counts and the match result. Read-only: it never
// changes the simulation.

const SIDES = [Faction.FRIENDLY, Faction.ENEMY] as const;
const SIDE_NAME = ['West', 'East'];
const SIDE_CLASS = ['west', 'east'];

// Per-side totals at the start of a match, for "how much is left" bars
interface Baseline {
  soldiers: [number, number];
  heroes: [number, number];
  hp: [number, number];
}

export function sideLabel(ai: SideAI | undefined, faction: Faction, model?: string): string {
  if (!ai || ai === 'none') return faction === Faction.FRIENDLY ? 'You' : 'Rules';
  const m = model ? ` ${model[0].toUpperCase()}${model.slice(1)}` : '';
  if (ai === 'llm') return `LLM${m}`;
  return `Jev + LLM${m}`;
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function bar(ratio: number, cls = ''): string {
  const pct = Math.round(Math.max(0, Math.min(1, ratio)) * 100);
  return `<div class="bar ${cls}"><i style="width:${pct}%"></i></div>`;
}

function hpColor(ratio: number): string {
  return ratio > 0.5 ? 'var(--hp)' : ratio > 0.25 ? 'var(--hp-low)' : 'var(--hp-crit)';
}

export function describeCommand(c: HeroCommand): string {
  switch (c.type) {
    case 'move':
      return `move to ${positionToSubsector(c.target)}`;
    case 'hold':
      return `hold in ${positionToSubsector(c.at)}`;
    case 'retreat':
      return 'retreat a short way';
    case 'attack':
      return 'attack nearest enemy';
    case 'attackHero':
      return `attack enemy hero ${c.heroIndex}`;
    case 'regroup':
      return 'regroup strays';
    case 'attackBase':
      return 'attack the enemy base';
    case 'continueLlm':
      return "follow the LLM's order";
  }
}

function stateText(unit: IUnit): string {
  switch (unit.state) {
    case BehaviorState.ATTACK:
      return 'Fighting';
    case BehaviorState.FLEE:
      return unit.unitType === UnitType.HERO ? 'Retreating (reflex)' : 'Fleeing';
    case BehaviorState.REST:
      return 'Resting';
    default:
      return unit.path.length > 0 ? 'Moving' : 'Standing';
  }
}

function unitName(unit: IUnit, battle: boolean): string {
  if (unit.unitType === UnitType.HERO) {
    const hero = unit as IHero;
    return battle ? `${SIDE_NAME[hero.faction]} hero ${hero.heroIndex}` : 'Hero';
  }
  if (!battle) return unit.unitType === UnitType.WARRIOR ? 'Warrior' : 'Berserker';
  return `${SIDE_NAME[unit.faction]} soldier`;
}

export class Hud {
  private elBanner = document.getElementById('match-banner')!;
  private elArmies = document.getElementById('armies-body')!;
  private elArmiesTitle = document.getElementById('armies-title')!;
  private elCard = document.getElementById('unit-card')!;
  private elPortrait = document.getElementById('unit-portrait') as HTMLCanvasElement;
  private elType = document.getElementById('unit-type')!;
  private elHp = document.getElementById('unit-hp')!;
  private elHpBar = document.getElementById('unit-hp-bar')!;
  private elCourage = document.getElementById('unit-courage')!;
  private elCourageBar = document.getElementById('unit-courage-bar')!;
  private elCourageRow = document.getElementById('unit-courage-row')!;
  private elState = document.getElementById('unit-state')!;
  private elOrder = document.getElementById('unit-order')!;
  private elOrderRow = document.getElementById('unit-order-row')!;
  private elStats = document.getElementById('stat-content')!;
  private elResult = document.getElementById('match-result')!;
  private elWaiting = document.getElementById('waiting-ai')!;

  private baseline: Baseline | null = null;
  private lastTime = Infinity;
  private portraitOf: string | null = null;
  private lastBanner = '';
  private lastArmies = '';

  constructor(
    private engine: SimulationEngine,
    private stateManager: StateManager,
    private renderer: Renderer
  ) {}

  // Call when a run starts or restarts
  reset(): void {
    this.baseline = null;
    this.lastTime = Infinity;
    this.portraitOf = null;
    this.elResult.hidden = true;
  }

  update(config: SimConfig): void {
    const bf = this.stateManager.getBattlefield();
    // Sim time went back: a new run started (e.g. stress test restart)
    if (bf.elapsedTime < this.lastTime) this.baseline = null;
    this.lastTime = bf.elapsedTime;
    if (!this.baseline) this.baseline = this.measureBaseline();

    this.setHtml(this.elBanner, 'lastBanner', this.bannerHtml());
    this.setHtml(this.elArmies, 'lastArmies', this.armiesHtml(config));
    this.elWaiting.hidden = !this.engine.isWaitingForAI();
  }

  private setHtml(el: HTMLElement, key: 'lastBanner' | 'lastArmies', html: string): void {
    if (this[key] === html) return;
    this[key] = html;
    el.innerHTML = html;
  }

  private measureBaseline(): Baseline {
    const b: Baseline = { soldiers: [0, 0], heroes: [0, 0], hp: [0, 0] };
    for (const u of this.stateManager.getBattlefield().units) {
      if (u.hp <= 0) continue;
      if (u.unitType === UnitType.HERO) b.heroes[u.faction]++;
      else b.soldiers[u.faction]++;
      b.hp[u.faction] += u.maxHp;
    }
    return b;
  }

  // --- Top bar ---

  private bannerHtml(): string {
    const bf = this.stateManager.getBattlefield();
    if (!this.engine.isBattleMode()) {
      let warriors = 0;
      let berserkers = 0;
      for (const u of bf.units) {
        if (u.unitType === UnitType.WARRIOR) warriors++;
        else if (u.unitType === UnitType.BERSERKER) berserkers++;
      }
      return (
        `<div class="banner well">` +
        `<span class="side"><span class="side-name west-text">Warriors</span><span class="side-val west-text">${warriors}</span></span>` +
        `<span class="mid">Wave ${bf.waveNumber}<span class="clock">${clock(bf.elapsedTime)}</span></span>` +
        `<span class="side"><span class="side-val east-text">${berserkers}</span><span class="side-name east-text">Berserkers</span></span>` +
        `</div>`
      );
    }

    const o = bf.objective;
    const left = o.timeLimit === null ? 0 : o.timeLimit - bf.elapsedTime;
    const time = `<span class="clock${left < 30 ? ' low' : ''}">${clock(left)}</span>`;
    let west = '';
    let east = '';
    let mid = '';
    if (o.mode === 'control') {
      west = String(Math.floor(o.scores.friendly));
      east = String(Math.floor(o.scores.enemy));
      const flags = o.points
        .map((p) => {
          const cls = p.holder === null ? '' : ` ${SIDE_CLASS[p.holder]}`;
          return `<span class="flag${cls}" title="Point ${p.name}">${p.name}</span>`;
        })
        .join('');
      mid = `${flags}${time}`;
    } else if (o.mode === 'base') {
      const pct = (f: Faction) => {
        const b = o.bases.find((x) => x.faction === f);
        return b ? b.hp / b.maxHp : 0;
      };
      west = `<span class="base-bar">${bar(pct(Faction.FRIENDLY), 'west')}</span>`;
      east = `<span class="base-bar">${bar(pct(Faction.ENEMY), 'east')}</span>`;
      mid = `Base${time}`;
    } else {
      const count = [0, 0];
      for (const u of bf.units) if (u.hp > 0) count[u.faction]++;
      west = String(count[Faction.FRIENDLY]);
      east = String(count[Faction.ENEMY]);
      mid = `Elimination${time}`;
    }
    return (
      `<div class="banner well">` +
      `<span class="side"><span class="side-name west-text">West</span><span class="side-val west-text">${west}</span></span>` +
      `<span class="mid">${mid}</span>` +
      `<span class="side"><span class="side-val east-text">${east}</span><span class="side-name east-text">East</span></span>` +
      `</div>`
    );
  }

  // --- Side panel: armies ---

  private armiesHtml(config: SimConfig): string {
    const bf = this.stateManager.getBattlefield();
    const base = this.baseline!;
    const soldiers = [0, 0];
    const hp = [0, 0];
    const fleeing = [0, 0];
    for (const u of bf.units) {
      if (u.hp <= 0) continue;
      hp[u.faction] += u.hp;
      if (u.unitType === UnitType.HERO) continue;
      soldiers[u.faction]++;
      if (u.state === BehaviorState.FLEE) fleeing[u.faction]++;
    }

    if (!this.engine.isBattleMode()) {
      this.elArmiesTitle.textContent = 'Armies';
      const hero = this.stateManager.getHero();
      const heroRow = hero
        ? `<div class="army-row hero-row"><span class="lbl">Hero</span>${bar(hero.hp / hero.maxHp)}<span class="val">${Math.ceil(hero.hp)}</span></div>`
        : `<div class="army-row hero-row dead"><span class="lbl">Hero</span><span class="faint">fallen</span></div>`;
      return (
        `<div class="army"><div class="army-head"><span class="west-text">Warriors</span><span>${soldiers[Faction.FRIENDLY]}</span></div>` +
        heroRow +
        `<div class="army-row"><span class="lbl">Fleeing</span><span class="val">${fleeing[Faction.FRIENDLY]}</span></div></div>` +
        `<div class="army"><div class="army-head"><span class="east-text">Berserkers</span><span>${soldiers[Faction.ENEMY]}</span></div>` +
        `<div class="army-row"><span class="lbl">Wave</span><span class="val">${bf.waveNumber}</span></div>` +
        `<div class="army-row"><span class="lbl">Fallen</span><span class="val">${bf.stats.casualties}</span></div></div>`
      );
    }

    this.elArmiesTitle.textContent = 'Armies';
    const models = [config.friendlyModel, config.enemyModel];
    const ais = [config.friendlyAI, config.enemyAI];
    const heroes = this.stateManager.getHeroes();
    return SIDES.map((f) => {
      const who = sideLabel(ais[f], f, ais[f]?.includes('llm') ? models[f] : undefined);
      const total = base.soldiers[f] || 1;
      const heroRows = heroes
        .filter((h) => h.faction === f)
        .sort((a, b) => a.heroIndex - b.heroIndex)
        .map((h) => {
          const r = h.hp / h.maxHp;
          const tag =
            h.state === BehaviorState.FLEE ? 'flee' : h.state === BehaviorState.REST ? 'rest' : '';
          return `<div class="army-row hero-row"><span class="lbl">Hero ${h.heroIndex}</span><div class="bar"><i style="width:${Math.round(r * 100)}%;background:${hpColor(r)}"></i></div><span class="hero-state">${tag}</span></div>`;
        })
        .join('');
      const fallen = Math.max(0, base.heroes[f] - heroes.filter((h) => h.faction === f).length);
      return (
        `<div class="army"><div class="army-head"><span class="${SIDE_CLASS[f]}-text">${SIDE_NAME[f]}</span><span class="army-who">${who}</span></div>` +
        `<div class="army-row"><span class="lbl">Soldiers</span>${bar(soldiers[f] / total, SIDE_CLASS[f])}<span class="val">${soldiers[f]}</span></div>` +
        `<div class="army-row"><span class="lbl">HP</span>${bar(hp[f] / (base.hp[f] || 1))}<span class="val">${Math.round((100 * hp[f]) / (base.hp[f] || 1))}%</span></div>` +
        heroRows +
        (fallen > 0
          ? `<div class="army-row hero-row dead"><span class="lbl">Fallen</span><span class="faint">${fallen} hero${fallen > 1 ? 'es' : ''}</span></div>`
          : '') +
        `<div class="army-row"><span class="lbl">Fleeing</span><span class="val">${fleeing[f]}</span></div></div>`
      );
    }).join('');
  }

  // --- Selected unit ---

  private lastOrderHtml = '';

  showUnit(unit: IUnit | null): void {
    if (!unit) {
      this.elCard.hidden = true;
      this.portraitOf = null;
      return;
    }
    const battle = this.engine.isBattleMode();
    this.elCard.hidden = false;
    if (this.portraitOf !== unit.id) {
      this.portraitOf = unit.id;
      this.renderer.drawPortrait(this.elPortrait.getContext('2d')!, unit);
    }
    this.elType.textContent = unitName(unit, battle);
    this.elType.className = `uc-title ${battle || unit.unitType !== UnitType.HERO ? SIDE_CLASS[unit.faction] + '-text' : ''}`;
    const r = unit.hp / unit.maxHp;
    this.elHp.textContent = `${Math.ceil(unit.hp)} / ${unit.maxHp}`;
    this.elHpBar.style.width = `${Math.round(r * 100)}%`;
    this.elHpBar.style.background = hpColor(r);

    const usesCourage =
      unit.unitType === UnitType.WARRIOR || (battle && unit.unitType === UnitType.BERSERKER);
    this.elCourageRow.hidden = !usesCourage;
    if (usesCourage) {
      this.elCourage.textContent = String(Math.round(unit.courage));
      this.elCourageBar.style.width = `${Math.round(Math.max(0, Math.min(100, unit.courage)))}%`;
    }
    this.elState.textContent = stateText(unit);

    const hero = unit.unitType === UnitType.HERO ? (unit as IHero) : null;
    this.elOrderRow.hidden = !hero;
    if (hero) {
      // The current order, and the LLM's latest order with its reason (Jev may have overridden
      // it for the moment)
      const now = hero.command
        ? `${describeCommand(hero.command)} · ${hero.commandSource ?? '?'}`
        : 'none';
      const llm = hero.lastLlmCommand;
      const llmLine =
        llm && hero.commandSource !== 'llm'
          ? `<br><span class="faint">LLM: ${escapeHtml(describeCommand(llm))}</span>`
          : '';
      const reason = llm?.reason
        ? `<br><span class="faint">why: ${escapeHtml(llm.reason)}</span>`
        : '';
      const html = `${escapeHtml(now)}${llmLine}${reason}`;
      // The browser rewrites innerHTML, so compare with what was last set
      if (this.lastOrderHtml !== html) {
        this.lastOrderHtml = html;
        this.elOrder.innerHTML = html;
      }
    }
  }

  // --- Area counts (drag on the map) ---

  showArea(units: IUnit[]): void {
    const battle = this.engine.isBattleMode();
    const soldiers = [0, 0];
    const heroes = [0, 0];
    for (const u of units) {
      if (u.unitType === UnitType.HERO) heroes[u.faction]++;
      else soldiers[u.faction]++;
    }
    const line = (label: string, value: number, cls: string) =>
      `<div class="stat-line"><span class="${cls}">${label}</span><span>${value}</span></div>`;
    this.elStats.className = '';
    this.elStats.innerHTML = battle
      ? line('West soldiers', soldiers[0], 'west-text') +
        line('West heroes', heroes[0], 'west-text') +
        line('East soldiers', soldiers[1], 'east-text') +
        line('East heroes', heroes[1], 'east-text')
      : line('Warriors', soldiers[0], 'west-text') +
        line('Berserkers', soldiers[1], 'east-text') +
        line('Hero', heroes[0], '');
  }

  // --- Match result ---

  showResult(
    r: MatchResult,
    config: SimConfig,
    actions: { restart(): void; menu(): void; log(): void }
  ): void {
    const bf = this.stateManager.getBattlefield();
    const winner = r.winner;
    const title =
      winner === null
        ? '<h2>Draw</h2>'
        : `<h2 class="${SIDE_CLASS[winner]}-text">${SIDE_NAME[winner]} wins</h2>`;
    // A side with nowhere to deploy (e.g. a saved map split by mountains) loses at once
    const noRoom = r.reason === 'elimination' && r.time < 1;
    const how = noRoom
      ? 'one army had no room to deploy on this map'
      : winner === null
        ? r.reason === 'elimination'
          ? 'both sides destroyed at once'
          : 'time up, both sides equal'
        : r.reason === 'base'
          ? 'base destroyed'
          : r.reason === 'points'
            ? 'time up, more points'
            : r.reason === 'time'
              ? 'time up, more HP left'
              : 'all enemy units destroyed';

    const units = [0, 0];
    const heroes = [0, 0];
    const hp = [0, 0];
    for (const u of bf.units) {
      if (u.hp <= 0) continue;
      units[u.faction]++;
      hp[u.faction] += u.hp;
      if (u.unitType === UnitType.HERO) heroes[u.faction]++;
    }
    const base = this.baseline ?? this.measureBaseline();
    const row = (label: string, a: string | number, b: string | number) =>
      `<tr><td>${label}</td><td class="west-text">${a}</td><td class="east-text">${b}</td></tr>`;
    const o = bf.objective;
    let extra = '';
    if (o.mode === 'control') {
      extra = row('Points', Math.floor(o.scores.friendly), Math.floor(o.scores.enemy));
    } else if (o.mode === 'base') {
      const pct = (f: Faction) => {
        const b = o.bases.find((x) => x.faction === f);
        return b ? `${Math.round((100 * b.hp) / b.maxHp)}%` : '–';
      };
      extra = row('Base HP', pct(Faction.FRIENDLY), pct(Faction.ENEMY));
    }

    this.elResult.innerHTML =
      title +
      `<div class="how">${how} · ${clock(r.time)}</div>` +
      `<table>` +
      `<tr><th></th><th class="west-text">West · ${sideLabel(config.friendlyAI, Faction.FRIENDLY, config.friendlyAI?.includes('llm') ? config.friendlyModel : undefined)}</th>` +
      `<th class="east-text">East · ${sideLabel(config.enemyAI, Faction.ENEMY, config.enemyAI?.includes('llm') ? config.enemyModel : undefined)}</th></tr>` +
      row('Units left', units[0], units[1]) +
      row('Heroes alive', heroes[0], heroes[1]) +
      row(
        'HP left',
        `${Math.round((100 * hp[0]) / (base.hp[0] || 1))}%`,
        `${Math.round((100 * hp[1]) / (base.hp[1] || 1))}%`
      ) +
      extra +
      `</table>` +
      `<div class="actions"><button class="btn" data-act="restart">Restart</button><button class="btn btn-quiet" data-act="menu">Menu</button>` +
      `<button class="btn btn-quiet" data-act="log" title="Settings, timeline and every AI decision as JSON">Download log</button></div>`;
    this.elResult.querySelector('[data-act="restart"]')!.addEventListener('click', actions.restart);
    this.elResult.querySelector('[data-act="menu"]')!.addEventListener('click', actions.menu);
    this.elResult.querySelector('[data-act="log"]')!.addEventListener('click', actions.log);
    this.elResult.hidden = false;
  }

  // The run was stopped by an error in the simulation (SimulationEngine.fail).
  showError(
    message: string,
    time: number,
    actions: { restart(): void; menu(): void; log: (() => void) | null }
  ): void {
    this.elResult.innerHTML =
      '<h2>Simulation stopped</h2>' +
      `<div class="how">An error stopped this run at ${clock(time)}:</div>` +
      `<div class="error-text">${escapeHtml(message)}</div>` +
      `<div class="actions"><button class="btn" data-act="restart">Restart</button><button class="btn btn-quiet" data-act="menu">Menu</button>` +
      (actions.log
        ? '<button class="btn btn-quiet" data-act="log" title="Settings, timeline and every AI decision as JSON">Download log</button>'
        : '') +
      '</div>';
    this.elResult.querySelector('[data-act="restart"]')!.addEventListener('click', actions.restart);
    this.elResult.querySelector('[data-act="menu"]')!.addEventListener('click', actions.menu);
    if (actions.log)
      this.elResult.querySelector('[data-act="log"]')!.addEventListener('click', actions.log);
    this.elResult.hidden = false;
  }

  hideResult(): void {
    this.elResult.hidden = true;
  }
}
