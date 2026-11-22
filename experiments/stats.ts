// The few statistics the runner and the analysis use, written out so each can be checked.
// Every function takes the values as they are and gives null for an empty list.

export function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, v) => a + v, 0) / values.length : null;
}

// Sample standard deviation (n − 1); null below two values
export function sd(values: number[]): number | null {
  if (values.length < 2) return null;
  const m = mean(values)!;
  return Math.sqrt(values.reduce((a, v) => a + (v - m) ** 2, 0) / (values.length - 1));
}

const sorted = (values: number[]) => [...values].sort((a, b) => a - b);

// The middle value; the mean of the two middle values for an even count
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = sorted(values);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// 90th percentile by the nearest-rank method: the smallest value with at least 90% of the values
// at or below it (always one of the values)
export function p90(values: number[]): number | null {
  if (!values.length) return null;
  const s = sorted(values);
  return s[Math.ceil(0.9 * s.length) - 1];
}

export function maxOf(values: number[]): number | null {
  return values.length ? values.reduce((a, v) => (v > a ? v : a), -Infinity) : null;
}

export function minOf(values: number[]): number | null {
  return values.length ? values.reduce((a, v) => (v < a ? v : a), Infinity) : null;
}

// z for a two-sided 95% interval
export const Z95 = 1.959963984540054;

// Wilson score interval for a proportion of `successes` in `n` (Wilson 1927; Newcombe 1998
// method 3): [lower, upper], or null for n = 0
export function wilson(successes: number, n: number, z = Z95): [number, number] | null {
  if (n <= 0) return null;
  const p = successes / n;
  const z2 = z * z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

// Difference of two independent proportions p1 − p2 with Newcombe's hybrid score interval
// (Newcombe 1998, method 10), built from the two Wilson intervals
export function newcombe(
  s1: number,
  n1: number,
  s2: number,
  n2: number,
  z = Z95
): { diff: number; lower: number; upper: number } | null {
  const a = wilson(s1, n1, z);
  const b = wilson(s2, n2, z);
  if (!a || !b) return null;
  const p1 = s1 / n1;
  const p2 = s2 / n2;
  const diff = p1 - p2;
  return {
    diff,
    lower: diff - Math.sqrt((p1 - a[0]) ** 2 + (b[1] - p2) ** 2),
    upper: diff + Math.sqrt((a[1] - p1) ** 2 + (p2 - b[0]) ** 2),
  };
}
