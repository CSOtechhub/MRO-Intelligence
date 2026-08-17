import {FormEvent, useEffect, useRef, useState} from 'react';
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Bot,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  CircleGauge,
  Clock3,
  CloudDownload,
  Database,
  FileSpreadsheet,
  Loader2,
  LockKeyhole,
  MessageSquareText,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  Upload,
  Users,
  Wrench,
} from 'lucide-react';

type Tab = 'brief' | 'flow' | 'customers' | 'forecast' | 'data';

interface Snapshot {
  id: string;
  capturedAt: string;
  sourceName: string;
  sourceType: string;
  rowCount: number;
  dataQuality: Quality;
}

interface Quality {
  inputRows: number;
  acceptedRows: number;
  rejectedRows: number;
  duplicateWorkOrders: number;
  missingInductionDate: number;
  missingEdd: number;
  missingPrice: number;
  warnings: string[];
}

interface Analytics {
  asOf: string;
  snapshot: Snapshot;
  previousSnapshot: Snapshot | null;
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
  shops: Array<{shop: string; activeCount: number; activeValue: number; medianActiveAge: number; overdue: number; completedSample: number; medianCycle: number | null; p80Cycle: number | null}>;
  bottlenecks: Array<{shop: string; step: string; activeCount: number; medianDaysInStep: number; p80DaysInStep: number; overdue: number; delayedCount: number; severity: number}>;
  partBottlenecks: Array<{partNumber: string; shop: string; activeCount: number; medianActiveAge: number; completedSample: number; medianCycle: number | null; p80Cycle: number | null}>;
  customerTrends: Array<{customer: string; recent90: number; prior90: number; change: number; changePct: number | null; signal: 'tapering' | 'growing' | 'steady'; topChangedLane: string | null}>;
  forecasts: Array<{number: string; customer: string; shop: string; partNumber: string; status: string; step: string; daysInShop: number; predictedCompletion: string; likelyBy: string; remainingDays: number; confidence: string; basis: string; sampleSize: number}>;
  events: Array<{workOrderNumber: string; eventType: string; eventAt: string; fromValue: unknown; toValue: unknown}>;
  quality: Quality;
}

