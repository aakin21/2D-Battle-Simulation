export type ClickCallback = (canvasX: number, canvasY: number) => void;
export type DragCallback = (dx: number, dy: number) => void;
export type ScrollCallback = (delta: number, canvasX: number, canvasY: number) => void;
export type KeyCallback = (key: string) => void;
export type HoverCallback = (canvasX: number, canvasY: number) => void;
export type SelectDragCallback = (x1: number, y1: number, x2: number, y2: number) => void;

// Keys whose default browser behavior should be suppressed
const HANDLED_KEYS = new Set([' ', '+', '=', '-', 'r', 'R']);

export class InputHandler {
  private canvas: HTMLCanvasElement;

  private clickCallbacks: ClickCallback[] = [];
  private rightClickCallbacks: ClickCallback[] = [];
  private dragCallbacks: DragCallback[] = [];
  private scrollCallbacks: ScrollCallback[] = [];
  private keyCallbacks: KeyCallback[] = [];
  private hoverCallbacks: HoverCallback[] = [];
  private leaveCallbacks: Array<() => void> = [];
  private selectDragCallbacks: SelectDragCallback[] = [];
  private selectDragEndCallbacks: SelectDragCallback[] = [];

  private zoomChecker: (() => boolean) | null = null;

  // Unified mouse state to correctly separate clicks from drags
  private mouse = {
    down: false,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    dragged: false,
    selectMode: false, // true = selection drag, false = pan drag
  };

  constructor(canvasId: string) {
    this.canvas = document.getElementById(canvasId) as HTMLCanvasElement;
    this.setupMouseListeners();
    this.setupScrollListener();
    this.setupKeyListener();
  }

  onLeftClick(cb: ClickCallback): void { this.clickCallbacks.push(cb); }
  onRightClick(cb: ClickCallback): void { this.rightClickCallbacks.push(cb); }
  onDrag(cb: DragCallback): void { this.dragCallbacks.push(cb); }
  onScroll(cb: ScrollCallback): void { this.scrollCallbacks.push(cb); }
  onKeyDown(cb: KeyCallback): void { this.keyCallbacks.push(cb); }
  onHover(cb: HoverCallback): void { this.hoverCallbacks.push(cb); }
  onCanvasLeave(cb: () => void): void { this.leaveCallbacks.push(cb); }
  onSelectDrag(cb: SelectDragCallback): void { this.selectDragCallbacks.push(cb); }
  onSelectDragEnd(cb: SelectDragCallback): void { this.selectDragEndCallbacks.push(cb); }
  setZoomChecker(fn: () => boolean): void { this.zoomChecker = fn; }

  private rect(): DOMRect {
    return this.canvas.getBoundingClientRect();
  }

  private setupMouseListeners(): void {
    this.canvas.addEventListener('mousedown', (e: MouseEvent) => {
      if (e.button !== 0) return;
      const r = this.rect();
      this.mouse.down = true;
      this.mouse.dragged = false;
      this.mouse.selectMode = false;
      this.mouse.startX = this.mouse.lastX = e.clientX - r.left;
      this.mouse.startY = this.mouse.lastY = e.clientY - r.top;
    });

    this.canvas.addEventListener('mousemove', (e: MouseEvent) => {
      const r = this.rect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;

      if (!this.mouse.down) {
        this.hoverCallbacks.forEach((cb) => cb(x, y));
        return;
      }

      const dx = x - this.mouse.lastX;
      const dy = y - this.mouse.lastY;

      const totalDx = x - this.mouse.startX;
      const totalDy = y - this.mouse.startY;
      if (!this.mouse.dragged && (Math.abs(totalDx) > 4 || Math.abs(totalDy) > 4)) {
        this.mouse.dragged = true;
        // When zoomed in, always pan. At min zoom: regular drag = select, shift+drag = pan.
        const zoomed = this.zoomChecker?.() ?? false;
        this.mouse.selectMode = !zoomed && !e.shiftKey;
        this.canvas.style.cursor = this.mouse.selectMode ? 'crosshair' : 'grabbing';
      }

      if (this.mouse.dragged) {
        if (this.mouse.selectMode) {
          this.selectDragCallbacks.forEach((cb) =>
            cb(this.mouse.startX, this.mouse.startY, x, y)
          );
        } else {
          this.dragCallbacks.forEach((cb) => cb(dx, dy));
        }
      }

      this.mouse.lastX = x;
      this.mouse.lastY = y;
    });

    this.canvas.addEventListener('mouseup', (e: MouseEvent) => {
      if (e.button !== 0) return;
      const r = this.rect();
      if (!this.mouse.dragged) {
        this.clickCallbacks.forEach((cb) => cb(e.clientX - r.left, e.clientY - r.top));
      } else if (this.mouse.selectMode) {
        const endX = e.clientX - r.left;
        const endY = e.clientY - r.top;
        this.selectDragEndCallbacks.forEach((cb) =>
          cb(this.mouse.startX, this.mouse.startY, endX, endY)
        );
      }
      this.mouse.down = false;
      this.mouse.dragged = false;
      this.mouse.selectMode = false;
      this.canvas.style.cursor = 'crosshair';
    });

    this.canvas.addEventListener('mouseleave', () => {
      this.mouse.down = false;
      this.mouse.dragged = false;
      this.mouse.selectMode = false;
      this.canvas.style.cursor = 'crosshair';
      this.leaveCallbacks.forEach((cb) => cb());
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
