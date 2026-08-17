export type SnapshotSource = 'google-sheet' | 'xlsx' | 'csv';

export interface WorkOrder {
  number: string;
  inductionDate: string | null;
  edd: string | null;
  partNumber: string;
  description: string;
  serialNumber: string;
  customerRo: string;
  status: string;
  step: string;
  customer: string;
  shop: string;
  totalPrice: number | null;
  daysInStep: number | null;
  daysInShop: number | null;
  quotedDate: string | null;
  approvedDate: string | null;
  salesPerson: string;
  closedDate: string | null;
  tags: string;
}

export interface DataQuality {
  inputRows: number;
  acceptedRows: number;
  rejectedRows: number;
  duplicateWorkOrders: number;
  missingInductionDate: number;
  missingEdd: number;
  missingPrice: number;
  warnings: string[];
}

export interface SnapshotMeta {
  id: string;
  capturedAt: string;
  sourceType: SnapshotSource;
  sourceName: string;
  sourceHash: string;
  rowCount: number;
  maxInductionDate: string | null;
  dataQuality: DataQuality;
  createdAt?: string;
}

export type EventType =
  | 'NEW_WORK'
  | 'HISTORICAL_BACKFILL'
  | 'REAPPEARED'
  | 'STEP_CHANGED'
  | 'STATUS_CHANGED'
  | 'CLOSED'
  | 'EDD_CHANGED'
  | 'PRICE_CHANGED'
  | 'TAGS_CHANGED'
  | 'INDUCTION_DATE_CONFLICT';

export interface LifecycleEvent {
  workOrderNumber: string;
  eventType: EventType;
  eventAt: string;
  fromValue: unknown;
  toValue: unknown;
}

export interface ParsedSnapshot {
  capturedAt: string;
  sourceType: SnapshotSource;
  sourceName: string;
  sourceHash: string;
  rows: WorkOrder[];
  quality: DataQuality;
}

export interface CycleBaseline {
  key: string;
  sampleSize: number;
  medianDays: number;
  p80Days: number;
}

export interface ForecastRow {
  number: string;
  customer: string;
  shop: string;
  partNumber: string;
  status: string;
  step: string;
  daysInShop: number;
  predictedCompletion: string;
  likelyBy: string;
  remainingDays: number;
  confidence: 'high' | 'medium' | 'low';
  basis: string;
  sampleSize: number;
}

export interface DashboardAnalytics {
  asOf: string;
  snapshot: SnapshotMeta;
  previousSnapshot: SnapshotMeta | null;
  kpis: {
    visibleWorkOrders: number;
    activeWorkOrders: number;
    activeValue: number;
    overdueEdd: number;
    missingEdd: number;
    olderThan30Days: number;
    olderThan60Days: number;
    olderThan90Days: number;
    medianCompletedCycle: number | null;
    p80CompletedCycle: number | null;
    newSincePrevious: number;
    stepChangesSincePrevious: number;
    closuresSincePrevious: number;
  };
  shops: Array<{
    shop: string;
    activeCount: number;
    activeValue: number;
    medianActiveAge: number;
    overdue: number;
    completedSample: number;
    medianCycle: number | null;
    p80Cycle: number | null;
  }>;
  bottlenecks: Array<{
    shop: string;
    step: string;
    activeCount: number;
    medianDaysInStep: number;
    p80DaysInStep: number;
    overdue: number;
    delayedCount: number;
    severity: number;
  }>;
  partBottlenecks: Array<{
    partNumber: string;
    shop: string;
    activeCount: number;
    medianActiveAge: number;
    completedSample: number;
    medianCycle: number | null;
    p80Cycle: number | null;
  }>;
  customerTrends: Array<{
    customer: string;
    recent90: number;
    prior90: number;
    change: number;
    changePct: number | null;
    signal: 'tapering' | 'growing' | 'steady';
    topChangedLane: string | null;
  }>;
  forecasts: ForecastRow[];
  events: LifecycleEvent[];
  quality: DataQuality;
}
