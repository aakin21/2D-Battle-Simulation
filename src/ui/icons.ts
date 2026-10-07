// Pixel icons for the top bar, drawn on an 8×8 grid ('#' = filled) and shown as SVG at 2x,
// so they match the pixel font and the theme art.

const ICONS = {
  play: [
    '.#......',
    '.##.....',
    '.###....',
    '.####...',
    '.####...',
    '.###....',
    '.##.....',
    '.#......',
  ],
  pause: [
    '........',
    '.##..##.',
    '.##..##.',
    '.##..##.',
    '.##..##.',
    '.##..##.',
    '.##..##.',
    '........',
  ],
  faster: [
    '........',
    '#...#...',
    '##..##..',
    '###.###.',
    '###.###.',
    '##..##..',
    '#...#...',
    '........',
  ],
  slower: [
    '........',
    '...#...#',
    '..##..##',
    '.###.###',
    '.###.###',
    '..##..##',
    '...#...#',
    '........',
  ],
  restart: [
    '..####..',
    '.#....#.',
    '#....###',
    '#.....#.',
    '#.......',
    '#......#',
    '.#....#.',
    '..####..',
  ],
  save: [
    '#######.',
    '#.####.#',
    '#.####.#',
    '#......#',
    '#.####.#',
    '#.#..#.#',
    '#.####.#',
    '########',
  ],
  help: [
    '..####..',
    '.#....#.',
    '......#.',
    '....##..',
    '...#....',
    '...#....',
    '........',
    '...#....',
  ],
  soundOn: [
    '...#....',
    '..##..#.',
    '####.#..',
    '####.#.#',
    '####.#.#',
    '####.#..',
    '..##..#.',
    '...#....',
  ],
  soundOff: [
    '...#....',
    '..##....',
    '####.#.#',
    '####..#.',
    '####..#.',
    '####.#.#',
    '..##....',
    '...#....',
  ],
} as const;

export type IconName = keyof typeof ICONS;

const cache = new Map<IconName, string>();

export function icon(name: IconName): string {
  let svg = cache.get(name);
  if (svg) return svg;
  const rects: string[] = [];
  ICONS[name].forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] === '#') rects.push(`<rect x="${x}" y="${y}" width="1" height="1"/>`);
    }
  });
  svg = `<svg viewBox="0 0 8 8" aria-hidden="true">${rects.join('')}</svg>`;
  cache.set(name, svg);
  return svg;
}
