export const valuationEncoding = 'columns-v1';
const dayMs = 86_400_000;
const scales = [100, 100, 100, 100, 10_000, 10_000];
const isoDay = day => new Date(day * dayMs).toISOString().slice(0, 10);

function packHistory(history) {
  const days = [];
  const columns = scales.map(() => []);
  const previous = scales.map(() => 0);
  let lastDay = 0;
  for (const point of history) {
    if (point.length !== scales.length + 1) return history;
    const day = Date.parse(point[0]) / dayMs;
    if (!Number.isInteger(day) || isoDay(day) !== point[0]) return history;
    days.push(day - lastDay);
    lastDay = day;
    for (let c = 0; c < scales.length; c++) {
      const value = point[c + 1];
      if (value === null) {
        columns[c].push(null);
        continue;
      }
      const encoded = Math.round(value * scales[c]);
      const delta = encoded - previous[c];
      if (!Number.isSafeInteger(encoded) || !Number.isSafeInteger(delta) || encoded / scales[c] !== value) return history;
      columns[c].push(delta);
      previous[c] = encoded;
    }
  }
  return { days, columns };
}

export function packValuations(payload) {
  return { ...payload, encoding: valuationEncoding, indices: payload.indices.map(row => ({
    ...row, history: packHistory(row.history),
  })) };
}

export function unpackValuations(payload) {
  if (!payload.encoding) return payload;
  if (payload.encoding !== valuationEncoding) throw Error('估值数据格式不兼容');
  const dates = new Map();
  const indices = payload.indices.map(row => {
    if (Array.isArray(row.history)) return row;
    const { days, columns } = row.history;
    if (!Array.isArray(days) || columns?.length !== scales.length ||
      !columns.every(column => Array.isArray(column) && column.length === days.length)) throw Error('估值历史不完整');
    const previous = scales.map(() => 0);
    let day = 0;
    const history = days.map((step, i) => {
      day += step;
      if (!dates.has(day)) dates.set(day, isoDay(day));
      const point = [dates.get(day)];
      for (let c = 0; c < scales.length; c++) {
        const delta = columns[c][i];
        if (delta === null) point.push(null);
        else {
          previous[c] += delta;
          point.push(previous[c] / scales[c]);
        }
      }
      return point;
    });
    return { ...row, history };
  });
  const { encoding, ...rest } = payload;
  return { ...rest, indices };
}
