// The analysis of a results folder: per condition (and per objective and map within it), wins,
// losses and draws with a 95% Wilson interval for the subject's win rate, casualties and match
// length, the AI layers' answer times, tokens and cost, side-swap balance, mirrored pairs,
// comparisons of conditions that share an opponent, and a check that every pairing has both
// side assignments and every seed. Writes report.md and CSV files into <folder>/analysis.
// Usage: npm run experiment:analyse -- <results folder> [--out <folder>]
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  answerTimes,
  ensureDir,
  matchRow,
  readMatchFiles,
  ROLES,
  toCsv,
  writeAtomic,
  type Json,
  type Row,
} from './results';
import { maxOf, mean, median, minOf, newcombe, p90, sd, wilson } from './stats';
import { sideText, type MatchDef, type SideSpec } from './plan';

type Def = Omit<MatchDef, 'mapGrid'>;

interface Match {
  row: Row;
  log: Json;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const nums = (rows: Row[], col: string) =>
  rows.map((r) => num(r[col])).filter((v): v is number => v !== null);
const r2 = (v: number | null, d = 2) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);
const pct = (v: number | null) => (v === null ? '–' : `${(100 * v).toFixed(1)}%`);
const fmt = (v: number | null, d = 1) => (v === null ? '–' : v.toFixed(d));
const spread = (values: number[], d = 1) =>
  values.length
    ? `${fmt(mean(values), d)} ± ${fmt(sd(values), d)} [${fmt(minOf(values), d)}–${fmt(maxOf(values), d)}]`
    : '–';

// Matches that have a result (a winner or a draw); not finished and errors are counted apart
const decided = (ms: Match[]) => ms.filter((m) => m.row.status === 'finished');

function outcomeRow(name: Record<string, string>, ms: Match[]): Row {
  const done = decided(ms);
  const rows = done.map((m) => m.row);
  const w = rows.filter((r) => r.subject_result === 'win').length;
  const l = rows.filter((r) => r.subject_result === 'loss').length;
  const dr = rows.filter((r) => r.subject_result === 'draw').length;
  const ci = wilson(w, done.length);
  const stopped = ms.filter((m) => ROLES.some((role) => m.row[`${role}_stopped`] === true)).length;
  return {
    ...name,
    matches: ms.length,
    decided: done.length,
    wins: w,
    losses: l,
    draws: dr,
    win_rate: r2(done.length ? w / done.length : null, 4),
    win_rate_ci95_low: r2(ci ? ci[0] : null, 4),
    win_rate_ci95_high: r2(ci ? ci[1] : null, 4),
    not_finished: ms.filter((m) => m.row.status === 'not finished').length,
    errors: ms.filter((m) => m.row.status === 'error').length,
    with_stopped_layer: stopped,
    subject_soldiers_lost_mean: r2(mean(nums(rows, 'subject_soldiers_lost'))),
    subject_soldiers_lost_sd: r2(sd(nums(rows, 'subject_soldiers_lost'))),
    opponent_soldiers_lost_mean: r2(mean(nums(rows, 'opponent_soldiers_lost'))),
    opponent_soldiers_lost_sd: r2(sd(nums(rows, 'opponent_soldiers_lost'))),
    subject_heroes_lost_mean: r2(mean(nums(rows, 'subject_heroes_lost'))),
    opponent_heroes_lost_mean: r2(mean(nums(rows, 'opponent_heroes_lost'))),
    game_seconds_mean: r2(mean(nums(rows, 'game_seconds'))),
    game_seconds_sd: r2(sd(nums(rows, 'game_seconds'))),
    game_seconds_min: r2(minOf(nums(rows, 'game_seconds'))),
    game_seconds_max: r2(maxOf(nums(rows, 'game_seconds'))),
  };
}

// The decided matches, a mirrored pair that is one battle (the same outcome hash: the same
// commander on both sides and no AI, e.g. rules vs rules) counted once
function battles(ms: Match[]): Row[] {
  const seen = new Set<string>();
  const out: Row[] = [];
  for (const { row } of decided(ms)) {
    const id = `${row.objective}|${row.map}|${row.seed}|${row.outcome_hash}`;
    if (row.outcome_hash !== null && seen.has(id)) continue;
    seen.add(id);
    out.push(row);
  }
  return out;
}

