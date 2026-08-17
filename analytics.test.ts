import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildAnalytics} from './analytics.js';
import type {SnapshotMeta, WorkOrder} from './types.js';

function row(number: string, overrides: Partial<WorkOrder> = {}): WorkOrder {
  return {
    number, inductionDate: '2026-06-01', edd: '2026-08-10', partNumber: 'PN-A', description: '', serialNumber: '',
    customerRo: '', status: 'OPEN', step: 'Inspection', customer: 'Acme', shop: 'Accessories', totalPrice: 1000,
    daysInStep: 20, daysInShop: 77, quotedDate: null, approvedDate: null, salesPerson: '', closedDate: null, tags: '',
    ...overrides,
  };
}

const quality = {inputRows: 0, acceptedRows: 0, rejectedRows: 0, duplicateWorkOrders: 0, missingInductionDate: 0, missingEdd: 0, missingPrice: 0, warnings: []};
const snapshot: SnapshotMeta = {id: 'latest', capturedAt: '2026-08-17T23:59:59Z', sourceType: 'xlsx', sourceName: 'latest.xlsx', sourceHash: 'hash', rowCount: 0, maxInductionDate: '2026-08-17', dataQuality: quality};

test('builds cycle forecasts and customer taper signals from facts', () => {
  const completed = Array.from({length: 12}, (_, index) => row(`C${index}`, {
    status: 'CLOSED', inductionDate: `2026-0${index < 6 ? 1 : 2}-${String((index % 6) + 1).padStart(2, '0')}`,
    closedDate: `2026-04-${String(index + 1).padStart(2, '0')}`,
  }));
  const prior = Array.from({length: 10}, (_, index) => row(`P${index}`, {inductionDate: `2026-03-${String(index + 1).padStart(2, '0')}`, customer: 'Taper Co'}));
  const recent = Array.from({length: 2}, (_, index) => row(`R${index}`, {inductionDate: `2026-07-${String(index + 1).padStart(2, '0')}`, customer: 'Taper Co'}));
  const active = row('A1');
  const rows = [...completed, ...prior, ...recent, active];
  const analytics = buildAnalytics({...snapshot, rowCount: rows.length, dataQuality: {...quality, inputRows: rows.length, acceptedRows: rows.length}}, null, rows, []);
  assert.equal(analytics.kpis.activeWorkOrders, 13);
  assert.ok(analytics.forecasts.some((forecast) => forecast.number === 'A1'));
  assert.equal(analytics.customerTrends.find((trend) => trend.customer === 'Taper Co')?.signal, 'tapering');
  assert.ok(analytics.bottlenecks.length > 0);
});
