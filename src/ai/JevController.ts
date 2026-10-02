import { SimulationEngine } from '../engine/SimulationEngine';
import { StateManager } from '../state/StateManager';
import { positionToSector, sectorCenter, SECTOR_SIZE } from '../engine/Sectors';
import {
  Faction,
  IHero,
  IUnit,
  HeroCommand,
  BehaviorState,
  TerrainType,
  UnitType,
  GRID_SIZE,
} from '../types/types';

// Layer 2 (D6): Jev makes tactical decisions for each hero of one side every few seconds.
// Jev only sees each hero's surroundings (D16) and picks one option per hero from a list
// we define (D20), so it can never return an invalid command.

export interface JevDecision {
  time: number; // simulation time when the request was sent
  heroIndex: number;
  choice: string;
  confidence: number;
  applied: boolean; // false when confidence was below the threshold
  latencyMs: number;
}

export interface JevOptions {
  intervalSec: number; // how often to ask (3–5 s, D1)
  minConfidence: number; // below this the hero keeps its current command
  fallbackToRules: boolean; // on failure, hand heroes to the rule layer (when Jev is the only AI layer)
  endpoint: string;
  fetchFn: typeof fetch;
}

const DEFAULTS: JevOptions = {
  intervalSec: 4,
  minConfidence: 0.4,
  fallbackToRules: true,
  endpoint: '/api/jev',
  fetchFn: (...args) => fetch(...args),
};

const VIEW_RADIUS = 15; // tiles around the hero that Jev gets to see
const MAP_CELL = 2; // local map: one character per 2×2 tiles
const DIRS = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'];

interface Option {
  key: string;
  description: string;
  command: HeroCommand | null; // null: keep the current command
}

export class JevController {
  private opts: JevOptions;
  private nextAt = 0;
  private pending = false;
  private failed = false;
  readonly decisions: JevDecision[] = [];
  skippedRequests = 0; // a new request was due while the previous one was still open (Q7)

  constructor(
    private engine: SimulationEngine,
    private stateManager: StateManager,
    private faction: Faction,
    opts: Partial<JevOptions> = {}
  ) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  isWaiting(): boolean {
    return this.pending;
  }

  // Called by the engine every simulation step.
  tick(elapsed: number): void {
    if (this.failed || elapsed < this.nextAt) return;
    this.nextAt = elapsed + this.opts.intervalSec;
    if (this.pending) {
      this.skippedRequests++;
      return;
    }
    void this.decide(elapsed);
  }

  // The last few applied decisions for one hero, oldest first (shown to the LLM, D15).
  recentFor(heroIndex: number, count = 3): string[] {
    return this.decisions
      .filter((d) => d.heroIndex === heroIndex && d.applied)
      .slice(-count)
      .map((d) => `t=${Math.round(d.time)}s ${d.choice}`);
  }

  private heroes(): IHero[] {
    return this.stateManager
      .getHeroes()
      .filter((h) => h.faction === this.faction && h.hp > 0 && h.controller === 'ai');
  }