interface Summary {
  content: string;
  model: string;
  cadence?: string;
  asOf?: string;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

const tabs: Array<{id: Tab; label: string}> = [
  {id: 'brief', label: 'Executive brief'},
  {id: 'flow', label: 'Production flow'},
  {id: 'customers', label: 'Customer signals'},
  {id: 'forecast', label: 'Forecast'},
  {id: 'data', label: 'Data & history'},
];

const starterQuestions = [
  'What requires management attention today?',
  'Which departments and steps are constraining flow?',
  'Which customers show the strongest taper signals?',
];

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed with HTTP ${response.status}.`);
  return body as T;
}

function money(value: number): string {
  return value.toLocaleString('en-US', {style: 'currency', currency: 'USD', maximumFractionDigits: 0});
}

function number(value: number): string {
  return value.toLocaleString('en-US');
}

function shortDate(value: string): string {
  return new Date(`${value.slice(0, 10)}T12:00:00`).toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric'});
}

function Kpi({label, value, detail, tone = 'neutral'}: {label: string; value: string; detail: string; tone?: 'neutral' | 'warning' | 'danger' | 'good'}) {
  return <article className={`kpi-card tone-${tone}`}>
    <span>{label}</span>
    <strong>{value}</strong>
    <small>{detail}</small>
  </article>;
}

function EmptyState({busy, onLive, onUpload}: {busy: string; onLive: () => void; onUpload: () => void}) {
  return <main className="empty-state">
    <div className="empty-icon"><Database size={28} /></div>
    <span className="eyebrow">Initial setup</span>
    <h1>Build the shop’s operating memory.</h1>
    <p>If you have historical files, select all of them first; ISO-dated names load oldest-to-newest. Then sync the live Google Sheet. Each later snapshot updates the same WOs without treating omitted rows as closed work.</p>
    <div className="empty-actions">
      <button className="button primary" onClick={onLive} disabled={Boolean(busy)}>{busy ? <Loader2 className="spin" size={16} /> : <CloudDownload size={16} />} Ingest live Sheet</button>
      <button className="button" onClick={onUpload} disabled={Boolean(busy)}><Upload size={16} /> Upload snapshot</button>
    </div>
  </main>;
}

function Login({onAuthenticated}: {onAuthenticated: () => void}) {
  const [accessKey, setAccessKey] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/login', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({accessKey})});
      onAuthenticated();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Login failed.');
    } finally {
      setBusy(false);
    }
  }
  return <main className="login-shell">
    <form className="login-card" onSubmit={submit}>
      <div className="login-mark"><LockKeyhole size={24} /></div>
      <span className="eyebrow">Single-user workspace</span>
      <h1>NAS MRO Intelligence</h1>
      <p>Enter the private owner access key configured on the server.</p>
      <label>Owner access key<input type="password" value={accessKey} onChange={(event) => setAccessKey(event.target.value)} autoFocus /></label>
      {error && <div className="inline-error">{error}</div>}
      <button className="button primary full" disabled={busy || !accessKey}>{busy && <Loader2 className="spin" size={16} />} Open workspace</button>
    </form>
  </main>;
}

function ExecutiveBrief({data, summary, busy, onGenerate}: {data: Analytics; summary: Summary | null; busy: string; onGenerate: (cadence: 'daily' | 'weekly') => void}) {
  const tapering = data.customerTrends.filter((row) => row.signal === 'tapering').slice(0, 4);
  return <div className="content-stack">
    <section className="brief-grid">
      <article className="panel narrative-panel">
        <div className="panel-heading">
          <div><span className="eyebrow"><Sparkles size={13} /> Management narrative</span><h2>{summary ? `${summary.cadence || 'Latest'} executive summary` : 'Summary ready to generate'}</h2></div>
          <div className="button-row">
            <button className="button small" onClick={() => onGenerate('daily')} disabled={Boolean(busy)}>{busy === 'summary' && <Loader2 className="spin" size={14} />} Daily</button>
            <button className="button small" onClick={() => onGenerate('weekly')} disabled={Boolean(busy)}>Weekly</button>
          </div>
        </div>
        {summary
          ? <div className="summary-copy">{summary.content.split(/\n+/).filter(Boolean).map((paragraph, index) => <p key={index}>{paragraph.replace(/^#+\s*/, '')}</p>)}</div>
          : <div className="summary-placeholder"><Bot size={24} /><p>Generate an evidence-grounded brief. When Gemini is not configured, the engine still produces a deterministic operational readout.</p></div>}
        <footer><ShieldCheck size={14} /> Facts come from stored snapshots; signals and forecasts are labeled.</footer>
      </article>
      <aside className="panel action-panel">
        <div className="panel-heading"><div><span className="eyebrow">Priority queue</span><h2>What needs attention</h2></div></div>
        <div className="priority-list">
          {data.bottlenecks.slice(0, 3).map((row, index) => <div className="priority" key={`${row.shop}-${row.step}`}><span>{index + 1}</span><div><strong>{row.shop} · {row.step}</strong><p>{number(row.activeCount)} active · {row.medianDaysInStep}d median in step · {row.overdue} overdue</p></div><ChevronRight size={16} /></div>)}
          {tapering.slice(0, 2).map((row) => <div className="priority customer-priority" key={row.customer}><span><Users size={14} /></span><div><strong>Follow up: {row.customer}</strong><p>{row.prior90} → {row.recent90} inductions over comparable 90-day windows</p></div><ChevronRight size={16} /></div>)}
        </div>
      </aside>
    </section>
    <section className="panel">
      <div className="panel-heading"><div><span className="eyebrow">Department health</span><h2>Where work is accumulating</h2></div><span className="muted">Cycle = induction to closed date</span></div>
      <div className="table-wrap"><table><thead><tr><th>Department</th><th>Active WOs</th><th>Active quoted value</th><th>Median active age</th><th>Past EDD</th><th>Completed median / P80</th></tr></thead><tbody>
        {data.shops.map((row) => <tr key={row.shop}><td><strong>{row.shop}</strong></td><td>{number(row.activeCount)}</td><td>{money(row.activeValue)}</td><td>{row.medianActiveAge}d</td><td className={row.overdue ? 'danger-text' : ''}>{number(row.overdue)}</td><td>{row.medianCycle === null ? 'Not enough history' : `${row.medianCycle}d / ${row.p80Cycle}d`} <small>n={row.completedSample}</small></td></tr>)}
      </tbody></table></div>
    </section>
  </div>;
}

function ProductionFlow({data}: {data: Analytics}) {
  return <div className="content-stack">
    <section className="panel"><div className="panel-heading"><div><span className="eyebrow">Step pressure</span><h2>Current bottleneck signals</h2></div><p className="muted">Severity combines queue size, dwell time, delayed units, and overdue EDDs.</p></div>
      <div className="table-wrap"><table><thead><tr><th>Department / step</th><th>Active</th><th>Median dwell</th><th>P80 dwell</th><th>Delayed</th><th>Past EDD</th><th>Pressure</th></tr></thead><tbody>
        {data.bottlenecks.map((row) => <tr key={`${row.shop}-${row.step}`}><td><strong>{row.shop}</strong><br/><small>{row.step}</small></td><td>{row.activeCount}</td><td>{row.medianDaysInStep}d</td><td>{row.p80DaysInStep}d</td><td>{row.delayedCount}</td><td className={row.overdue ? 'danger-text' : ''}>{row.overdue}</td><td><div className="pressure"><i style={{width: `${Math.min(100, row.severity)}%`}}/><span>{row.severity}</span></div></td></tr>)}
      </tbody></table></div>
    </section>
    <section className="panel"><div className="panel-heading"><div><span className="eyebrow">Part families</span><h2>High-load and slow-moving parts</h2></div></div>
      <div className="table-wrap"><table><thead><tr><th>Part number</th><th>Department</th><th>Active</th><th>Median active age</th><th>Historical cycle median</th><th>Historical P80</th></tr></thead><tbody>
        {data.partBottlenecks.map((row) => <tr key={`${row.partNumber}-${row.shop}`}><td><strong>{row.partNumber}</strong></td><td>{row.shop}</td><td>{row.activeCount}</td><td>{row.medianActiveAge}d</td><td>{row.medianCycle === null ? '—' : `${row.medianCycle}d`}</td><td>{row.p80Cycle === null ? '—' : `${row.p80Cycle}d`} <small>n={row.completedSample}</small></td></tr>)}
      </tbody></table></div>
    </section>
  </div>;
}

function CustomerSignals({data}: {data: Analytics}) {
  return <section className="panel"><div className="panel-heading"><div><span className="eyebrow">Induction momentum</span><h2>Customer volume: recent 90 vs prior 90 days</h2></div><p className="muted">A taper is a commercial follow-up signal—not proof of churn.</p></div>
    <div className="table-wrap"><table><thead><tr><th>Customer</th><th>Prior 90d</th><th>Recent 90d</th><th>Change</th><th>Signal</th><th>Lane with largest decline</th></tr></thead><tbody>
      {data.customerTrends.map((row) => <tr key={row.customer}><td><strong>{row.customer}</strong></td><td>{row.prior90}</td><td>{row.recent90}</td><td className={row.change < 0 ? 'danger-text' : row.change > 0 ? 'good-text' : ''}>{row.change > 0 ? '+' : ''}{row.change} {row.changePct === null ? '' : `(${row.changePct}%)`}</td><td><span className={`signal ${row.signal}`}>{row.signal === 'tapering' ? <ArrowDownRight size={13}/> : row.signal === 'growing' ? <ArrowUpRight size={13}/> : null}{row.signal}</span></td><td>{row.topChangedLane || '—'}</td></tr>)}
    </tbody></table></div>
  </section>;
}

function Forecast({data}: {data: Analytics}) {
  return <div className="content-stack"><div className="method-note"><CircleGauge size={18}/><div><strong>Baseline forecast—not a promise</strong><p>Each estimate uses completed cycle distributions for the most specific reliable cohort: part + department, then part, department, or shop-wide history. Confidence is based on sample size.</p></div></div>
    <section className="panel"><div className="panel-heading"><div><span className="eyebrow">Oldest active units first</span><h2>Production completion outlook</h2></div></div><div className="table-wrap"><table><thead><tr><th>WO #</th><th>Customer / part</th><th>Department / step</th><th>Age</th><th>Expected</th><th>Likely by (P80)</th><th>Confidence</th></tr></thead><tbody>
      {data.forecasts.map((row) => <tr key={row.number}><td><strong>{row.number}</strong></td><td>{row.customer}<br/><small>{row.partNumber}</small></td><td>{row.shop}<br/><small>{row.step}</small></td><td>{row.daysInShop}d</td><td>{shortDate(row.predictedCompletion)}<br/><small>{row.remainingDays}d remaining</small></td><td>{shortDate(row.likelyBy)}</td><td><span className={`confidence ${row.confidence}`}>{row.confidence}</span><br/><small>n={row.sampleSize}</small></td></tr>)}
    </tbody></table></div></section>
  </div>;
}

function DataHistory({data, snapshots}: {data: Analytics; snapshots: Snapshot[]}) {
  return <div className="content-stack"><section className="quality-grid">
    <article className="panel"><span className="eyebrow">Latest validation</span><h2>{number(data.quality.acceptedRows)} accepted rows</h2><div className="quality-list"><span><CheckCircle2 size={15}/> {data.quality.rejectedRows} rejected rows</span><span><FileSpreadsheet size={15}/> {data.quality.duplicateWorkOrders} duplicate WOs collapsed</span><span><CalendarClock size={15}/> {number(data.quality.missingEdd)} missing EDD</span><span><AlertTriangle size={15}/> {number(data.quality.missingInductionDate)} missing induction dates</span></div>{data.quality.warnings.map((warning) => <p className="warning-line" key={warning}>{warning}</p>)}</article>
    <article className="panel"><span className="eyebrow">Identity rules</span><h2>WO # is the durable key</h2><p className="body-copy">The first valid induction Date becomes canonical. Step, status, EDD, price, tags, and closed date may change. A WO absent from a later snapshot is kept in history and is never automatically marked closed.</p></article>
  </section><section className="panel"><div className="panel-heading"><div><span className="eyebrow">Stored source history</span><h2>Snapshot ledger</h2></div></div><div className="table-wrap"><table><thead><tr><th>Captured</th><th>Source</th><th>Type</th><th>Visible WOs</th><th>Accepted / rejected</th></tr></thead><tbody>
    {snapshots.map((row) => <tr key={row.id}><td>{new Date(row.capturedAt).toLocaleString()}</td><td><strong>{row.sourceName}</strong></td><td>{row.sourceType}</td><td>{number(row.rowCount)}</td><td>{number(row.dataQuality.acceptedRows)} / {row.dataQuality.rejectedRows}</td></tr>)}
  </tbody></table></div></section></div>;
}

function Chat({messages, busy, onAsk}: {messages: ChatMessage[]; busy: string; onAsk: (message: string) => void}) {
  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => endRef.current?.scrollIntoView({behavior: 'smooth'}), [messages, busy]);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim() || busy === 'chat') return;
    onAsk(draft.trim());
    setDraft('');
  }
  return <aside className="chat-panel">
    <header><div className="bot-mark"><Bot size={18}/></div><div><strong>Shop advisor</strong><span>Grounded in the latest snapshot</span></div><i/></header>
    <div className="chat-body">
      {!messages.length && <div className="chat-welcome"><Sparkles size={20}/><h3>Ask for the management view.</h3><p>I can explain shop flow, customer changes, part performance, individual WOs, and forecast assumptions.</p><div>{starterQuestions.map((question) => <button key={question} onClick={() => onAsk(question)}>{question}</button>)}</div></div>}
      {messages.map((message, index) => <div className={`message ${message.role}`} key={index}>{message.content.split('\n').map((line, lineIndex) => <p key={lineIndex}>{line}</p>)}</div>)}
      {busy === 'chat' && <div className="message assistant thinking"><Loader2 className="spin" size={16}/> Reviewing the operating context…</div>}
      <div ref={endRef}/>
    </div>
    <form onSubmit={submit}><textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Ask about a WO, customer, part, or production risk…" rows={3}/><button aria-label="Send" disabled={!draft.trim() || busy === 'chat'}><Send size={17}/></button></form>
    <footer>Gemini sees a bounded analytical context—not your credentials.</footer>
  </aside>;
}

export default function Dashboard() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [data, setData] = useState<Analytics | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [tab, setTab] = useState<Tab>('brief');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  async function refresh() {
    setError('');
    try {
      const [dashboard, snapshotResponse, summaryResponse] = await Promise.all([
        api<Analytics>('/api/dashboard'),
        api<{snapshots: Snapshot[]}>('/api/snapshots'),
        api<{summary: Summary | null}>('/api/summaries/latest'),
      ]);
      setData(dashboard);
      setSnapshots(snapshotResponse.snapshots);
      setSummary(summaryResponse.summary);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Could not load the dashboard.';
      if (!message.includes('No snapshots')) setError(message);
      setData(null);
    }
  }

  useEffect(() => {
    api<{required: boolean; authenticated: boolean}>('/api/auth/status').then((status) => {
      setAuthRequired(status.required);
      setAuthenticated(status.authenticated);
      if (status.authenticated) refresh();
    }).catch((caught) => {
      setError(caught instanceof Error ? caught.message : 'Server unavailable.');
      setAuthenticated(false);
    });
  }, []);

  async function ingestLive() {
    setBusy('ingest'); setError(''); setNotice('');
    try {
      const result = await api<{duplicate: boolean; snapshot: Snapshot; summary?: {text: string; model: string}; summaryWarning?: string}>('/api/ingest/google-sheet', {method: 'POST'});
      setNotice(result.duplicate ? 'This exact Sheet snapshot was already stored today.' : `${number(result.snapshot.rowCount)} work orders ingested from the live Sheet.${result.summaryWarning ? ` Summary warning: ${result.summaryWarning}` : ''}`);
      if (result.summary) setSummary({content: result.summary.text, model: result.summary.model, cadence: 'daily'});
      await refresh();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Ingestion failed.'); }
    finally { setBusy(''); }
  }

  async function upload(files: File[]) {
    setBusy('upload'); setError(''); setNotice('');
    try {
      let ingested = 0;
      let duplicates = 0;
      const ordered = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, {numeric: true}));
      for (const file of ordered) {
        const result = await api<{duplicate: boolean; snapshot: Snapshot}>('/api/ingest/file?summary=false', {
          method: 'POST', headers: {'Content-Type': file.name.toLowerCase().endsWith('.csv') ? 'text/csv' : 'application/octet-stream', 'x-file-name': file.name}, body: file,
        });
        if (result.duplicate) duplicates += 1;
        else ingested += 1;
      }
      setNotice(`${ingested} snapshot${ingested === 1 ? '' : 's'} ingested${duplicates ? `; ${duplicates} exact duplicate${duplicates === 1 ? '' : 's'} skipped` : ''}.`);
      await refresh();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Upload failed.'); }
    finally { setBusy(''); if (fileRef.current) fileRef.current.value = ''; }
  }

  async function generateSummary(cadence: 'daily' | 'weekly') {
    setBusy('summary'); setError('');
    try {
      const result = await api<{text: string; model: string; asOf: string}>('/api/summaries/generate', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({cadence})});
      setSummary({content: result.text, model: result.model, cadence, asOf: result.asOf});
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Summary generation failed.'); }
    finally { setBusy(''); }
  }

  async function ask(message: string) {
    const next = [...messages, {role: 'user' as const, content: message}];
    setMessages(next); setBusy('chat'); setError('');
    try {
      const result = await api<{text: string}>('/api/chat', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({message, history: messages})});
      setMessages([...next, {role: 'assistant', content: result.text}]);
    } catch (caught) {
      setMessages([...next, {role: 'assistant', content: caught instanceof Error ? caught.message : 'I could not complete that analysis.'}]);
    } finally { setBusy(''); }
  }

  if (authenticated === null) return <main className="loading-screen"><Loader2 className="spin"/><span>Opening operating memory…</span></main>;
  if (authRequired && !authenticated) return <Login onAuthenticated={() => {setAuthenticated(true); refresh();}}/>;

  return <div className="app-shell">
    <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" multiple hidden onChange={(event) => event.target.files?.length && upload([...event.target.files])}/>
    <header className="topbar"><div className="brand"><div className="brand-mark">N</div><div><strong>NAS MRO Intelligence</strong><span>Shop lifecycle command center</span></div></div>
      <div className="top-actions">{data && <span className="freshness"><i/> Data through {shortDate(data.asOf)}</span>}<button className="button" onClick={() => fileRef.current?.click()} disabled={Boolean(busy)}><Upload size={15}/> Snapshot</button><button className="button primary" onClick={ingestLive} disabled={Boolean(busy)}>{busy === 'ingest' ? <Loader2 className="spin" size={15}/> : <RefreshCw size={15}/>} Sync Sheet</button></div>
    </header>
    {!data ? <><div className="alerts">{error && <div className="alert error"><AlertTriangle size={16}/>{error}</div>}</div><EmptyState busy={busy} onLive={ingestLive} onUpload={() => fileRef.current?.click()}/></> : <>
      <div className="workspace">
        <main className="main-column">
          <section className="hero"><div><span className="eyebrow">Operating picture · {shortDate(data.asOf)}</span><h1>See the shop’s life cycle,<br/>not just its totals.</h1><p>{number(data.snapshot.rowCount)} work orders visible in the latest source. Historical identity is anchored to WO # and induction Date.</p></div><div className="hero-deltas"><span><strong>+{data.kpis.newSincePrevious}</strong> new work</span><span><strong>{data.kpis.stepChangesSincePrevious}</strong> step moves</span><span><strong>{data.kpis.closuresSincePrevious}</strong> closures</span><small>vs prior snapshot</small></div></section>
          <section className="kpi-grid"><Kpi label="Active work" value={number(data.kpis.activeWorkOrders)} detail={`${money(data.kpis.activeValue)} quoted value`} tone="neutral"/><Kpi label="Past EDD" value={number(data.kpis.overdueEdd)} detail={`${number(data.kpis.missingEdd)} active WOs missing EDD`} tone="danger"/><Kpi label="Aged over 60 days" value={number(data.kpis.olderThan60Days)} detail={`${number(data.kpis.olderThan90Days)} are over 90 days`} tone="warning"/><Kpi label="Completed cycle" value={data.kpis.medianCompletedCycle === null ? '—' : `${data.kpis.medianCompletedCycle} days`} detail={`P80 ${data.kpis.p80CompletedCycle ?? '—'} days`} tone="good"/></section>
          <nav className="tabs">{tabs.map((item) => <button className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)} key={item.id}>{item.label}</button>)}</nav>
          <div className="alerts">{error && <div className="alert error"><AlertTriangle size={16}/>{error}<button onClick={() => setError('')}>×</button></div>}{notice && <div className="alert success"><CheckCircle2 size={16}/>{notice}<button onClick={() => setNotice('')}>×</button></div>}</div>
          {tab === 'brief' && <ExecutiveBrief data={data} summary={summary} busy={busy} onGenerate={generateSummary}/>} 
          {tab === 'flow' && <ProductionFlow data={data}/>} 
          {tab === 'customers' && <CustomerSignals data={data}/>} 
          {tab === 'forecast' && <Forecast data={data}/>} 
          {tab === 'data' && <DataHistory data={data} snapshots={snapshots}/>} 
        </main>
        <Chat messages={messages} busy={busy} onAsk={ask}/>
      </div>
      <footer className="app-footer"><span><Wrench size={14}/> NAS MRO Intelligence</span><span>Quoted price is not recognized revenue. Forecasts are decision support.</span></footer>
    </>}
  </div>;
}