function sideRow(condition: string, ms: Match[]): Row {
  const rows = battles(ms);
  const west = rows.filter((r) => r.winner_side === 'west').length;
  const east = rows.filter((r) => r.winner_side === 'east').length;
  const ci = wilson(west, west + east);
  return {
    condition,
    battles: rows.length,
    west_wins: west,
    east_wins: east,
    draws: rows.filter((r) => r.winner_side === 'draw').length,
    west_share_of_decisive: r2(west + east ? west / (west + east) : null, 4),
    west_share_ci95_low: r2(ci ? ci[0] : null, 4),
    west_share_ci95_high: r2(ci ? ci[1] : null, 4),
  };
}

// Mirrored pairs (the same condition, objective, map and seed, the subject once West and once
// East): what the two results say together
function pairRow(condition: string, ms: Match[]): Row {
  const pairs = new Map<string, Row[]>();
  for (const m of ms) {
    const id = `${m.row.objective}|${m.row.map}|${m.row.seed}`;
    pairs.set(id, [...(pairs.get(id) ?? []), m.row]);
  }
  const count = { both: 0, none: 0, west: 0, east: 0, other: 0, incomplete: 0, identical: 0 };
  for (const rows of pairs.values()) {
    const w = rows.find((r) => r.subject_side === 'west');
    const e = rows.find((r) => r.subject_side === 'east');
    if (w && e && w.outcome_hash !== null && w.outcome_hash === e.outcome_hash) count.identical++;
    if (!w || !e || w.status !== 'finished' || e.status !== 'finished') count.incomplete++;
    else if (w.subject_result === 'win' && e.subject_result === 'win') count.both++;
    else if (w.subject_result === 'loss' && e.subject_result === 'loss') count.none++;
    else if (w.winner_side === 'west' && e.winner_side === 'west') count.west++;
    else if (w.winner_side === 'east' && e.winner_side === 'east') count.east++;
    else count.other++;
  }
  return {
    condition,
    pairs: pairs.size,
    subject_won_both: count.both,
    subject_lost_both: count.none,
    west_won_both: count.west,
    east_won_both: count.east,
    with_a_draw: count.other,
    incomplete: count.incomplete,
    // The two side assignments played the same battle (no AI, the same commander on both sides):
    // the subject's win rate is then 50% by construction, and the side balance counts it once
    identical: count.identical,
  };
}

function layerRows(condition: string, ms: Match[]): Row[] {
  const out: Row[] = [];
  for (const role of ROLES) {
    const present = ms.filter((m) => m.row[`${role}_requests`] !== null);
    if (!present.length) continue;
    const [who, kind] = role.split('_');
    const times: number[] = [];
    const game: number[] = [];
    for (const m of present) {
      const side =
        who === 'subject' ? m.row.subject_side : m.row.subject_side === 'west' ? 'east' : 'west';
      const ai = ((m.log.ai as Json)[String(side)] ?? {}) as Json;
      const layer = (kind === 'llm' ? ai.llm : ai.jev) as Json | undefined;
      if (layer) times.push(...answerTimes(layer));
      const seen = ((m.log.experiment as Json).requests ?? []) as Json[];
      for (const s of seen)
        if (s.layer === `${side}.${kind}` && num(s.arrivedAt) !== null && num(s.sentAt) !== null)
          game.push((s.arrivedAt as number) - (s.sentAt as number));
    }
    const rows = present.map((m) => m.row);
    const total = (col: string) => {
      const v = nums(rows, `${role}_${col}`);
      return v.length ? v.reduce((a, x) => a + x, 0) : null;
    };
    const cost = total('cost_usd');
    const models = [...new Set(rows.map((r) => r[`${role}_model`]).filter((v) => v !== null))];
    out.push({
      condition,
      role,
      models: models.join(' '),
      matches: present.length,
      requests: total('requests'),
      failed: total('failed'),
      skipped: total('skipped'),
      stopped_in_matches: rows.filter((r) => r[`${role}_stopped`] === true).length,
      answers: times.length,
      answer_ms_mean: r2(mean(times), 1),
      answer_ms_median: r2(median(times), 1),
      answer_ms_p90: r2(p90(times), 1),
      answer_ms_max: r2(maxOf(times), 1),
      game_latency_s_mean: r2(mean(game), 4),
      game_latency_s_max: r2(maxOf(game), 4),
      input_tokens: total('input_tokens'),
      output_tokens: total('output_tokens'),
      cache_read_tokens: total('cache_read_tokens'),
      cache_write_tokens: total('cache_write_tokens'),
      cost_usd: r2(cost, 6),
      cost_usd_per_match: r2(cost === null ? null : cost / present.length, 6),
    });
  }
  return out;
}

