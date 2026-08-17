import {createHash} from 'node:crypto';
import * as XLSX from 'xlsx';
import Papa from 'papaparse';
import type {DataQuality, ParsedSnapshot, SnapshotSource, WorkOrder} from './types.js';

type LooseRow = Record<string, unknown>;

const headerAliases: Record<keyof WorkOrder, string[]> = {
  number: ['Number', 'WO #', 'WO', 'Work Order', 'Work Order Number'],
  inductionDate: ['Date', 'Induction Date', 'Received Date'],
  edd: ['EDD', 'Estimated Delivery Date', 'Due Date'],
  partNumber: ['P/N', 'PN', 'Part Number'],
  description: ['Description', 'Part Description'],
  serialNumber: ['S/N', 'SN', 'Serial Number'],
  customerRo: ['Customer RO#', 'Customer RO', 'RO#'],
  status: ['Status'],
  step: ['Step', 'Current Step'],
  customer: ['Customer', 'Customer Name'],
  shop: ['Shop', 'Department', 'Dept'],
  totalPrice: ['Total Price', 'Price', 'Quoted Price'],
  daysInStep: ['Days in Step'],
  daysInShop: ['Days in Shop'],
  quotedDate: ['Quoted Date'],
  approvedDate: ['Approved Date'],
  salesPerson: ['Sales Person', 'Salesperson'],
  closedDate: ['Closed Date', 'Close Date'],
  tags: ['Tags', 'Tag'],
};

function canonicalHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function pick(row: LooseRow, aliases: string[]): unknown {
  const keys = new Map(Object.keys(row).map((key) => [canonicalHeader(key), key]));
  for (const alias of aliases) {
    const key = keys.get(canonicalHeader(alias));
    if (key !== undefined) return row[key];
  }
  return undefined;
}

function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function numberValue(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Number(String(value).replace(/[$,%\s,]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function dateValue(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
  }
  const raw = String(value).trim();
  if (!raw) return null;
  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  const us = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (us) {
    const year = us[3].length === 2 ? `20${us[3]}` : us[3];
    return `${year}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function normalizeStatus(value: unknown): string {
  return text(value).toUpperCase();
}

export function normalizeRow(row: LooseRow): WorkOrder | null {
  const number = text(pick(row, headerAliases.number));
  if (!number) return null;
  return {
    number,
    inductionDate: dateValue(pick(row, headerAliases.inductionDate)),
    edd: dateValue(pick(row, headerAliases.edd)),
    partNumber: text(pick(row, headerAliases.partNumber)),
    description: text(pick(row, headerAliases.description)),
    serialNumber: text(pick(row, headerAliases.serialNumber)),
    customerRo: text(pick(row, headerAliases.customerRo)),
    status: normalizeStatus(pick(row, headerAliases.status)),
    step: text(pick(row, headerAliases.step)),
    customer: text(pick(row, headerAliases.customer)),
    shop: text(pick(row, headerAliases.shop)),
    totalPrice: numberValue(pick(row, headerAliases.totalPrice)),
    daysInStep: numberValue(pick(row, headerAliases.daysInStep)),
    daysInShop: numberValue(pick(row, headerAliases.daysInShop)),
    quotedDate: dateValue(pick(row, headerAliases.quotedDate)),
    approvedDate: dateValue(pick(row, headerAliases.approvedDate)),
    salesPerson: text(pick(row, headerAliases.salesPerson)),
    closedDate: dateValue(pick(row, headerAliases.closedDate)),
    tags: text(pick(row, headerAliases.tags)),
  };
}

function inferredCapturedAt(name: string, fallback = new Date()): string {
  const match = name.match(/(20\d{2})[-_](\d{1,2})[-_](\d{1,2})/);
  if (!match) return fallback.toISOString();
  return new Date(`${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}T12:00:00.000Z`).toISOString();
}

function finish(rawRows: LooseRow[], sourceType: SnapshotSource, sourceName: string, content: Buffer | string): ParsedSnapshot {
  const byNumber = new Map<string, WorkOrder>();
  let rejectedRows = 0;
  let duplicateWorkOrders = 0;
  for (const rawRow of rawRows) {
    const row = normalizeRow(rawRow);
    if (!row) {
      rejectedRows += 1;
      continue;
    }
    if (byNumber.has(row.number)) duplicateWorkOrders += 1;
    byNumber.set(row.number, row);
  }
  const rows = [...byNumber.values()].sort((a, b) => a.number.localeCompare(b.number, undefined, {numeric: true}));
  const quality: DataQuality = {
    inputRows: rawRows.length,
    acceptedRows: rows.length,
    rejectedRows,
    duplicateWorkOrders,
    missingInductionDate: rows.filter((row) => !row.inductionDate).length,
    missingEdd: rows.filter((row) => !row.edd).length,
    missingPrice: rows.filter((row) => row.totalPrice === null).length,
    warnings: [],
  };
  if (duplicateWorkOrders) quality.warnings.push(`${duplicateWorkOrders} duplicate WO rows were collapsed using the last visible row.`);
  if (rejectedRows) quality.warnings.push(`${rejectedRows} rows without a WO number were rejected.`);
  if (!rows.length) quality.warnings.push('No valid work orders were found.');
  const sourceHash = createHash('sha256').update(content).digest('hex');
  return {
    capturedAt: inferredCapturedAt(sourceName),
    sourceType,
    sourceName,
    sourceHash,
    rows,
    quality,
  };
}

export function parseCsv(csv: string, sourceName: string): ParsedSnapshot {
  const result = Papa.parse<LooseRow>(csv, {header: true, skipEmptyLines: 'greedy', dynamicTyping: false});
  if (result.errors.length && !result.data.length) throw new Error(`CSV parsing failed: ${result.errors[0].message}`);
  const snapshot = finish(result.data, 'csv', sourceName, csv);
  if (result.errors.length) snapshot.quality.warnings.push(`${result.errors.length} non-fatal CSV parsing warnings occurred.`);
  return snapshot;
}

export function parseWorkbook(buffer: Buffer, sourceName: string): ParsedSnapshot {
  const workbook = XLSX.read(buffer, {type: 'buffer', cellDates: false});
  const firstSheet = workbook.SheetNames[0];
  if (!firstSheet) throw new Error('The workbook has no worksheets.');
  const rawRows = XLSX.utils.sheet_to_json<LooseRow>(workbook.Sheets[firstSheet], {defval: '', raw: false, dateNF: 'yyyy-mm-dd'});
  return finish(rawRows, 'xlsx', sourceName, buffer);
}

export function maxInductionDate(rows: WorkOrder[]): string | null {
  const values = rows.flatMap((row) => row.inductionDate ? [row.inductionDate] : []);
  return values.sort().at(-1) ?? null;
}
