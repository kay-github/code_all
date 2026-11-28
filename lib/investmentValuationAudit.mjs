const endpoint = 'https://www.etf.com.cn/api/etf-api-service/skill/v3/index/valuation/history';
const sampleSize = 5;
const rankFields = ['pETtm10Y', 'pBLf10Y', 'pETtmBgn', 'pBLfBgn'];
const multipleFields = ['pETtm', 'pBLf'];
const fields = [...rankFields, ...multipleFields];
const isRank = x => Number.isFinite(x) && x >= 0 && x <= 100;
const isMultiple = x => Number.isFinite(x) && x > 0;
const valuesFor = row => fields.map((field, i) => i < rankFields.length ? Math.round(row[field] * 100) / 100 : row[field]);

function recentAnchors(history) {
  const anchors = [];
  for (let i = history.length - 1; i >= 0 && anchors.length < sampleSize; i--) {
    const point = history[i];
    if (point.slice(1, 5).every(isRank) && isMultiple(point[5]) && isMultiple(point[6])) anchors.push(point);
  }
  return anchors.reverse();
}

function uniqueBy(rows, field) {
  const unique = new Map();
  for (const row of rows) {
    if (row?.[field]) unique.set(row[field], unique.has(row[field]) ? null : row);
  }
  return unique;
}

export async function auditIndexHubValuations(snapshot, key, fetcher = fetch) {
  const targets = snapshot.indices.filter(row => snapshot.closeDates[row.code] >= row.date).map(row => ({
    code: row.code,
    publishedDate: row.date,
    closeDate: snapshot.closeDates[row.code],
    anchors: recentAnchors(row.history),
  }));
  const days = targets.flatMap(row => row.anchors.map(point => point[0]));
  if (!days.length) return { status: 'no_reference_data' };
  const beginDate = days.sort()[0];
  const endDate = targets.map(row => row.closeDate).sort().at(-1);
  const url = new URL(endpoint);
  url.search = new URLSearchParams({ indexCodes: targets.map(row => row.code).join(','), beginDate, endDate });
  let payload;
  try {
    const response = await fetcher(url, {
      headers: { Authorization: 'Bearer ' + key, 'X-Caller-Type': 'external' },
      redirect: 'error',
      signal: AbortSignal.timeout(6_000),
    });
    if (!response.ok) return { status: 'http_error', httpStatus: response.status };
    payload = await response.json();
  } catch {
    return { status: 'request_failed' };
  }
  if (payload?.success === false) return { status: 'upstream_rejected' };
  if (payload?.success !== true || !Array.isArray(payload.data)) return { status: 'invalid_response' };

  const groups = uniqueBy(payload.data, 'trdCode');
  const candidates = {};
  const indices = targets.map(({ code, publishedDate, closeDate, anchors }) => {
    const group = groups.get(code);
    const items = group?.truncated !== true && Array.isArray(group?.items) ? group.items : [];
    const rows = uniqueBy(items.filter(row => /^\d{4}-\d{2}-\d{2}$/.test(row?.trdDt) &&
      row.trdDt >= beginDate && row.trdDt <= closeDate), 'trdDt');
    const complete = new Map([...rows].filter(([, row]) => row &&
      (!row.trdCode || row.trdCode === code) &&
      rankFields.every(field => isRank(row[field])) && multipleFields.every(field => isMultiple(row[field]))));
    const officialDate = [...complete.keys()].sort().at(-1) ?? null;
    let matchedDays = 0;
    let mismatch;
    for (const [day, ...values] of anchors) {
      const official = complete.get(day);
      if (!official) continue;
      const observed = valuesFor(official);
      const differences = fields.filter((_, i) => observed[i] !== values[i]);
      if (differences.length) mismatch = { day, fields: differences };
      else matchedDays++;
    }
    let status = 'behind';
    if (mismatch) status = 'mismatch';
    else if (matchedDays < sampleSize) status = 'insufficient_overlap';
    else if (officialDate === closeDate) status = officialDate > publishedDate ? 'ahead' : 'aligned';
    if (status === 'ahead') {
      const missing = snapshot.closeGaps?.[code]?.filter(([day]) => day > publishedDate) ?? [];
      if (missing.at(-1)?.[0] === closeDate && missing.every(([day]) => complete.has(day))) {
        candidates[code] = {
          close: missing.at(-1)[1],
          history: missing.map(([day]) => [day, ...valuesFor(complete.get(day))]),
        };
      }
    }
    return { code, closeDate, publishedDate, officialDate, matchedDays, status, ...(mismatch && { mismatch }) };
  });
  return { status: 'checked', checkedAt: new Date().toISOString(), indices, candidates };
}
