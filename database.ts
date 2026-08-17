import {randomUUID} from 'node:crypto';
import pg, {type PoolClient} from 'pg';
import {classifyFirstAppearance, deriveAdjacentEvents} from './lifecycle.js';
import {maxInductionDate} from './normalize.js';
import type {LifecycleEvent, ParsedSnapshot, SnapshotMeta, WorkOrder} from './types.js';

const {Pool} = pg;

function poolConfig(): pg.PoolConfig {
  if (process.env.DATABASE_URL) {
    return {
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DB_SSL === 'true' ? {rejectUnauthorized: false} : undefined,
      max: Number(process.env.DB_POOL_MAX ?? 5),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    };
  }
  return {
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    host: process.env.INSTANCE_UNIX_SOCKET || process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 5432),
    max: Number(process.env.DB_POOL_MAX ?? 5),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  };
}

export const pool = new Pool(poolConfig());

const schema = `
CREATE TABLE IF NOT EXISTS snapshots (
  id text PRIMARY KEY,
  captured_at timestamptz NOT NULL,
  source_type text NOT NULL,
  source_name text NOT NULL,
  source_hash text NOT NULL,
  capture_day date GENERATED ALWAYS AS ((captured_at AT TIME ZONE 'UTC')::date) STORED,
  row_count integer NOT NULL,
  max_induction_date date,
  data_quality jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS work_orders (
  number text PRIMARY KEY,
  induction_date date,
  first_seen_snapshot text NOT NULL REFERENCES snapshots(id),
  last_seen_snapshot text NOT NULL REFERENCES snapshots(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS work_order_states (
  snapshot_id text NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  work_order_number text NOT NULL REFERENCES work_orders(number),
  induction_date date,
  edd date,
  part_number text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  serial_number text NOT NULL DEFAULT '',
  customer_ro text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT '',
  step text NOT NULL DEFAULT '',
  customer text NOT NULL DEFAULT '',
  shop text NOT NULL DEFAULT '',
  total_price numeric,
  days_in_step numeric,
  days_in_shop numeric,
  quoted_date date,
  approved_date date,
  sales_person text NOT NULL DEFAULT '',
  closed_date date,
  tags text NOT NULL DEFAULT '',
  PRIMARY KEY (snapshot_id, work_order_number)
);

CREATE TABLE IF NOT EXISTS lifecycle_events (
  id bigserial PRIMARY KEY,
  snapshot_id text NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  work_order_number text NOT NULL REFERENCES work_orders(number),
  event_type text NOT NULL,
  event_at timestamptz NOT NULL,
  from_value jsonb,
  to_value jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS executive_summaries (
  id bigserial PRIMARY KEY,
  snapshot_id text NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  cadence text NOT NULL,
  content text NOT NULL,
  model text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS snapshots_captured_at_idx ON snapshots(captured_at DESC);
ALTER TABLE snapshots DROP CONSTRAINT IF EXISTS snapshots_source_hash_key;
ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS capture_day date GENERATED ALWAYS AS ((captured_at AT TIME ZONE 'UTC')::date) STORED;
CREATE UNIQUE INDEX IF NOT EXISTS snapshots_hash_capture_day_idx ON snapshots(source_hash, capture_day);
CREATE INDEX IF NOT EXISTS states_work_order_idx ON work_order_states(work_order_number);
CREATE INDEX IF NOT EXISTS states_snapshot_status_idx ON work_order_states(snapshot_id, status);
CREATE INDEX IF NOT EXISTS events_snapshot_idx ON lifecycle_events(snapshot_id, id DESC);
CREATE INDEX IF NOT EXISTS events_work_order_idx ON lifecycle_events(work_order_number, event_at DESC);
CREATE INDEX IF NOT EXISTS summaries_snapshot_idx ON executive_summaries(snapshot_id, created_at DESC);
`;

export async function migrate(): Promise<void> {
  await pool.query(schema);
}

