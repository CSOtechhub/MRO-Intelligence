import 'dotenv/config';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import express, {type NextFunction, type Request, type Response} from 'express';
import {buildAnalytics} from './analytics.js';
import {assertProductionSecurity, authStatus, login, logout, requireIngestAuthority, requireUser} from './auth.js';
import {
  getLatestExecutiveSummary,
  getLatestSnapshot,
  getPreviousSnapshot,
  getSnapshotEvents,
  getSnapshotRows,
  getWorkOrderHistory,
  ingestSnapshot,
  listSnapshots,
  migrate,
  pool,
  saveExecutiveSummary,
} from './database.js';
import {answerQuestion, geminiStatus, generateExecutiveSummary} from './gemini.js';
import {parseCsv, parseWorkbook} from './normalize.js';
import type {DashboardAnalytics, ParsedSnapshot} from './types.js';

const app = express();
const port = Number(process.env.PORT ?? 8080);
const currentFile = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(currentFile), '..');
const uploadParser = express.raw({type: ['application/octet-stream', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel', 'text/csv'], limit: '30mb'});
const chatUsage = new Map<string, {started: number; count: number}>();

app.disable('x-powered-by');
app.use(express.json({limit: '1mb'}));
app.use((_request, response, next) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'same-origin');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  next();
});

function asyncRoute(handler: (request: Request, response: Response, next: NextFunction) => Promise<void>) {
  return (request: Request, response: Response, next: NextFunction) => handler(request, response, next).catch(next);
}

async function loadAnalytics(): Promise<{analytics: DashboardAnalytics; rows: Awaited<ReturnType<typeof getSnapshotRows>>}> {
  const snapshot = await getLatestSnapshot();
  if (!snapshot) throw Object.assign(new Error('No snapshots have been ingested yet.'), {status: 404});
  const [previousSnapshot, rows, events] = await Promise.all([
    getPreviousSnapshot(snapshot.id),
    getSnapshotRows(snapshot.id),
    getSnapshotEvents(snapshot.id),
  ]);
  return {analytics: buildAnalytics(snapshot, previousSnapshot, rows, events), rows};
}

function applyCapturedAt(snapshot: ParsedSnapshot, header: string | undefined): ParsedSnapshot {
  if (!header) return snapshot;
  const parsed = new Date(header);
  if (Number.isNaN(parsed.getTime())) throw Object.assign(new Error('x-snapshot-date must be a valid date.'), {status: 400});
  return {...snapshot, capturedAt: parsed.toISOString()};
}

async function runIngest(snapshot: ParsedSnapshot, makeSummary: boolean) {
  if (!snapshot.rows.length) throw Object.assign(new Error('The source contained no valid work orders.'), {status: 400});
  const result = await ingestSnapshot(snapshot);
  let summary = null;
  let summaryWarning = null;
  if (!result.duplicate && makeSummary) {
    try {
      const {analytics} = await loadAnalytics();
      const generated = await generateExecutiveSummary(analytics, 'daily');
      await saveExecutiveSummary(result.snapshot.id, 'daily', generated.text, generated.model);
      summary = generated;
    } catch (error) {
      summaryWarning = error instanceof Error ? error.message : 'Executive summary generation failed.';
    }
  }
  return {...result, summary, summaryWarning};
}

app.get('/api/health', asyncRoute(async (_request, response) => {
  await pool.query('SELECT 1');
  response.json({ok: true, version: '2.0.0', gemini: geminiStatus()});
}));

app.get('/api/auth/status', (request, response) => response.json(authStatus(request)));
app.post('/api/auth/login', login);
app.post('/api/auth/logout', logout);

app.get('/api/snapshots', requireUser, asyncRoute(async (_request, response) => {
  response.json({snapshots: await listSnapshots()});
}));

app.get('/api/dashboard', requireUser, asyncRoute(async (_request, response) => {
  const {analytics} = await loadAnalytics();
  response.json(analytics);
}));

app.get('/api/work-orders/:number/history', requireUser, asyncRoute(async (request, response) => {
  const history = await getWorkOrderHistory(String(request.params.number));
  if (!history.states.length) {
    response.status(404).json({error: 'Work order not found in stored snapshots.'});
    return;
  }
  response.json(history);
}));

app.post('/api/ingest/google-sheet', requireIngestAuthority, asyncRoute(async (request, response) => {
  const url = process.env.GOOGLE_SHEET_CSV_URL;
  if (!url) throw Object.assign(new Error('GOOGLE_SHEET_CSV_URL is not configured.'), {status: 500});
  const fetchResponse = await fetch(url, {signal: AbortSignal.timeout(45_000)});
  if (!fetchResponse.ok) throw Object.assign(new Error(`Google Sheet fetch failed with HTTP ${fetchResponse.status}.`), {status: 502});
  const csv = await fetchResponse.text();
  const parsed = parseCsv(csv, `Google Sheet ${new Date().toISOString().slice(0, 10)}`);
  parsed.sourceType = 'google-sheet';
  parsed.sourceName = 'Live Google Sheet';
  parsed.capturedAt = `${new Date().toISOString().slice(0, 10)}T23:00:00.000Z`;
  response.json(await runIngest(parsed, request.query.summary !== 'false'));
}));

app.post('/api/ingest/file', requireUser, uploadParser, asyncRoute(async (request, response) => {
  const rawName = request.header('x-file-name') || 'uploaded-snapshot.xlsx';
  const sourceName = path.basename(rawName).slice(0, 240);
  const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
  if (!body.length) throw Object.assign(new Error('The uploaded file was empty.'), {status: 400});
  const parsed = sourceName.toLowerCase().endsWith('.csv')
    ? parseCsv(body.toString('utf8'), sourceName)
    : parseWorkbook(body, sourceName);
  const dated = applyCapturedAt(parsed, request.header('x-snapshot-date') || undefined);
  response.json(await runIngest(dated, request.query.summary !== 'false'));
}));

app.get('/api/summaries/latest', requireUser, asyncRoute(async (_request, response) => {
  response.json({summary: await getLatestExecutiveSummary()});
}));

app.post('/api/summaries/generate', requireUser, asyncRoute(async (request, response) => {
  const cadence = request.body?.cadence === 'weekly' ? 'weekly' : 'daily';
  const {analytics} = await loadAnalytics();
  const generated = await generateExecutiveSummary(analytics, cadence);
  await saveExecutiveSummary(analytics.snapshot.id, cadence, generated.text, generated.model);
  response.json({...generated, cadence, asOf: analytics.asOf});
}));

app.post('/api/chat', requireUser, asyncRoute(async (request, response) => {
  const key = request.ip || 'owner';
  const now = Date.now();
  const usage = chatUsage.get(key);
  if (!usage || now - usage.started > 60 * 60 * 1000) chatUsage.set(key, {started: now, count: 1});
  else if (usage.count >= 60) throw Object.assign(new Error('Hourly chat limit reached. Try again later.'), {status: 429});
  else usage.count += 1;

  const message = typeof request.body?.message === 'string' ? request.body.message.trim() : '';
  if (!message || message.length > 3000) throw Object.assign(new Error('Message must be between 1 and 3,000 characters.'), {status: 400});
  const history = Array.isArray(request.body?.history)
    ? request.body.history.filter((item: unknown) => {
      if (!item || typeof item !== 'object') return false;
      const candidate = item as Record<string, unknown>;
      return (candidate.role === 'user' || candidate.role === 'assistant') && typeof candidate.content === 'string';
    }).slice(-8)
    : [];
  const {analytics, rows} = await loadAnalytics();
  response.json(await answerQuestion(analytics, rows, message, history));
}));

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(projectRoot, 'dist'), {index: false, maxAge: '1h'}));
  app.get('/{*splat}', (_request, response) => response.sendFile(path.join(projectRoot, 'dist', 'index.html')));
} else {
  const {createServer} = await import('vite');
  const vite = await createServer({root: projectRoot, server: {middlewareMode: true}, appType: 'spa'});
  app.use(vite.middlewares);
}

app.use((error: Error & {status?: number}, _request: Request, response: Response, _next: NextFunction) => {
  console.error(error);
  const status = error.status && error.status >= 400 && error.status < 600 ? error.status : 500;
  response.status(status).json({error: status === 500 && process.env.NODE_ENV === 'production' ? 'The server could not complete the request.' : error.message});
});

async function start() {
  assertProductionSecurity();
  await migrate();
  const server = app.listen(port, '0.0.0.0', () => console.log(`NAS MRO Intelligence listening on http://0.0.0.0:${port}`));
  const shutdown = () => server.close(() => pool.end().finally(() => process.exit(0)));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

await start();