  private async decide(time: number): Promise<void> {
    const heroes = this.heroes();
    if (heroes.length === 0) return;

    const options = new Map<number, Option[]>();
    const questions: Record<string, unknown> = {};
    const state: Record<string, unknown> = {
      side: this.faction === Faction.FRIENDLY ? 'west' : 'east',
      time_seconds: Math.round(time),
      sector_grid: `${GRID_SIZE / SECTOR_SIZE}x${GRID_SIZE / SECTOR_SIZE}, columns A-J west to east, rows 1-10 north to south`,
    };

    for (const hero of heroes) {
      const key = `hero${hero.heroIndex}`;
      const opts = this.optionsFor(hero);
      options.set(hero.heroIndex, opts);
      state[key] = this.describeHero(hero);
      questions[key] = {
        type: 'choice',
        instructions: {
          hero: key,
          question:
            `Choose the best tactical action for \`${key}\` right now, based on its surroundings. ` +
            'Soldiers near a hero follow it. Losing the hero costs its soldiers their courage bonus.',
        },
        criteria: Object.fromEntries(opts.map((o) => [o.key, o.description])),
      };
    }

    this.pending = true;
    const started = performance.now();
    try {
      const res = await this.opts.fetchFn(this.opts.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'jev-latest', state, questions }),
      });
      const latencyMs = performance.now() - started;

      if (!res.ok) {
        this.fail(`HTTP ${res.status}`, res.status === 401 || res.status === 403 ? 'Set TYPESAFE_API_KEY in .env.local and restart the dev server.' : '');
        return;
      }

      const body = (await res.json()) as {
        answers?: Record<string, { choice?: string; confidence?: number }>;
      };
      for (const hero of heroes) {
        const answer = body.answers?.[`hero${hero.heroIndex}`];
        const option = options.get(hero.heroIndex)?.find((o) => o.key === answer?.choice);
        if (!answer || !option || hero.hp <= 0) continue;

        const confidence = answer.confidence ?? 0;
        const applied = confidence >= this.opts.minConfidence;
        if (applied && option.command && !this.sameCommand(hero.command, option.command)) {
          this.engine.issueCommand(hero, option.command, 'jev');
        }
        this.decisions.push({ time, heroIndex: hero.heroIndex, choice: option.key, confidence, applied, latencyMs });
      }
    } catch (err) {
      this.fail(String(err), 'Is the dev server running (npm run dev)?');
    } finally {
      this.pending = false;
    }
  }

  // Jev is unavailable: stop asking. If no other AI layer commands these heroes, hand them
  // back to the rule layer so the game goes on.
  private fail(reason: string, hint: string): void {
    this.failed = true;
    if (this.opts.fallbackToRules) for (const hero of this.heroes()) hero.controller = 'rule';
    const what = this.opts.fallbackToRules ? 'enemy heroes switched to rule-based control' : 'tactical layer stopped';
    console.warn(`Jev unavailable (${reason}); ${what}. ${hint}`);
  }

  private sameCommand(a: HeroCommand | null, b: HeroCommand): boolean {
    if (!a || a.type !== b.type) return false;
    if (a.type === 'move' && b.type === 'move') return a.target.x === b.target.x && a.target.y === b.target.y;
    if (a.type === 'attackHero' && b.type === 'attackHero') return a.heroIndex === b.heroIndex;
    return true; // hold, retreat, attack, continueLlm: same type is the same order
  }

  // The options Jev can choose from for one hero (D20). Moves are limited to the hero's
  // own sector and its neighbours: Jev decides locally, the LLM plans map-wide moves.
  private optionsFor(hero: IHero): Option[] {
    const here = { x: Math.floor(hero.position.x), y: Math.floor(hero.position.y) };
    const opts: Option[] = [
      { key: 'hold', description: 'Stay here and defend this position', command: { type: 'hold', at: here } },
      { key: 'retreat', description: 'Fall back toward our own side, away from the enemy', command: { type: 'retreat' } },
      { key: 'attack', description: 'Advance on the nearest enemy', command: { type: 'attack' } },
    ];

    for (const enemy of this.stateManager.getHeroes()) {
      if (enemy.faction === hero.faction || enemy.hp <= 0) continue;
      opts.push({
        key: `attack_hero_${enemy.heroIndex}`,
        description: `Go after enemy hero ${enemy.heroIndex} (in sector ${positionToSector(enemy.position)})`,
        command: { type: 'attackHero', heroIndex: enemy.heroIndex },
      });
    }

    if (hero.lastLlmCommand) {
      opts.push({
        key: 'continue_llm',
        description: `Keep following the strategic order: ${this.describeCommand(hero.lastLlmCommand)}`,
        command: { type: 'continueLlm' },
      });
    }

    const col = Math.floor(hero.position.x / SECTOR_SIZE);
    const row = Math.floor(hero.position.y / SECTOR_SIZE);
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const c = col + dc;
        const r = row + dr;
        if (c < 0 || r < 0 || c >= GRID_SIZE / SECTOR_SIZE || r >= GRID_SIZE / SECTOR_SIZE) continue;
        const name = `${'ABCDEFGHIJ'[c]}${r + 1}`;
        const center = sectorCenter(name)!;
        const where = dr === 0 && dc === 0 ? 'the centre of its current sector' : `the sector to the ${DIRS[this.dirIndex(dc, dr)]}`;
        opts.push({ key: `move_${name}`, description: `Move to sector ${name} (${where})`, command: { type: 'move', target: center } });
      }
    }
    return opts;
  }

  // Everything Jev knows about one hero: its own status and what is around it (D16).
  private describeHero(hero: IHero): Record<string, unknown> {
    let allies = 0, enemies = 0, alliesFleeing = 0, enemiesFleeing = 0, allyCourage = 0;
    let nearest: IUnit | null = null;
    let nearestD = Infinity;
    const enemyHeroes: string[] = [];

    this.stateManager.forEachInRadius(hero.position.x, hero.position.y, VIEW_RADIUS, (u) => {
      if (u.hp <= 0 || u.id === hero.id) return;
      const d = Math.hypot(u.position.x - hero.position.x, u.position.y - hero.position.y);
      if (u.faction === hero.faction) {
        if (u.unitType === UnitType.HERO) return;
        allies++;
        allyCourage += u.courage;
        if (u.state === BehaviorState.FLEE) alliesFleeing++;
      } else {
        enemies++;
        if (u.state === BehaviorState.FLEE) enemiesFleeing++;
        if (u.unitType === UnitType.HERO) {
          enemyHeroes.push(`enemy hero ${(u as IHero).heroIndex}, ${Math.round(d)} tiles ${this.direction(hero, u)}, ${Math.round((100 * u.hp) / u.maxHp)}% hp`);
        }
        if (d < nearestD) {
          nearestD = d;
          nearest = u;
        }
      }
    });

    return {
      hp_percent: Math.round((100 * hero.hp) / hero.maxHp),
      status: this.heroStatus(hero),
      sector: positionToSector(hero.position),
      current_order: hero.command ? `${this.describeCommand(hero.command)} (from ${hero.commandSource})` : 'none',
      strategic_order: hero.lastLlmCommand ? this.describeCommand(hero.lastLlmCommand) : 'none',
      allies_nearby: allies,
      allies_fleeing: alliesFleeing,
      allies_average_courage: allies ? Math.round(allyCourage / allies) : 0,
      enemies_nearby: enemies,
      enemies_fleeing: enemiesFleeing,
      nearest_enemy: nearest ? `${Math.round(nearestD)} tiles ${this.direction(hero, nearest)}` : 'none in sight',
      enemy_heroes_nearby: enemyHeroes.length ? enemyHeroes : 'none',
      local_map: this.localMap(hero),
    };
  }

  // A small text map centred on the hero, north at the top. Each character is a 2×2 tile
  // area: H hero, e enemies, a allies, M mountain, f forest, s swamp, . open ground.
  private localMap(hero: IHero): Record<string, unknown> {
    const grid = this.stateManager.getBattlefield().grid;
    const half = Math.floor(VIEW_RADIUS / MAP_CELL);
    const hx = Math.floor(hero.position.x / MAP_CELL);
    const hy = Math.floor(hero.position.y / MAP_CELL);

    const marks = new Map<number, string>();
    this.stateManager.forEachInRadius(hero.position.x, hero.position.y, VIEW_RADIUS * 1.5, (u) => {
      if (u.hp <= 0) return;
      const k = Math.floor(u.position.y / MAP_CELL) * 1000 + Math.floor(u.position.x / MAP_CELL);
      if (u.faction !== hero.faction) marks.set(k, 'e');
      else if (!marks.has(k)) marks.set(k, 'a');
    });

    const rows: string[] = [];
    for (let cy = hy - half; cy <= hy + half; cy++) {
      let line = '';
      for (let cx = hx - half; cx <= hx + half; cx++) {
        if (cx === hx && cy === hy) { line += 'H'; continue; }
        const x = cx * MAP_CELL;
        const y = cy * MAP_CELL;
        if (x < 0 || y < 0 || x >= GRID_SIZE || y >= GRID_SIZE) { line += '#'; continue; }
        const mark = marks.get(cy * 1000 + cx);
        if (mark) { line += mark; continue; }
        const t = grid[y][x];
        line += t === TerrainType.MOUNTAIN ? 'M' : t === TerrainType.FOREST ? 'f' : t === TerrainType.SWAMP ? 's' : '.';
      }
      rows.push(line);
    }
    return {
      legend: 'H this hero, e enemy, a ally, M mountain (impassable), f forest (slow, less sight), s swamp (very slow), . open, # map edge; north is up',
      rows,
    };
  }

  private heroStatus(hero: IHero): string {
    switch (hero.state) {
      case BehaviorState.ATTACK: return 'fighting';
      case BehaviorState.FLEE: return 'retreating (survival reflex)';
      case BehaviorState.REST: return 'resting to heal';
      default: return hero.path.length > 0 ? 'moving' : 'standing';
    }
  }

  private describeCommand(c: HeroCommand): string {
    switch (c.type) {
      case 'move': return `move to sector ${positionToSector(c.target)}`;
      case 'hold': return `hold position in sector ${positionToSector(c.at)}`;
      case 'retreat': return 'retreat';
      case 'attack': return 'attack the nearest enemy';
      case 'attackHero': return `attack enemy hero ${c.heroIndex}`;
      case 'continueLlm': return 'follow the strategic order';
    }
  }

  private direction(from: IUnit, to: IUnit): string {
    const dx = to.position.x - from.position.x;
    const dy = to.position.y - from.position.y;
    const idx = Math.round(((Math.atan2(dy, dx) + 2 * Math.PI) % (2 * Math.PI)) / (Math.PI / 4)) % 8;
    return `to the ${DIRS[idx]}`;
  }

  private dirIndex(dc: number, dr: number): number {
    return Math.round(((Math.atan2(dr, dc) + 2 * Math.PI) % (2 * Math.PI)) / (Math.PI / 4)) % 8;
  }
}
