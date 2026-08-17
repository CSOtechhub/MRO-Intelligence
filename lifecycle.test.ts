import assert from 'node:assert/strict';
import {test} from 'node:test';
import {classifyFirstAppearance, deriveAdjacentEvents} from './lifecycle.js';
import type {WorkOrder} from './types.js';

const base: WorkOrder = {
  number: '1001', inductionDate: '2026-01-01', edd: '2026-08-20', partNumber: 'PN-A', description: '', serialNumber: '',
  customerRo: '', status: 'OPEN', step: 'Teardown', customer: 'Acme', shop: 'Power Plant', totalPrice: 1000,
  daysInStep: 3, daysInShop: 20, quotedDate: null, approvedDate: null, salesPerson: '', closedDate: null, tags: '',
};

test('derives transitions only for a WO visible in both snapshots', () => {
  const current = {...base, status: 'CLOSED', step: 'Final Inspection', closedDate: '2026-08-17'};
  const events = deriveAdjacentEvents(base, current, '2026-08-17T12:00:00Z');
  assert.deepEqual(events.map((event) => event.eventType), ['STEP_CHANGED', 'STATUS_CHANGED', 'CLOSED']);
});

test('classifies old first appearances as backfill, not new work', () => {
  assert.equal(classifyFirstAppearance('2025-01-01', '2026-08-12'), 'HISTORICAL_BACKFILL');
  assert.equal(classifyFirstAppearance('2026-08-13', '2026-08-12'), 'NEW_WORK');
  assert.equal(classifyFirstAppearance(null, '2026-08-12'), 'HISTORICAL_BACKFILL');
});