function snapshotFromDb(row: Record<string, unknown>): SnapshotMeta {
  return {
    id: String(row.id),
    capturedAt: new Date(String(row.captured_at)).toISOString(),
    sourceType: row.source_type as SnapshotMeta['sourceType'],
    sourceName: String(row.source_name),
    sourceHash: String(row.source_hash),
    rowCount: Number(row.row_count),
    maxInductionDate: row.max_induction_date ? String(row.max_induction_date).slice(0, 10) : null,
    dataQuality: row.data_quality as SnapshotMeta['dataQuality'],
    createdAt: row.created_at ? new Date(String(row.created_at)).toISOString() : undefined,
  };
}

function dateFromDb(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function workOrderFromDb(row: Record<string, unknown>): WorkOrder {
  return {
    number: String(row.work_order_number),
    inductionDate: dateFromDb(row.induction_date),
    edd: dateFromDb(row.edd),
    partNumber: String(row.part_number ?? ''),
    description: String(row.description ?? ''),
    serialNumber: String(row.serial_number ?? ''),
    customerRo: String(row.customer_ro ?? ''),
    status: String(row.status ?? ''),
    step: String(row.step ?? ''),
    customer: String(row.customer ?? ''),
    shop: String(row.shop ?? ''),
    totalPrice: row.total_price === null ? null : Number(row.total_price),
    daysInStep: row.days_in_step === null ? null : Number(row.days_in_step),
    daysInShop: row.days_in_shop === null ? null : Number(row.days_in_shop),
    quotedDate: dateFromDb(row.quoted_date),
    approvedDate: dateFromDb(row.approved_date),
    salesPerson: String(row.sales_person ?? ''),
    closedDate: dateFromDb(row.closed_date),
    tags: String(row.tags ?? ''),
  };
}

function eventFromDb(row: Record<string, unknown>): LifecycleEvent {
  return {
    workOrderNumber: String(row.work_order_number),
    eventType: row.event_type as LifecycleEvent['eventType'],
    eventAt: new Date(String(row.event_at)).toISOString(),
    fromValue: row.from_value,
    toValue: row.to_value,
  };
}

async function latestSnapshot(client: PoolClient | typeof pool = pool): Promise<SnapshotMeta | null> {
  const result = await client.query('SELECT * FROM snapshots ORDER BY captured_at DESC, created_at DESC LIMIT 1');
  return result.rows[0] ? snapshotFromDb(result.rows[0]) : null;
}

export async function listSnapshots(limit = 30): Promise<SnapshotMeta[]> {
  const result = await pool.query('SELECT * FROM snapshots ORDER BY captured_at DESC, created_at DESC LIMIT $1', [limit]);
  return result.rows.map(snapshotFromDb);
}

export async function getLatestSnapshot(): Promise<SnapshotMeta | null> {
  return latestSnapshot();
}

export async function getPreviousSnapshot(snapshotId: string): Promise<SnapshotMeta | null> {
  const result = await pool.query(
    `SELECT * FROM snapshots
     WHERE (captured_at, created_at) < (
       SELECT captured_at, created_at FROM snapshots WHERE id = $1
     )
     ORDER BY captured_at DESC, created_at DESC LIMIT 1`,
    [snapshotId],
  );
  return result.rows[0] ? snapshotFromDb(result.rows[0]) : null;
}

export async function getSnapshotRows(snapshotId: string, client: PoolClient | typeof pool = pool): Promise<WorkOrder[]> {
  const result = await client.query('SELECT * FROM work_order_states WHERE snapshot_id = $1', [snapshotId]);
  return result.rows.map(workOrderFromDb);
}

export async function getSnapshotEvents(snapshotId: string, limit = 500): Promise<LifecycleEvent[]> {
  const result = await pool.query(
    'SELECT * FROM lifecycle_events WHERE snapshot_id = $1 ORDER BY id DESC LIMIT $2',
    [snapshotId, limit],
  );
  return result.rows.map(eventFromDb);
}

async function insertStates(client: PoolClient, snapshotId: string, rows: WorkOrder[]): Promise<void> {
  const columns = 20;
  const chunkSize = 250;
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize);
    const values: unknown[] = [];
    const placeholders = chunk.map((row, rowIndex) => {
      const start = rowIndex * columns;
      values.push(
        snapshotId, row.number, row.inductionDate, row.edd, row.partNumber, row.description,
        row.serialNumber, row.customerRo, row.status, row.step, row.customer, row.shop,
        row.totalPrice, row.daysInStep, row.daysInShop, row.quotedDate, row.approvedDate,
        row.salesPerson, row.closedDate, row.tags,
      );
      return `(${Array.from({length: columns}, (_, index) => `$${start + index + 1}`).join(',')})`;
    });
    await client.query(
      `INSERT INTO work_order_states (
        snapshot_id, work_order_number, induction_date, edd, part_number, description,
        serial_number, customer_ro, status, step, customer, shop, total_price,
        days_in_step, days_in_shop, quoted_date, approved_date, sales_person, closed_date, tags
      ) VALUES ${placeholders.join(',')}`,
      values,
    );
  }
}

