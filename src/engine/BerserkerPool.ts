import { IUnit, UnitType, Faction, BehaviorState, UNIT_STATS, Position } from '../types/types';

const POOL_SIZE = 900;
const S = UNIT_STATS.BERSERKER;

export class BerserkerPool {
  private available: IUnit[] = [];

  constructor() {
    this.fill();
  }

  acquire(id: string, x: number, y: number, groupId: string, path: Position[]): IUnit {
    const unit = this.available.pop() ?? this.make();
    unit.id = id;
    unit.position.x = x;
    unit.position.y = y;
    unit.hp = S.hp;
    unit.maxHp = S.hp;
    unit.courage = S.courage;
    unit.state = BehaviorState.IDLE;
    unit.path = path;
    unit.target = null;
    unit.attackCooldown = 0;
    unit.groupId = groupId;
    return unit;
  }

  release(unit: IUnit): void {
    this.available.push(unit);
  }

  reset(): void {
    this.available = [];
    this.fill();
  }

  private fill(): void {
    for (let i = 0; i < POOL_SIZE; i++) this.available.push(this.make());
  }

  private make(): IUnit {
    return {
      id: '',
      position: { x: 0, y: 0 },
      hp: 0,
      maxHp: 0,
      courage: 0,
      unitType: UnitType.BERSERKER,
      faction: Faction.ENEMY,
      state: BehaviorState.IDLE,
      sight: S.sight,
      baseSpeed: S.speed,
      damage: S.damage,
      path: [],
      target: null,
      attackCooldown: 0,
      groupId: '',
    };
  }
}