function mdTable(rows: Row[], columns: [string, string][]): string {
  if (!rows.length) return '_none_\n';
  const head = `| ${columns.map(([, h]) => h).join(' | ')} |`;
  const line = `|${columns.map(() => '---').join('|')}|`;
  const body = rows.map(
    (r) => `| ${columns.map(([c]) => String(r[c] ?? '–').replace(/\|/g, '\\|')).join(' | ')} |`
  );
  return [head, line, ...body].join('\n') + '\n';
}

export function analyse(dir: string, outDir = join(dir, 'analysis')): { report: string } {
  const runFile = join(dir, 'run.json');
  const run = existsSync(runFile) ? (JSON.parse(readFileSync(runFile, 'utf8')) as Json) : null;
  const expected = (run?.matches ?? null) as Def[] | null;
  const { files, unreadable } = readMatchFiles(dir);
  const wanted = expected ? new Set(expected.map((m) => `${m.key}.${m.hash}`)) : null;
  const order = new Map(expected?.map((m, i) => [`${m.key}.${m.hash}`, i]) ?? []);
  const used = files
    .filter((f) => !wanted || wanted.has(`${f.key}.${f.hash}`))
    .sort(
      (a, b) => (order.get(`${a.key}.${a.hash}`) ?? 0) - (order.get(`${b.key}.${b.hash}`) ?? 0)
    );
  const ignored = files.length - used.length;
  const matches: Match[] = used.map((f) => ({ row: matchRow(f.log), log: f.log }));
  const conditions = expected
    ? [...new Set(expected.map((m) => m.condition))]
    : [...new Set(matches.map((m) => String(m.row.condition)))];
  const of = (c: string) => matches.filter((m) => m.row.condition === c);

  const conditionRows = conditions.map((c) => outcomeRow({ condition: c }, of(c)));
  const cellRows: Row[] = [];
  for (const c of conditions) {
    const cells = new Map<string, Match[]>();
    for (const m of of(c)) {
      const id = `${m.row.objective}|${m.row.map}`;
      cells.set(id, [...(cells.get(id) ?? []), m]);
    }
    for (const [id, ms] of cells) {
      const [objective, map] = id.split('|');
      cellRows.push(outcomeRow({ condition: c, objective, map }, ms));
    }
  }
  const sideRows = conditions.map((c) => sideRow(c, of(c)));
  const pairRows = conditions.map((c) => pairRow(c, of(c)));
  const layers = conditions.flatMap((c) => layerRows(c, of(c)));

  // Conditions that play the same opponent: the difference of the subjects' win rates
  const opponentOf = new Map<string, string>();
  for (const m of expected ?? [])
    opponentOf.set(m.condition, sideText((m.subjectSide === 'west' ? m.east : m.west) as SideSpec));
  for (const m of matches)
    if (!opponentOf.has(String(m.row.condition)))
      opponentOf.set(
        String(m.row.condition),
        m.row.subject_side === 'west'
          ? `${m.row.east_commander}${m.row.east_model ? `:${m.row.east_model}` : ''}`
          : `${m.row.west_commander}${m.row.west_model ? `:${m.row.west_model}` : ''}`
      );
  const comparisonRows: Row[] = [];
  for (let i = 0; i < conditionRows.length; i++)
    for (let j = i + 1; j < conditionRows.length; j++) {
      const a = conditionRows[i];
      const b = conditionRows[j];
      if (opponentOf.get(String(a.condition)) !== opponentOf.get(String(b.condition))) continue;
      const diff = newcombe(Number(a.wins), Number(a.decided), Number(b.wins), Number(b.decided));
      comparisonRows.push({
        condition_a: a.condition,
        condition_b: b.condition,
        opponent: opponentOf.get(String(a.condition)) ?? null,
        win_rate_a: a.win_rate,
        win_rate_b: b.win_rate,
        difference: r2(diff ? diff.diff : null, 4),
        difference_ci95_low: r2(diff ? diff.lower : null, 4),
        difference_ci95_high: r2(diff ? diff.upper : null, 4),
      });
    }

  // Completeness: every pairing (condition, objective, map, seed) with every side assignment
  const have = new Set(used.map((f) => `${f.key}.${f.hash}`));
  const missingRows: Row[] = (expected ?? [])
    .filter((m) => !have.has(`${m.key}.${m.hash}`))
    .map((m) => ({
      key: m.key,
      condition: m.condition,
      objective: m.objective,
      map: m.map,
      seed: m.seed,
      subject_side: m.subjectSide,
    }));
  const seedsPlanned = new Set((expected ?? []).map((m) => m.seed)).size;

  ensureDir(outDir);
  const csv = (name: string, rows: Row[]) => writeAtomic(join(outDir, name), toCsv(rows));
  csv('conditions.csv', conditionRows);
  csv('cells.csv', cellRows);
  csv('sides.csv', sideRows);
  csv('pairs.csv', pairRows);
  csv('layers.csv', layers);
  csv('comparisons.csv', comparisonRows);
  writeAtomic(
    join(outDir, 'missing.csv'),
    toCsv(missingRows, ['key', 'condition', 'objective', 'map', 'seed', 'subject_side'])
  );

  const timings = [...new Set(matches.map((m) => m.row.timing))].join(', ') || '–';
  const versions = [...new Set(matches.map((m) => m.row.code_version))].join(', ') || '–';
  const lines: string[] = [];
  lines.push(`# Experiment analysis: ${String((run?.plan as Json | undefined)?.name ?? dir)}`);
  lines.push('');
  lines.push(
    `Plan hash ${String(run?.planHash ?? '–')}; ${expected ? expected.length : '?'} matches planned (${seedsPlanned} seeds), ${matches.length} with a file, ${missingRows.length} missing${ignored ? `, ${ignored} file(s) of matches not in this plan left out` : ''}${unreadable.length ? `, ${unreadable.length} unreadable` : ''}. AI timing: ${timings}. Code: ${versions}.`
  );
  lines.push('');
  lines.push(
    'Win rate: the subject\'s wins over the matches with a result (draws count as not won); 95% Wilson interval. Casualties: soldiers lost, mean ± SD [min–max]. A match whose AI layer stopped keeps its result (its heroes went on under the rules or the LLM alone) and is counted under "stopped layer".'
  );
  lines.push('');
  lines.push('## Conditions');
  lines.push('');
  lines.push(
    mdTable(
      conditionRows.map((r) => ({
        ...r,
        wr: `${pct(num(r.win_rate))} [${pct(num(r.win_rate_ci95_low))}, ${pct(num(r.win_rate_ci95_high))}]`,
        wld: `${r.wins} / ${r.losses} / ${r.draws}`,
        sl: spread(
          nums(
            decided(of(String(r.condition))).map((m) => m.row),
            'subject_soldiers_lost'
          )
        ),
        ol: spread(
          nums(
            decided(of(String(r.condition))).map((m) => m.row),
            'opponent_soldiers_lost'
          )
        ),
        len: spread(
          nums(
            decided(of(String(r.condition))).map((m) => m.row),
            'game_seconds'
          )
        ),
      })),
      [
        ['condition', 'Condition'],
        ['matches', 'Matches'],
        ['wld', 'W / L / D'],
        ['wr', 'Win rate [95% CI]'],
        ['sl', 'Subject soldiers lost'],
        ['ol', 'Opponent soldiers lost'],
        ['len', 'Length (s)'],
        ['not_finished', 'Not finished'],
        ['errors', 'Errors'],
        ['with_stopped_layer', 'Stopped layer'],
      ]
    )
  );
  if (cellRows.length > conditionRows.length) {
    lines.push('## Per objective and map');
    lines.push('');
    lines.push(
      mdTable(
        cellRows.map((r) => ({
          ...r,
          wr: `${pct(num(r.win_rate))} [${pct(num(r.win_rate_ci95_low))}, ${pct(num(r.win_rate_ci95_high))}]`,
          wld: `${r.wins} / ${r.losses} / ${r.draws}`,
        })),
        [
          ['condition', 'Condition'],
          ['objective', 'Objective'],
          ['map', 'Map'],
          ['matches', 'Matches'],
          ['wld', 'W / L / D'],
          ['wr', 'Win rate [95% CI]'],
          ['game_seconds_mean', 'Mean length (s)'],
        ]
      )
    );
  }
  lines.push('## Side balance');
  lines.push('');
  lines.push(
    "With the same seed and map, does West or East win more? West's share of the decisive battles (95% Wilson interval), and the mirrored pairs (the subject once West, once East): won both, lost both, or the same side won both (the side, not the commander, decided). Same battle: both side assignments played the identical battle (the same commander on both sides and no AI, e.g. rules vs rules); it is counted once here, and that condition's win rate is 50% by construction."
  );
  lines.push('');
  lines.push(
    mdTable(
      sideRows.map((r, i) => ({
        ...r,
        ...pairRows[i],
        share: `${pct(num(r.west_share_of_decisive))} [${pct(num(r.west_share_ci95_low))}, ${pct(num(r.west_share_ci95_high))}]`,
      })),
      [
        ['condition', 'Condition'],
        ['west_wins', 'West wins'],
        ['east_wins', 'East wins'],
        ['draws', 'Draws'],
        ['share', 'West share [95% CI]'],
        ['pairs', 'Pairs'],
        ['subject_won_both', 'Subject won both'],
        ['subject_lost_both', 'Subject lost both'],
        ['west_won_both', 'West won both'],
        ['east_won_both', 'East won both'],
        ['with_a_draw', 'With a draw'],
        ['incomplete', 'Incomplete'],
        ['identical', 'Same battle'],
      ]
    )
  );
  lines.push('## AI layers');
  lines.push('');
  lines.push(
    'Answer times over every answered request of the role (ms; p90 by nearest rank). Game latency: simulation seconds between a request and its answer (real-time timing; paused timing gives one step, 0.0167 s). Cost: as the answers reported it (an estimate at API prices for Claude through the Agent SDK; none for Jev, Snap or a local model).'
  );
  lines.push('');
  lines.push(
    mdTable(layers, [
      ['condition', 'Condition'],
      ['role', 'Role'],
      ['models', 'Model'],
      ['requests', 'Requests'],
      ['failed', 'Failed'],
      ['skipped', 'Skipped'],
      ['stopped_in_matches', 'Stopped in'],
      ['answer_ms_mean', 'Mean'],
      ['answer_ms_median', 'Median'],
      ['answer_ms_p90', 'p90'],
      ['answer_ms_max', 'Max'],
      ['game_latency_s_mean', 'Game latency (s)'],
      ['input_tokens', 'Input tokens'],
      ['cost_usd', 'Cost (USD)'],
      ['cost_usd_per_match', 'Per match'],
    ])
  );
  lines.push('## Conditions with the same opponent');
  lines.push('');
  lines.push(
    "Difference of the subjects' win rates (A − B) with Newcombe's hybrid score interval (95%). It treats the two conditions as independent samples; they share seeds and maps, which this interval does not use."
  );
  lines.push('');
  lines.push(
    mdTable(
      comparisonRows.map((r) => ({
        ...r,
        d: `${pct(num(r.difference))} [${pct(num(r.difference_ci95_low))}, ${pct(num(r.difference_ci95_high))}]`,
      })),
      [
        ['condition_a', 'A'],
        ['condition_b', 'B'],
        ['opponent', 'Opponent'],
        ['d', 'Difference [95% CI]'],
      ]
    )
  );
  lines.push('## Completeness');
  lines.push('');
  if (!expected)
    lines.push('No run.json in the folder: the plan is unknown, nothing can be missing.');
  else if (!missingRows.length)
    lines.push('Every pairing has both side assignments and every seed: nothing is missing.');
  else {
    lines.push(`${missingRows.length} planned match(es) have no file:`);
    lines.push('');
    for (const m of missingRows)
      lines.push(
        `- ${m.condition}, ${m.objective}, ${m.map}, seed ${m.seed}, subject ${m.subject_side}`
      );
  }
  lines.push('');
  lines.push(
    'Read with experiments/README.md: real-time matches are not reproducible (answer times vary), and LLMs of different providers are asked in different forms (D64, Q18).'
  );
  const report = lines.join('\n') + '\n';
  writeAtomic(join(outDir, 'report.md'), report);
  return { report };
}

function main(): number {
  const argv = process.argv.slice(2);
  let dir: string | undefined;
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') dir = undefined;
    else if (!dir) dir = argv[i];
  }
  if (!dir || (out !== undefined && !out)) {
    console.error('Usage: npm run experiment:analyse -- <results folder> [--out <folder>]');
    return 2;
  }
  const folder = resolve(dir);
  if (!existsSync(folder)) {
    console.error(`No such folder: ${folder}`);
    return 1;
  }
  const outDir = out ? resolve(out) : join(folder, 'analysis');
  analyse(folder, outDir);
  console.log(`Analysis written to ${outDir} (report.md and CSV files)`);
  return 0;
}

process.exit(main());
