import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SWING_SCALE, VERSION, confirmedPivots, evaluate, validateBars, reviewZigzag } from '../../tools/wave-tracker/scenarios.mjs';

// Fixed before reviewing outcomes. Each symbol gets equal selection treatment.
const development = ['sh600009', 'sz002304', 'sh600563', 'sz002142', 'sz000338', 'sh603195', 'sh000922', 'sh000906', 'sh000852', 'sh000905'];
const HOLDOUT_START = '2025-01-01';
const HORIZON = 20;
const [input, output, sample = 'development'] = process.argv.slice(2);
const heldout = ['sh600660', 'sz002179', 'sh600188', 'sz000568', 'sh000932', 'sh000933', 'sh000827'];
if (!['development', 'heldout'].includes(sample)) throw new Error('Unknown sample');
const symbols = sample === 'heldout' ? heldout : development;
if (!input || !output) throw new Error('Usage: node replay.mjs <daily-data-dir> <report.json>');

function legsKey(result) {
  return result.fixed.map(p => p.date).join('/');
}

function futureOutcome(rows, direction, floor, target) {
  const down = direction === 'down';
  for (const row of rows) {
    const invalid = down ? row[3] < floor : row[2] > floor;
    const passed = down ? row[4] >= target : row[4] <= target;
    if (passed && invalid) return 'sameBar';
    if (passed) return 'hit';
    if (invalid) return 'breach';
  }
  return 'pending';
}

function statList(rows) {
  return Object.fromEntries(['hit', 'breach', 'sameBar', 'pending', 'tooLate'].map(key => [key, rows.filter(row => row.outcome === key).length]));
}

async function replay(symbol) {
  const raw = await readFile(path.join(input, symbol + '.json'));
  const series = JSON.parse(raw);
  const bars = validateBars(series.bars);
  const full = confirmedPivots(bars, SWING_SCALE);
  const fullFine = confirmedPivots(bars, SWING_SCALE / 2);
  const signals = { simple: [], wave: [] };
  const seen = { simple: new Set(), wave: new Set() };
  const statuses = {};
  let replayDays = 0, candidates = 0, detected = 0, zigzagShapes = 0;
  for (let i = 60; i < bars.length; i++) {
    const [date, , , , close] = bars[i];
    if (date < HOLDOUT_START) continue;
    ++replayDays;
    const prefix = bars.slice(0, i + 1);
    const livePivots = confirmedPivots(prefix, SWING_SCALE);
    const known = full.filter(p => p.confirmed <= date);
    if (JSON.stringify(livePivots) !== JSON.stringify(known)) throw new Error(`${symbol} ${date} pivot changed with future data`);
    const fine = confirmedPivots(prefix, SWING_SCALE / 2);
    if (JSON.stringify(fine) !== JSON.stringify(fullFine.filter(p => p.confirmed <= date))) throw new Error(`${symbol} ${date} fine-scale pivot changed with future data`);
    for (const direction of ['down', 'up']) {
      const result = evaluate(prefix, { direction, pivots: livePivots });
      if (!result.fixed) continue;
      ++candidates;
      if (reviewZigzag(prefix, result, SWING_SCALE, fine)?.matches) ++zigzagShapes;
      const status = result.impulseStatus;
      statuses[status] = (statuses[status] || 0) + 1;
      if ((status === 'invalid') !== Boolean(result.invalid.length) ||
        (['five', 'truncated'].includes(status) && result.impulse.length !== 6) ||
        result.fixed.some(p => p.confirmed > date)) throw new Error(`${symbol} ${date} inconsistent wave state`);
      if (result.cRatio === null || result.cRatio <= 0 || !result.c || result.retest === null) continue;
      detected += 1;
      const down = direction === 'down';
      const [start, , b] = result.fixed;
      const sign = down ? 1 : -1;
      const reboundGate = result.c.price + 0.236 * (b.price - result.c.price);
      if ((down ? close < reboundGate : close > reboundGate) || i + HORIZON >= bars.length) continue;
      const key = `${direction}/${legsKey(result)}`;
      // Baseline: price reaches 23.6% of the last leg. The wave screen adds C/A >= 0.809.
      for (const [group, eligible] of [['simple', true], ['wave', result.cRatio >= 0.809]]) {
        if (!eligible || seen[group].has(key)) continue;
        seen[group].add(key);
        const episode = { date, direction, anchors: key, floor: result.c.price, target: result.retest,
          ratio: Number(result.cRatio.toFixed(4)), outcome: sign * (close - result.retest) >= 0 ? 'tooLate' :
            futureOutcome(bars.slice(i + 1, i + HORIZON + 1), direction, result.c.price, result.retest) };
        signals[group].push(episode);
      }
    }
  }
  return { symbol, name: series.name, basis: series.basis, from: bars[0][0], through: bars.at(-1)[0],
    sha256: createHash('sha256').update(raw).digest('hex'), replayDays, candidates, detected, zigzagShapes, statuses, signals,
    score: { simple: statList(signals.simple), wave: statList(signals.wave) } };
}

const assets = await Promise.all(symbols.map(replay));
const totals = { simple: statList(assets.flatMap(s => s.signals.simple)), wave: statList(assets.flatMap(s => s.signals.wave)) };
const report = { version: VERSION, sample, scale: SWING_SCALE, holdoutStart: HOLDOUT_START, horizon: HORIZON,
  outcome: '20交易日内先达到整段38.2%回补/回撤或先失守当时末端极值；同时触及与已达目标单列',
  verified: ['标准和细尺度的逐日前缀转折点均与截至当日的全序列转折点一致', '候选锚点的可知时间不晚于评估日', '失效与已确认五段状态不互相重叠'],
  totals, assets };
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ assets: assets.length, days: assets.reduce((sum, a) => sum + a.replayDays, 0),
  candidates: assets.reduce((sum, a) => sum + a.candidates, 0), zigzagShapes: assets.reduce((sum, a) => sum + a.zigzagShapes, 0), totals }, null, 2));
