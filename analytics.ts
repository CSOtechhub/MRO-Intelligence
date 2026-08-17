import type {
  CycleBaseline,
  DashboardAnalytics,
  ForecastRow,
  LifecycleEvent,
  SnapshotMeta,
  WorkOrder,
} from './types.js';

const ACTIVE_STATUSES = new Set(['OPEN', 'APPROVED', 'QUOTED']);
const TERMINAL_STATUSES = new Set(['CLOSED', 'INVOICED']);
const DAY_MS = 86_400_000;

export function isActive(row: WorkOrder): boolean {
  return ACTIVE_STATUSES.has(row.status);
}

function parseDay(value: string): number {
  return new Date(`${value.slice(0, 10)}T12:00:00Z`).getTime();
}

export function daysBetween(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const value = Math.round((parseDay(end) - parseDay(start)) / DAY_MS);
  return Number.isFinite(value) ? value : null;
}

function addDays(day: string, days: number): string {
  return new Date(parseDay(day) + Math.max(0, Math.round(days)) * DAY_MS).toISOString().slice(0, 10);
}

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function roundedPercentile(values: number[], p: number): number {
  return Math.round(percentile(values, p) * 10) / 10;
}

function cycleDays(row: WorkOrder): number | null {
  if (!TERMINAL_STATUSES.has(row.status) && !row.closedDate) return null;
  const value = daysBetween(row.inductionDate, row.closedDate);
  return value !== null && value >= 0 && value < 2000 ? value : null;
}

function activeAge(row: WorkOrder, asOf: string): number {
  const computed = daysBetween(row.inductionDate, asOf);
  if (computed !== null && computed >= 0) return computed;
  return Math.max(0, row.daysInShop ?? 0);
}

function baseline(key: string, values: number[]): CycleBaseline {
  return {key, sampleSize: values.length, medianDays: roundedPercentile(values, 0.5), p80Days: roundedPercentile(values, 0.8)};
}

function buildBaselines(rows: WorkOrder[]): Map<string, CycleBaseline> {
  const groups = new Map<string, number[]>();
  const add = (key: string, value: number) => groups.set(key, [...(groups.get(key) ?? []), value]);
  for (const row of rows) {
    const days = cycleDays(row);
    if (days === null) continue;
    if (row.partNumber && row.shop) add(`part-shop:${row.partNumber}|${row.shop}`, days);
    if (row.partNumber) add(`part:${row.partNumber}`, days);
    if (row.shop) add(`shop:${row.shop}`, days);
    add('global', days);
  }
  return new Map([...groups.entries()].map(([key, values]) => [key, baseline(key, values)]));
}

function chooseBaseline(row: WorkOrder, baselines: Map<string, CycleBaseline>): CycleBaseline {
  const choices = [
    row.partNumber && row.shop ? baselines.get(`part-shop:${row.partNumber}|${row.shop}`) : undefined,
    row.partNumber ? baselines.get(`part:${row.partNumber}`) : undefined,
    row.shop ? baselines.get(`shop:${row.shop}`) : undefined,
    baselines.get('global'),
  ];
  return choices.find((choice) => choice && choice.sampleSize >= 8)
    ?? choices.find((choice) => choice && choice.sampleSize >= 3)
    ?? {key: 'insufficient-history', sampleSize: 0, medianDays: 90, p80Days: 120};
}

function confidence(sampleSize: number): ForecastRow['confidence'] {
  if (sampleSize >= 30) return 'high';
  if (sampleSize >= 8) return 'medium';
  return 'low';
}

function forecastRows(rows: WorkOrder[], asOf: string, baselines: Map<string, CycleBaseline>): ForecastRow[] {
  return rows.filter(isActive).map((row) => {
    const age = activeAge(row, asOf);
    const selected = chooseBaseline(row, baselines);
    const remaining = Math.max(0, Math.round(selected.medianDays - age));
    const remainingP80 = Math.max(remaining, Math.round(selected.p80Days - age));
    return {
      number: row.number,
      customer: row.customer || 'Unassigned',
      shop: row.shop || 'Unassigned',
      partNumber: row.partNumber || 'Unknown',
      status: row.status || 'UNKNOWN',
      step: row.step || 'Unknown',
      daysInShop: age,
      predictedCompletion: addDays(asOf, remaining),
      likelyBy: addDays(asOf, remainingP80),
      remainingDays: remaining,
      confidence: confidence(selected.sampleSize),
      basis: selected.key,
      sampleSize: selected.sampleSize,
    };
  }).sort((a, b) => b.daysInShop - a.daysInShop);
}

