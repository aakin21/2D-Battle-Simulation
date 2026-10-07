import { Faction } from '../types/types';
import towersUrl from '../assets/terrain/TilesetTowers.png';
import flagWestUrl from '../assets/terrain/FlagWest.png';
import flagEastUrl from '../assets/terrain/FlagEast.png';
import flagNeutralUrl from '../assets/terrain/FlagNeutral.png';

// Sprites for the battle objectives (D30), from the Ninja Adventure pack (CC0): a waving flag
// on each control point in the colour of the side holding it, and a tower for each base that
// shows damage as its HP drops. Animation runs on simulation time, so it stops on pause.

const FLAG = 16; // flag frames are 16×16, 4 frames in a row
const FLAG_FRAMES = 4;
const FLAG_FPS = 6;
const TOWER = 32; // towers are 32×32: intact, damaged, ruined side by side
// Tower row in the sheet by Faction: west the orange wooden tower, east the grey stone tower
const TOWER_ROW = [0, 1];

function loadImage(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = url;
  return img.decode().then(() => img);
}

export class ObjectiveArt {
  private towers: HTMLImageElement | null = null;
  private flags: HTMLImageElement[] = []; // west, east, neutral

  async load(): Promise<void> {
    const [towers, west, east, neutral] = await Promise.all(
      [towersUrl, flagWestUrl, flagEastUrl, flagNeutralUrl].map(loadImage)
    );
    this.towers = towers;
    this.flags = [west, east, neutral];
  }

  isReady(): boolean {
    return this.towers !== null;
  }

  // Flag whose pole stands at (x, y) on screen; size is the drawn frame size in pixels.
  drawFlag(
    ctx: CanvasRenderingContext2D,
    holder: Faction | null,
    x: number,
    y: number,
    size: number,
    simTime: number
  ): void {
    const img = this.flags[holder === null ? 2 : holder];
    const frame = Math.floor(simTime * FLAG_FPS) % FLAG_FRAMES;
    // The pole is near the left edge of the frame and ends at its bottom
    ctx.drawImage(img, frame * FLAG, 0, FLAG, FLAG, x - size * 0.25, y - size, size, size);
  }

  // Tower centred on (x, y); hpRatio picks the intact, damaged or ruined picture.
  drawTower(
    ctx: CanvasRenderingContext2D,
    faction: Faction,
    hpRatio: number,
    x: number,
    y: number,
    size: number
  ): void {
    const col = hpRatio <= 0 ? 2 : hpRatio <= 0.5 ? 1 : 0;
    ctx.drawImage(
      this.towers!,
      col * TOWER,
      TOWER_ROW[faction] * TOWER,
      TOWER,
      TOWER,
      x - size / 2,
      y - size / 2,
      size,
      size
    );
  }
}
