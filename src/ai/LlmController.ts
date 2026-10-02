import { SimulationEngine } from '../engine/SimulationEngine';
import { StateManager } from '../state/StateManager';
import { positionToSector, sectorCenter, SECTORS_PER_SIDE, SECTOR_SIZE } from '../engine/Sectors';
import { Faction, IHero, HeroCommand, BehaviorState, TerrainType, UnitType } from '../types/types';

// Layer 3 (D1, D10): the LLM plans the overall strategy every 15–30 s from a summary of the
// whole map (D16). It runs in the dev server through the Claude Agent SDK (/api/llm).

export interface LlmDecision {
  time: number; // simulation time when the request was sent
  latencyMs: number;
  plan: string;
  orders: string[]; // orders that were valid and applied, e.g. "hero 1: move D4"
  rejected: string[]; // orders that could not be used, with the reason
  raw: string;
}

export interface LlmOptions {
  intervalSec: number;
  fallbackToRules: boolean; // on failure, hand heroes to the rule layer (when the LLM is the only AI layer)
  endpoint: string;
  fetchFn: typeof fetch;
  recentTactical: (heroIndex: number) => string[]; // Jev's latest decisions per hero (D15)
}

const DEFAULTS: LlmOptions = {
  intervalSec: 20,
  fallbackToRules: true,
  endpoint: '/api/llm',
  fetchFn: (...args) => fetch(...args),
  recentTactical: () => [],
};

interface RawOrder {
  hero?: unknown;
  command?: unknown;
  sector?: unknown;
  target_hero?: unknown;
}

