export type ClickCallback = (canvasX: number, canvasY: number) => void;
export type DragCallback = (dx: number, dy: number) => void;
export type ScrollCallback = (delta: number, canvasX: number, canvasY: number) => void;
export type KeyCallback = (key: string) => void;

// Keys whose default browser behavior should be suppressed
const HANDLED_KEYS = new Set([' ', '+', '=', '-', 'r', 'R']);

export class InputHandler {
  private canvas: HTMLCanvasElement;

  private clickCallbacks: ClickCallback[] = [];
  private rightClickCallbacks: ClickCallback[] = [];
  private dragCallbacks: DragCallback[] = [];
  private scrollCallbacks: ScrollCallback[] = [];
  private keyCallbacks: KeyCallback[] = [];

  // Unified mouse state to correctly separate clicks from drags
  private mouse = {
    down: false,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    dragged: false,
  };

  constructor(canvasId: string) {
    this.canvas = document.getElementById(canvasId) as HTMLCanvasElement;
    this.setupMouseListeners();
    this.setupScrollListener();
    this.setupKeyListener();
  }

  onLeftClick(cb: ClickCallback): void {
    this.clickCallbacks.push(cb);
  }
  onRightClick(cb: ClickCallback): void {
    this.rightClickCallbacks.push(cb);
  }
  onDrag(cb: DragCallback): void {
    this.dragCallbacks.push(cb);
  }
  onScroll(cb: ScrollCallback): void {
    this.scrollCallbacks.push(cb);
  }
  onKeyDown(cb: KeyCallback): void {
    this.keyCallbacks.push(cb);
  }

  private rect(): DOMRect {
    return this.canvas.getBoundingClientRect();
  }

  private setupMouseListeners(): void {
    this.canvas.addEventListener('mousedown', (e: MouseEvent) => {
      if (e.button !== 0) return;
      const r = this.rect();
      this.mouse.down = true;
      this.mouse.dragged = false;
      this.mouse.startX = this.mouse.lastX = e.clientX - r.left;
      this.mouse.startY = this.mouse.lastY = e.clientY - r.top;
    });

    this.canvas.addEventListener('mousemove', (e: MouseEvent) => {
      if (!this.mouse.down) return;
      const r = this.rect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      const dx = x - this.mouse.lastX;
      const dy = y - this.mouse.lastY;

      const totalDx = x - this.mouse.startX;
      const totalDy = y - this.mouse.startY;
      if (!this.mouse.dragged && (Math.abs(totalDx) > 4 || Math.abs(totalDy) > 4)) {
        this.mouse.dragged = true;
        this.canvas.style.cursor = 'grabbing';
      }

      if (this.mouse.dragged) {
        this.dragCallbacks.forEach((cb) => cb(dx, dy));
      }

      this.mouse.lastX = x;
      this.mouse.lastY = y;
    });

    this.canvas.addEventListener('mouseup', (e: MouseEvent) => {
      if (e.button !== 0) return;
      if (!this.mouse.dragged) {
        const r = this.rect();
        this.clickCallbacks.forEach((cb) => cb(e.clientX - r.left, e.clientY - r.top));
      }
      this.mouse.down = false;
      this.mouse.dragged = false;
      this.canvas.style.cursor = 'crosshair';
    });

    this.canvas.addEventListener('mouseleave', () => {
      this.mouse.down = false;
      this.mouse.dragged = false;
      this.canvas.style.cursor = 'crosshair';
    });

    this.canvas.addEventListener('contextmenu', (e: MouseEvent) => {
      e.preventDefault();
      const r = this.rect();
      this.rightClickCallbacks.forEach((cb) => cb(e.clientX - r.left, e.clientY - r.top));
    });
  }

  private setupScrollListener(): void {
    this.canvas.addEventListener(
      'wheel',
      (e: WheelEvent) => {
        e.preventDefault();
        const r = this.rect();
        this.scrollCallbacks.forEach((cb) => cb(-e.deltaY, e.clientX - r.left, e.clientY - r.top));
      },
      { passive: false }
    );
  }

  private setupKeyListener(): void {
    window.addEventListener('keydown', (e: KeyboardEvent) => {
      if (HANDLED_KEYS.has(e.key)) e.preventDefault();
      this.keyCallbacks.forEach((cb) => cb(e.key));
    });
  }
}
