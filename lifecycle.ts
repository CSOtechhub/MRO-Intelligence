import type {LifecycleEvent, WorkOrder} from './types.js';

export function deriveAdjacentEvents(previous: WorkOrder, current: WorkOrder, eventAt: string): LifecycleEvent[] {
  const events: LifecycleEvent[] = [];
  const add = (eventType: LifecycleEvent['eventType'], fromValue: unknown, toValue: unknown) => events.push({
    workOrderNumber: current.number, eventType, eventAt, fromValue, toValue,
  });
  if (previous.step !== current.step) add('STEP_CHANGED', previous.step, current.step);
  if (previous.status !== current.status) add('STATUS_CHANGED', previous.status, current.status);
  if (previous.edd !== current.edd) add('EDD_CHANGED', previous.edd, current.edd);
  if (previous.totalPrice !== current.totalPrice) add('PRICE_CHANGED', previous.totalPrice, current.totalPrice);
  if (previous.tags !== current.tags) add('TAGS_CHANGED', previous.tags, current.tags);
  const wasClosed = previous.status === 'CLOSED' || previous.status === 'INVOICED' || Boolean(previous.closedDate);
  const isClosed = current.status === 'CLOSED' || current.status === 'INVOICED' || Boolean(current.closedDate);
  if (!wasClosed && isClosed) add('CLOSED', {status: previous.status, closedDate: previous.closedDate}, {status: current.status, closedDate: current.closedDate});
  return events;
}

export function classifyFirstAppearance(inductionDate: string | null, previousMaxInductionDate: string | null): 'NEW_WORK' | 'HISTORICAL_BACKFILL' {
  return inductionDate && previousMaxInductionDate && inductionDate > previousMaxInductionDate
    ? 'NEW_WORK'
    : 'HISTORICAL_BACKFILL';
}