function shopRows(rows: WorkOrder[], asOf: string) {
  const shops = new Map<string, WorkOrder[]>();
  for (const row of rows) {
    const name = row.shop || 'Unassigned';
    shops.set(name, [...(shops.get(name) ?? []), row]);
  }
  return [...shops.entries()].map(([shop, shopWork]) => {
    const active = shopWork.filter(isActive);
    const ages = active.map((row) => activeAge(row, asOf));
    const cycles = shopWork.map(cycleDays).filter((value): value is number => value !== null);
    return {
      shop,
      activeCount: active.length,
      activeValue: active.reduce((sum, row) => sum + (row.totalPrice ?? 0), 0),
      medianActiveAge: roundedPercentile(ages, 0.5),
      overdue: active.filter((row) => row.edd && row.edd < asOf).length,
      completedSample: cycles.length,
      medianCycle: cycles.length ? roundedPercentile(cycles, 0.5) : null,
      p80Cycle: cycles.length ? roundedPercentile(cycles, 0.8) : null,
    };
  }).filter((row) => row.activeCount > 0 || row.completedSample > 0)
    .sort((a, b) => b.activeCount - a.activeCount);
}

function bottleneckRows(rows: WorkOrder[], asOf: string) {
  const groups = new Map<string, WorkOrder[]>();
  for (const row of rows.filter(isActive)) {
    const key = `${row.shop || 'Unassigned'}\u0000${row.step || 'Unknown'}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()].map(([key, work]) => {
    const [shop, step] = key.split('\u0000');
    const days = work.map((row) => Math.max(0, row.daysInStep ?? activeAge(row, asOf)));
    const medianDaysInStep = roundedPercentile(days, 0.5);
    const p80DaysInStep = roundedPercentile(days, 0.8);
    const delayedCount = days.filter((value) => value >= Math.max(14, p80DaysInStep)).length;
    const overdue = work.filter((row) => row.edd && row.edd < asOf).length;
    const severity = Math.round((work.length * 0.45 + medianDaysInStep * 0.35 + overdue * 2 + delayedCount) * 10) / 10;
    return {shop, step, activeCount: work.length, medianDaysInStep, p80DaysInStep, overdue, delayedCount, severity};
  }).sort((a, b) => b.severity - a.severity).slice(0, 15);
}

function partBottleneckRows(rows: WorkOrder[], asOf: string) {
  const groups = new Map<string, WorkOrder[]>();
  for (const row of rows) {
    if (!row.partNumber) continue;
    const key = `${row.partNumber}\u0000${row.shop || 'Unassigned'}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()].map(([key, work]) => {
    const [partNumber, shop] = key.split('\u0000');
    const active = work.filter(isActive);
    const cycles = work.map(cycleDays).filter((value): value is number => value !== null);
    return {
      partNumber,
      shop,
      activeCount: active.length,
      medianActiveAge: roundedPercentile(active.map((row) => activeAge(row, asOf)), 0.5),
      completedSample: cycles.length,
      medianCycle: cycles.length ? roundedPercentile(cycles, 0.5) : null,
      p80Cycle: cycles.length ? roundedPercentile(cycles, 0.8) : null,
    };
  }).filter((row) => row.activeCount >= 3)
    .sort((a, b) => (b.activeCount * (b.medianActiveAge + 10)) - (a.activeCount * (a.medianActiveAge + 10)))
    .slice(0, 15);
}

function customerTrendRows(rows: WorkOrder[], asOf: string) {
  const asOfMs = parseDay(asOf);
  const recentStart = asOfMs - 89 * DAY_MS;
  const priorStart = asOfMs - 179 * DAY_MS;
  const customers = new Map<string, {recent: WorkOrder[]; prior: WorkOrder[]}>();
  for (const row of rows) {
    if (!row.customer || !row.inductionDate) continue;
    const inducted = parseDay(row.inductionDate);
    const entry = customers.get(row.customer) ?? {recent: [], prior: []};
    if (inducted >= recentStart && inducted <= asOfMs) entry.recent.push(row);
    else if (inducted >= priorStart && inducted < recentStart) entry.prior.push(row);
    customers.set(row.customer, entry);
  }
  return [...customers.entries()].map(([customer, periods]) => {
    const recent90 = periods.recent.length;
    const prior90 = periods.prior.length;
    const change = recent90 - prior90;
    const changePct = prior90 ? Math.round((change / prior90) * 1000) / 10 : null;
    const signal: 'tapering' | 'growing' | 'steady' = prior90 >= 5 && recent90 <= prior90 * 0.55 ? 'tapering'
      : recent90 >= 5 && recent90 >= Math.max(prior90 * 1.45, prior90 + 5) ? 'growing'
      : 'steady';
    const laneCounts = (items: WorkOrder[]) => {
      const counts = new Map<string, number>();
      for (const row of items) {
        const lane = `${row.shop || 'Unassigned'} / ${row.partNumber || 'Unknown P/N'}`;
        counts.set(lane, (counts.get(lane) ?? 0) + 1);
      }
      return counts;
    };
    const priorLanes = laneCounts(periods.prior);
    const recentLanes = laneCounts(periods.recent);
    const topChangedLane = [...priorLanes.entries()]
      .map(([lane, count]) => ({lane, decline: count - (recentLanes.get(lane) ?? 0)}))
      .sort((a, b) => b.decline - a.decline)[0];
    return {customer, recent90, prior90, change, changePct, signal, topChangedLane: topChangedLane?.decline > 0 ? topChangedLane.lane : null};
  }).filter((row) => row.recent90 + row.prior90 >= 5)
    .sort((a, b) => {
      if (a.signal === 'tapering' && b.signal !== 'tapering') return -1;
      if (b.signal === 'tapering' && a.signal !== 'tapering') return 1;
      return a.change - b.change;
    }).slice(0, 30);
}