async function insertEvents(client: PoolClient, snapshotId: string, events: LifecycleEvent[]): Promise<void> {
  const columns = 6;
  const chunkSize = 500;
  for (let offset = 0; offset < events.length; offset += chunkSize) {
    const chunk = events.slice(offset, offset + chunkSize);
    const values: unknown[] = [];
    const placeholders = chunk.map((event, rowIndex) => {
      const start = rowIndex * columns;
      values.push(snapshotId, event.workOrderNumber, event.eventType, event.eventAt, JSON.stringify(event.fromValue), JSON.stringify(event.toValue));
      return `(${Array.from({length: columns}, (_, index) => `$${start + index + 1}`).join(',')})`;
    });
    await client.query(
      `INSERT INTO lifecycle_events (snapshot_id, work_order_number, event_type, event_at, from_value, to_value)
       VALUES ${placeholders.join(',')}`,
      values,
    );
  }
}

export async function ingestSnapshot(parsed: ParsedSnapshot): Promise<{snapshot: SnapshotMeta; events: LifecycleEvent[]; duplicate: boolean}> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const duplicateResult = await client.query(
      'SELECT * FROM snapshots WHERE source_hash = $1 AND capture_day = $2::date',
      [parsed.sourceHash, parsed.capturedAt.slice(0, 10)],
    );
    if (duplicateResult.rows[0]) {
      await client.query('ROLLBACK');
      return {snapshot: snapshotFromDb(duplicateResult.rows[0]), events: [], duplicate: true};
    }

    const previous = await latestSnapshot(client);
    if (previous && parsed.capturedAt.slice(0, 10) < previous.capturedAt.slice(0, 10)) {
      throw Object.assign(
        new Error(`Snapshot ${parsed.sourceName} is older than the latest stored snapshot (${previous.sourceName}). Load historical files oldest-to-newest before enabling the live sync.`),
        {status: 409},
      );
    }
    const previousRows = previous ? await getSnapshotRows(previous.id, client) : [];
    const previousMap = new Map(previousRows.map((row) => [row.number, row]));
    const knownResult = await client.query('SELECT number, induction_date FROM work_orders');
    const known = new Map<string, string | null>(knownResult.rows.map((row) => [String(row.number), dateFromDb(row.induction_date)]));
    const snapshotId = randomUUID();
    const rows = parsed.rows.map((row) => ({...row}));
    const events: LifecycleEvent[] = [];

    for (const row of rows) {
      const canonicalDate = known.get(row.number);
      if (known.has(row.number) && canonicalDate && row.inductionDate && canonicalDate !== row.inductionDate) {
        events.push({
          workOrderNumber: row.number,
          eventType: 'INDUCTION_DATE_CONFLICT',
          eventAt: parsed.capturedAt,
          fromValue: row.inductionDate,
          toValue: canonicalDate,
        });
        row.inductionDate = canonicalDate;
      }
      const prior = previousMap.get(row.number);
      if (prior) {
        events.push(...deriveAdjacentEvents(prior, row, parsed.capturedAt));
      } else if (previous) {
        if (known.has(row.number)) {
          events.push({workOrderNumber: row.number, eventType: 'REAPPEARED', eventAt: parsed.capturedAt, fromValue: null, toValue: {status: row.status, step: row.step}});
        } else {
          events.push({
            workOrderNumber: row.number,
            eventType: classifyFirstAppearance(row.inductionDate, previous.maxInductionDate),
            eventAt: parsed.capturedAt,
            fromValue: null,
            toValue: {inductionDate: row.inductionDate, status: row.status, step: row.step},
          });
        }
      }
    }

    const meta: SnapshotMeta = {
      id: snapshotId,
      capturedAt: parsed.capturedAt,
      sourceType: parsed.sourceType,
      sourceName: parsed.sourceName,
      sourceHash: parsed.sourceHash,
      rowCount: rows.length,
      maxInductionDate: maxInductionDate(rows),
      dataQuality: parsed.quality,
    };
    await client.query(
      `INSERT INTO snapshots (id, captured_at, source_type, source_name, source_hash, row_count, max_induction_date, data_quality)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [meta.id, meta.capturedAt, meta.sourceType, meta.sourceName, meta.sourceHash, meta.rowCount, meta.maxInductionDate, JSON.stringify(meta.dataQuality)],
    );

    for (let offset = 0; offset < rows.length; offset += 500) {
      const chunk = rows.slice(offset, offset + 500);
      const values: unknown[] = [];
      const placeholders = chunk.map((row, index) => {
        const start = index * 4;
        values.push(row.number, row.inductionDate, snapshotId, snapshotId);
        return `($${start + 1},$${start + 2},$${start + 3},$${start + 4})`;
      });
      await client.query(
        `INSERT INTO work_orders (number, induction_date, first_seen_snapshot, last_seen_snapshot)
         VALUES ${placeholders.join(',')}
         ON CONFLICT (number) DO UPDATE SET
           last_seen_snapshot = EXCLUDED.last_seen_snapshot,
           induction_date = COALESCE(work_orders.induction_date, EXCLUDED.induction_date),
           updated_at = now()`,
        values,
      );
    }
    await insertStates(client, snapshotId, rows);
    await insertEvents(client, snapshotId, events);
    await client.query('COMMIT');
    return {snapshot: meta, events, duplicate: false};
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getWorkOrderHistory(number: string) {
  const statesResult = await pool.query(
    `SELECT s.captured_at, s.source_name, ws.*
     FROM work_order_states ws JOIN snapshots s ON s.id = ws.snapshot_id
     WHERE ws.work_order_number = $1 ORDER BY s.captured_at ASC, s.created_at ASC`,
    [number],
  );
  const eventsResult = await pool.query(
    'SELECT * FROM lifecycle_events WHERE work_order_number = $1 ORDER BY event_at ASC, id ASC',
    [number],
  );
  return {
    number,
    states: statesResult.rows.map((row) => ({
      capturedAt: new Date(String(row.captured_at)).toISOString(),
      sourceName: String(row.source_name),
      workOrder: workOrderFromDb(row),
    })),
    events: eventsResult.rows.map(eventFromDb),
  };
}

export async function saveExecutiveSummary(snapshotId: string, cadence: string, content: string, model: string): Promise<void> {
  await pool.query(
    'INSERT INTO executive_summaries (snapshot_id, cadence, content, model) VALUES ($1,$2,$3,$4)',
    [snapshotId, cadence, content, model],
  );
}

export async function getLatestExecutiveSummary() {
  const result = await pool.query(
    `SELECT es.*, s.captured_at FROM executive_summaries es
     JOIN snapshots s ON s.id = es.snapshot_id ORDER BY es.created_at DESC LIMIT 1`,
  );
  if (!result.rows[0]) return null;
  const row = result.rows[0];
  return {
    snapshotId: String(row.snapshot_id),
    cadence: String(row.cadence),
    content: String(row.content),
    model: String(row.model),
    createdAt: new Date(String(row.created_at)).toISOString(),
    asOf: new Date(String(row.captured_at)).toISOString().slice(0, 10),
  };
}
