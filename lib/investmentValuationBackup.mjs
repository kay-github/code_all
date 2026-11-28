const trialDay = '2026-11-30';
const mainlandCodes = [
  '000985', '000001', '000300', '399006', '000688', '399001', '000932', '399989',
];

const matchesPoint = (left, right) => left?.length === right.length && right.every((value, i) => left[i] === value);

export function advanceValuationBackup(previous, snapshot, audit, primaryDates, now) {
  const verified = new Map(snapshot.indices.map(row => [row.code, row]));
  const candidates = audit?.candidates ?? {};
  let state = previous;

  if (!state?.enabledAt) {
    const existingLeads = state?.leads ?? {};
    let leads = existingLeads;
    for (const code of mainlandCodes) {
      const primary = verified.get(code);
      const point = candidates[code]?.history.at(-1);
      if (!leads[code] && point?.[0] === trialDay && primary &&
        primaryDates[code] === primary.date && primary.date < trialDay) {
        leads = { ...leads, [code]: { point, observedAt: audit.checkedAt } };
      }
    }
    if (leads !== existingLeads) state = { ...state, leads };
    if (mainlandCodes.every(code => leads[code] &&
      matchesPoint(verified.get(code)?.history.findLast(([day]) => day === trialDay), leads[code].point))) {
      state = { ...state, leads, enabledAt: now.toISOString() };
    }
    return state;
  }

  const supplemental = { ...state.supplemental };
  let changed = false;
  for (const code of mainlandCodes) {
    const primary = verified.get(code);
    const existing = supplemental[code];
    const candidate = candidates[code];
    if (existing && existing.history.at(-1)[0] <= primary?.date) {
      delete supplemental[code];
      changed = true;
    }
    if (!candidate || !primary || candidate.history[0][0] <= primary.date) continue;
    if (existing && (existing.history.at(-1)[0] > candidate.history.at(-1)[0] ||
      (existing.close === candidate.close && existing.history.length === candidate.history.length &&
        candidate.history.every((point, i) => matchesPoint(existing.history[i], point))))) continue;
    supplemental[code] = candidate;
    changed = true;
  }
  return changed ? { ...state, supplemental } : state;
}

export function valuationBackupSummary(state, snapshot) {
  const leads = state?.leads ?? {};
  const confirmed = mainlandCodes.filter(code => leads[code] && matchesPoint(
    snapshot.indices.find(row => row.code === code)?.history.findLast(([day]) => day === trialDay), leads[code].point,
  ));
  return {
    trialDay, enabledAt: state?.enabledAt ?? null,
    observedAhead: Object.fromEntries(mainlandCodes.filter(code => leads[code]).map(code => [code, leads[code].observedAt])),
    confirmed, supplemental: mainlandCodes.filter(code => state?.supplemental?.[code]),
  };
}

export function applyValuationBackup(snapshot, state) {
  if (!state?.enabledAt) return snapshot;
  return { ...snapshot, indices: snapshot.indices.map(row => {
    if (!mainlandCodes.includes(row.code)) return row;
    const backup = state.supplemental?.[row.code];
    const last = backup?.history.at(-1);
    if (!last || last[0] <= row.date || !(last[0] <= snapshot.closeDates[row.code])) return row;
    const extra = backup.history.filter(([day]) => day > row.date);
    return { ...row, date: last[0], close: backup.close, pe: last[5], pb: last[6], history: row.history.concat(extra) };
  }) };
}
