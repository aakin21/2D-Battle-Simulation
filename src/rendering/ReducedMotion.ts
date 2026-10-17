// Looked up once (it is read per hero per frame); its matches follows the setting live
let reducedMotionQuery: MediaQueryList | null = null;

// Whether the user asked for less motion (prefers-reduced-motion): camera easing and marker
// motion are turned off
export function reducedMotion(): boolean {
  if (!reducedMotionQuery) {
    if (typeof matchMedia !== 'function') return false;
    reducedMotionQuery = matchMedia('(prefers-reduced-motion: reduce)');
  }
  return reducedMotionQuery.matches;
}