export class LlmController {
  private opts: LlmOptions;
  private nextAt = 0;
  private pending = false;
  private failed = false;
  private readonly matchId = `match_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  readonly decisions: LlmDecision[] = [];
  skippedRequests = 0;

  constructor(
    private engine: SimulationEngine,
    private stateManager: StateManager,
    private faction: Faction,
    opts: Partial<LlmOptions> = {}
  ) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  tick(elapsed: number): void {
    if (this.failed || elapsed < this.nextAt) return;
    this.nextAt = elapsed + this.opts.intervalSec;
    if (this.pending) {
      this.skippedRequests++;
      return;
    }
    void this.decide(elapsed);
  }

  private myHeroes(): IHero[] {
    return this.stateManager
      .getHeroes()
      .filter((h) => h.faction === this.faction && h.hp > 0 && h.controller === 'ai');
  }

  private async decide(time: number): Promise<void> {
    const heroes = this.myHeroes();
    if (heroes.length === 0) return;

    this.pending = true;
    const started = performance.now();
    try {
      const res = await this.opts.fetchFn(this.opts.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          side: this.faction === Faction.FRIENDLY ? 'west' : 'east',
          matchId: this.matchId,
          prompt: JSON.stringify(this.report(time)),
        }),
      });
      const latencyMs = performance.now() - started;
      if (!res.ok) {
        this.fail(`HTTP ${res.status}`, res.status === 404 ? 'The LLM only works with the dev server (npm run dev).' : '');
        return;
      }
      const { text } = (await res.json()) as { text: string };
      this.apply(time, latencyMs, text ?? '');
    } catch (err) {
      this.fail(String(err), 'Is the dev server running (npm run dev)?');
    } finally {
      this.pending = false;
    }
  }

  // Validates the LLM's orders and applies the usable ones through the command interface.
  private apply(time: number, latencyMs: number, text: string): void {
    const decision: LlmDecision = { time, latencyMs, plan: '', orders: [], rejected: [], raw: text };
    this.decisions.push(decision);

    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    let parsed: { plan?: unknown; orders?: unknown };
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      decision.rejected.push('reply was not valid JSON');
      return;
    }
    decision.plan = typeof parsed.plan === 'string' ? parsed.plan : '';
    if (!Array.isArray(parsed.orders)) {
      decision.rejected.push('no "orders" list');
      return;
    }

    for (const raw of parsed.orders as RawOrder[]) {
      const hero = this.myHeroes().find((h) => h.heroIndex === Number(raw.hero));
      if (!hero) {
        decision.rejected.push(`unknown or dead hero ${String(raw.hero)}`);
        continue;
      }
      const command = this.toCommand(hero, raw);
      if (typeof command === 'string') {
        decision.rejected.push(`hero ${hero.heroIndex}: ${command}`);
        continue;
      }
      // Always issued, even if unchanged: the LLM's latest order wins when it arrives (D15).
      this.engine.issueCommand(hero, command, 'llm');
      decision.orders.push(`hero ${hero.heroIndex}: ${String(raw.command)}${raw.sector ? ' ' + String(raw.sector) : ''}${raw.target_hero ? ' ' + String(raw.target_hero) : ''}`);
    }
  }

  // Returns a command, or a reason why the order cannot be used.
  private toCommand(hero: IHero, raw: RawOrder): HeroCommand | string {
    switch (raw.command) {
      case 'move': {
        const center = typeof raw.sector === 'string' ? sectorCenter(raw.sector) : null;
        return center ? { type: 'move', target: center } : `invalid sector ${String(raw.sector)}`;
      }
      case 'hold':
        return { type: 'hold', at: { x: Math.floor(hero.position.x), y: Math.floor(hero.position.y) } };
      case 'retreat':
        return { type: 'retreat' };
      case 'attack':
        return { type: 'attack' };
      case 'attack_hero': {
        const index = Number(raw.target_hero);
        const alive = this.stateManager.getHeroes().some((h) => h.faction !== hero.faction && h.heroIndex === index && h.hp > 0);
        return alive ? { type: 'attackHero', heroIndex: index } : `enemy hero ${String(raw.target_hero)} does not exist or is dead`;
      }
      default:
        return `unknown command ${String(raw.command)}`;
    }
  }

  private fail(reason: string, hint: string): void {
    this.failed = true;
    if (this.opts.fallbackToRules) for (const hero of this.myHeroes()) hero.controller = 'rule';
    const what = this.opts.fallbackToRules ? 'enemy heroes switched to rule-based control' : 'strategic layer stopped';
    console.warn(`LLM unavailable (${reason}); ${what}. ${hint}`);
  }

  // The whole battlefield as the LLM sees it (Q4): heroes of both sides, army totals,
  // where the soldiers are by sector, and the terrain of each sector.
  private report(time: number): Record<string, unknown> {
    const units = this.stateManager.getBattlefield().units;
    const mine = (f: Faction) => f === this.faction;
    const perSector = new Map<string, { yours: number; enemy: number }>();
    const totals = { yours: 0, enemy: 0, yoursFleeing: 0, enemyFleeing: 0, yoursCourage: 0, enemyCourage: 0 };

    for (const u of units) {
      if (u.hp <= 0 || u.unitType === UnitType.HERO) continue;
      const s = positionToSector(u.position);
      const cell = perSector.get(s) ?? { yours: 0, enemy: 0 };
      const fleeing = u.state === BehaviorState.FLEE ? 1 : 0;
      if (mine(u.faction)) {
        cell.yours++;
        totals.yours++;
        totals.yoursFleeing += fleeing;
        totals.yoursCourage += u.courage;
      } else {
        cell.enemy++;
        totals.enemy++;
        totals.enemyFleeing += fleeing;
        totals.enemyCourage += u.courage;
      }
      perSector.set(s, cell);
    }

    const heroInfo = (h: IHero) => ({
      hero: h.heroIndex,
      sector: positionToSector(h.position),
      hp_percent: Math.round((100 * h.hp) / h.maxHp),
      status: this.status(h),
    });

    return {
      time_seconds: Math.round(time),
      your_side: this.faction === Faction.FRIENDLY ? 'west' : 'east',
      your_heroes: this.stateManager
        .getHeroes()
        .filter((h) => mine(h.faction) && h.hp > 0)
        .map((h) => ({
          ...heroInfo(h),
          current_order: h.command ? `${this.describe(h.command)} (from ${h.commandSource})` : 'none',
          recent_tactical_decisions: this.opts.recentTactical(h.heroIndex),
        })),
      enemy_heroes: this.stateManager.getHeroes().filter((h) => !mine(h.faction) && h.hp > 0).map(heroInfo),
      armies: {
        your_soldiers: totals.yours,
        your_soldiers_fleeing: totals.yoursFleeing,
        your_average_courage: totals.yours ? Math.round(totals.yoursCourage / totals.yours) : 0,
        enemy_soldiers: totals.enemy,
        enemy_soldiers_fleeing: totals.enemyFleeing,
        enemy_average_courage: totals.enemy ? Math.round(totals.enemyCourage / totals.enemy) : 0,
      },
      soldiers_by_sector: [...perSector.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([sector, c]) => ({ sector, yours: c.yours, enemy: c.enemy })),
      terrain_by_sector: this.terrainMap(),
    };
  }

  // Dominant terrain per sector, one row per grid row (north first), columns A-J.
  private terrainMap(): Record<string, unknown> {
    const grid = this.stateManager.getBattlefield().grid;
    const rows: string[] = [];
    for (let r = 0; r < SECTORS_PER_SIDE; r++) {
      let line = '';
      for (let c = 0; c < SECTORS_PER_SIDE; c++) {
        const counts = [0, 0, 0, 0];
        for (let y = r * SECTOR_SIZE; y < (r + 1) * SECTOR_SIZE; y++) {
          for (let x = c * SECTOR_SIZE; x < (c + 1) * SECTOR_SIZE; x++) counts[grid[y][x]]++;
        }
        // A sector counts as mountainous when a third of it is impassable.
        if (counts[TerrainType.MOUNTAIN] > (SECTOR_SIZE * SECTOR_SIZE) / 3) line += 'M';
        else {
          const top = [TerrainType.OPEN, TerrainType.FOREST, TerrainType.SWAMP].reduce((a, b) => (counts[b] > counts[a] ? b : a));
          line += top === TerrainType.FOREST ? 'f' : top === TerrainType.SWAMP ? 's' : '.';
        }
      }
      rows.push(`${r + 1}`.padStart(2) + ' ' + line);
    }
    return { legend: 'columns A-J west to east; . open, f forest, s swamp, M mostly mountains', rows };
  }

  private status(h: IHero): string {
    switch (h.state) {
      case BehaviorState.ATTACK: return 'fighting';
      case BehaviorState.FLEE: return 'retreating';
      case BehaviorState.REST: return 'resting';
      default: return h.path.length > 0 ? 'moving' : 'standing';
    }
  }

  private describe(c: HeroCommand): string {
    switch (c.type) {
      case 'move': return `move to ${positionToSector(c.target)}`;
      case 'hold': return `hold in ${positionToSector(c.at)}`;
      case 'retreat': return 'retreat';
      case 'attack': return 'attack nearest enemy';
      case 'attackHero': return `attack enemy hero ${c.heroIndex}`;
      case 'continueLlm': return 'follow strategic order';
    }
  }
}
