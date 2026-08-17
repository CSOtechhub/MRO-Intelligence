import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseCsv} from './normalize.js';

test('normalizes aliases, dates, currency, and duplicate work orders', () => {
  const csv = [
    'WO #,Induction Date,P/N,Status,Total Price,Tag',
    '1001,8/12/2026,PN-A,Open,"$1,250.50",priority',
    '1001,8/12/2026,PN-A,Approved,"$1,500.00",priority',
    ',8/12/2026,PN-B,Open,$10.00,',
  ].join('\n');
  const parsed = parseCsv(csv, 'Work Orders - 2026-08-12.csv');
  assert.equal(parsed.capturedAt.slice(0, 10), '2026-08-12');
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].number, '1001');
  assert.equal(parsed.rows[0].status, 'APPROVED');
  assert.equal(parsed.rows[0].inductionDate, '2026-08-12');
  assert.equal(parsed.rows[0].totalPrice, 1500);
  assert.equal(parsed.quality.duplicateWorkOrders, 1);
  assert.equal(parsed.quality.rejectedRows, 1);
});