export function buildAnalytics(
  snapshot: SnapshotMeta,
  previousSnapshot: SnapshotMeta | null,
  rows: WorkOrder[],
  events: LifecycleEvent[],
): DashboardAnalytics {
  const asOf = snapshot.capturedAt.slice(0, 10);
  const active = rows.filter(isActive);
  const completedCycles = rows.map(cycleDays).filter((value): value is number => value !== null);
  const baselines = buildBaselines(rows);
  return {
    asOf,
    snapshot,
    previousSnapshot,
    kpis: {
      visibleWorkOrders: rows.length,
      activeWorkOrders: active.length,
      activeValue: active.reduce((sum, row) => sum + (row.totalPrice ?? 0), 0),
      overdueEdd: active.filter((row) => row.edd && row.edd < asOf).length,
      missingEdd: active.filter((row) => !row.edd).length,
      olderThan30Days: active.filter((row) => activeAge(row, asOf) > 30).length,
      olderThan60Days: active.filter((row) => activeAge(row, asOf) > 60).length,
      olderThan90Days: active.filter((row) => activeAge(row, asOf) > 90).length,
      medianCompletedCycle: completedCycles.length ? roundedPercentile(completedCycles, 0.5) : null,
      p80CompletedCycle: completedCycles.length ? roundedPercentile(completedCycles, 0.8) : null,
      newSincePrevious: events.filter((event) => event.eventType === 'NEW_WORK').length,
      stepChangesSincePrevious: events.filter((event) => event.eventType === 'STEP_CHANGED').length,
      closuresSincePrevious: events.filter((event) => event.eventType === 'CLOSED').length,
    },
    shops: shopRows(rows, asOf),
    bottlenecks: bottleneckRows(rows, asOf),
    partBottlenecks: partBottleneckRows(rows, asOf),
    customerTrends: customerTrendRows(rows, asOf),
    forecasts: forecastRows(rows, asOf, baselines).slice(0, 100),
    events: events.slice(0, 100),
    quality: snapshot.dataQuality,
  };
}

export function deterministicBrief(analytics: DashboardAnalytics): string {
  const tapering = analytics.customerTrends.filter((row) => row.signal === 'tapering').slice(0, 3);
  const bottleneck = analytics.bottlenecks[0];
  const parts = analytics.partBottlenecks.slice(0, 3);
  const lines = [
    `As of ${analytics.asOf}, ${analytics.kpis.activeWorkOrders.toLocaleString()} active work orders are visible with ${(analytics.kpis.activeValue).toLocaleString('en-US', {style: 'currency', currency: 'USD', maximumFractionDigits: 0})} in quoted price.`,
    `${analytics.kpis.olderThan60Days.toLocaleString()} active units are older than 60 days; ${analytics.kpis.overdueEdd.toLocaleString()} are past EDD and ${analytics.kpis.missingEdd.toLocaleString()} have no EDD.`,
  ];
  if (bottleneck) lines.push(`The highest current step-pressure signal is ${bottleneck.shop} / ${bottleneck.step}: ${bottleneck.activeCount} active units and ${bottleneck.medianDaysInStep} median days in step.`);
  if (parts.length) lines.push(`Parts requiring management attention include ${parts.map((row) => `${row.partNumber} (${row.activeCount} active, median age ${row.medianActiveAge}d)`).join('; ')}.`);
  if (tapering.length) lines.push(`Taper signals: ${tapering.map((row) => `${row.customer} ${row.prior90}→${row.recent90} inductions`).join('; ')}. These are signals for follow-up, not proof that an account was lost.`);
  lines.push(`Since the prior snapshot: ${analytics.kpis.newSincePrevious} new inductions, ${analytics.kpis.stepChangesSincePrevious} step changes, and ${analytics.kpis.closuresSincePrevious} closures were detected.`);
  return lines.join('\n\n');
}
