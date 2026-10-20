import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  Activity, ArrowDownRight, ArrowUpRight, Check, CircleHelp,
  Cpu, Gauge, KeyRound, LayoutDashboard, LockKeyhole, LogOut, Plus,
  RefreshCw, Router, Search, Server, Settings2, ShieldCheck, Trash2, X,
} from 'lucide-react';

type Page = 'Overview' | 'Providers' | 'Models' | 'Request Logs' | 'Settings';
type Provider = { name: string; baseUrl: string; models: string[]; hasApiKey: boolean };
type Model = { model: string; provider: string };
type RequestLog = {
  id: string; timestamp: string; status: 'success' | 'error'; provider: string;
  model: string; latencyMs: number; httpStatus: number;
};
type Overview = {
  status: string; uptimeSeconds: number; providerCount: number; modelCount: number;
  requestCount: number; requestLogLimit: number;
};
type Settings = {
  host: string; port: number; adminAuthentication: string; providerSecrets: string;
  requestLogLimit: number; uptimeSeconds: number;
};

const pages: Array<{ name: Page; icon: typeof LayoutDashboard }> = [
  { name: 'Overview', icon: LayoutDashboard },
  { name: 'Providers', icon: Server },
  { name: 'Models', icon: Cpu },
  { name: 'Request Logs', icon: Activity },
  { name: 'Settings', icon: Settings2 },
];

async function request<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    throw new Error(result?.error?.message ?? `Request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function prettyDuration(seconds: number) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function App() {
  const [token, setToken] = useState('');
  const [candidate, setCandidate] = useState('');
  const [page, setPage] = useState<Page>('Overview');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [logs, setLogs] = useState<RequestLog[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [editing, setEditing] = useState<Provider | null>(null);
  const [showProviderForm, setShowProviderForm] = useState(false);
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async (activeToken = token) => {
    if (!activeToken) return;
    setLoading(true);
    setError('');
    try {
      const [o, p, m, r, s] = await Promise.all([
        request<Overview>('/admin/overview', activeToken),
        request<{ providers: Provider[] }>('/admin/providers', activeToken),
        request<{ models: Model[] }>('/admin/models', activeToken),
        request<{ requests: RequestLog[] }>('/admin/requests', activeToken),
        request<Settings>('/admin/settings', activeToken),
      ]);
      setOverview(o); setProviders(p.providers); setModels(m.models); setLogs(r.requests); setSettings(s);
      setToken(activeToken);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load dashboard.');
      if (!token) setToken('');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (token) void refresh(token);
    // Refresh once on login; subsequent refreshes are user-triggered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = async (event: FormEvent) => {
    event.preventDefault();
    if (!candidate.trim()) return;
    const key = candidate.trim();
    setCandidate('');
    await refresh(key);
  };

  const logout = () => {
    setToken(''); setOverview(null); setProviders([]); setModels([]); setLogs([]); setSettings(null);
  };

  const saveProvider = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const id = String(form.get('name')).trim();
    try {
      await request(`/admin/providers/${encodeURIComponent(id)}`, token, {
        method: 'PUT',
        body: JSON.stringify({
          baseUrl: form.get('baseUrl'),
          apiKey: form.get('apiKey'),
          models: String(form.get('models')).split(',').map((model) => model.trim()).filter(Boolean),
        }),
      });
      setShowProviderForm(false); setEditing(null); setNotice('Provider saved.');
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save provider.');
    }
  };

  const deleteProvider = async (provider: Provider) => {
    if (!window.confirm(`Remove ${provider.name}? Its models will stop routing until another provider is configured.`)) return;
    try {
      await request(`/admin/providers/${encodeURIComponent(provider.name)}`, token, { method: 'DELETE' });
      setNotice('Provider removed.'); await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not remove provider.');
    }
  };

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 3000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const successRate = useMemo(() => {
    if (!logs.length) return null;
    return Math.round((logs.filter((log) => log.status === 'success').length / logs.length) * 100);
  }, [logs]);

  if (!token || !overview) {
    return <Login candidate={candidate} setCandidate={setCandidate} onSubmit={login} error={error} loading={loading} />;
  }

  return (
    <div className="min-h-screen bg-[#090d13] text-slate-100">
      <aside className="sidebar hidden lg:fixed lg:inset-y-0 lg:flex lg:w-[248px] lg:flex-col">
        <Brand />
        <div className="px-4 pt-9 text-[10px] font-bold uppercase tracking-[.2em] text-slate-600">Workspace</div>
        <Navigation page={page} setPage={setPage} />
        <div className="mt-auto p-4">
          <div className="rounded-xl border border-white/[.06] bg-white/[.025] p-3.5">
            <div className="flex items-center gap-2 text-xs font-medium text-slate-300"><ShieldCheck size={15} className="text-emerald-400" /> Local gateway</div>
            <div className="mt-2.5 flex items-center gap-2 text-[11px] text-slate-500"><span className="live-dot" /> Admin API protected</div>
          </div>
          <button onClick={logout} className="mt-3 flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-sm text-slate-500 transition hover:bg-white/[.04] hover:text-slate-200"><LogOut size={16} /> Sign out</button>
        </div>
      </aside>

      <div className="lg:pl-[248px]">
        <header className="topbar sticky top-0 z-20 flex h-[66px] items-center justify-between px-4 sm:px-7 lg:px-9">
          <div className="flex items-center gap-3">
            <div className="lg:hidden"><Brand compact /></div>
            <div className="hidden h-5 w-px bg-white/10 sm:block lg:hidden" />
            <div className="hidden text-sm text-slate-400 sm:block">Gateway <span className="mx-2 text-slate-700">/</span><span className="text-slate-100">{page}</span></div>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <div className="hidden items-center gap-2 rounded-full border border-emerald-400/10 bg-emerald-400/[.06] px-3 py-1.5 text-[11px] font-medium text-emerald-300 sm:flex"><span className="live-dot" /> Operational</div>
            <button className="icon-button" title="Refresh" onClick={() => void refresh()}><RefreshCw size={15} className={loading ? 'animate-spin' : ''} /></button>
            <button className="icon-button lg:hidden" title="Sign out" onClick={logout}><LogOut size={15} /></button>
          </div>
        </header>

        <nav className="mobile-nav flex gap-1 overflow-x-auto px-3 py-2 lg:hidden">
          {pages.map(({ name, icon: Icon }) => <button key={name} onClick={() => setPage(name)} className={`mobile-nav-item ${page === name ? 'active' : ''}`}><Icon size={15} /><span>{name}</span></button>)}
        </nav>

        <main className="mx-auto max-w-[1380px] px-4 pb-12 pt-7 sm:px-7 lg:px-9 lg:pt-9">
          {error && <div role="alert" className="mb-5 flex items-center justify-between rounded-xl border border-rose-500/20 bg-rose-500/[.07] px-4 py-3 text-sm text-rose-200"><span>{error}</span><button onClick={() => setError('')}><X size={16} /></button></div>}
          {notice && <div className="toast"><Check size={16} />{notice}</div>}
          {page === 'Overview' && <OverviewPage overview={overview} providers={providers} logs={logs} successRate={successRate} setPage={setPage} />}
          {page === 'Providers' && <ProvidersPage providers={providers} onAdd={() => { setEditing(null); setShowProviderForm(true); }} onEdit={(provider) => { setEditing(provider); setShowProviderForm(true); }} onDelete={deleteProvider} />}
          {page === 'Models' && <ModelsPage models={models} />}
          {page === 'Request Logs' && <LogsPage logs={logs} />}
          {page === 'Settings' && <SettingsPage settings={settings} overview={overview} />}
        </main>
      </div>

      {showProviderForm && <ProviderModal provider={editing} error={error} onClose={() => setShowProviderForm(false)} onSave={saveProvider} />}
    </div>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return <div className={`flex items-center gap-3 ${compact ? '' : 'px-5 pt-5'}`}>
    <div className="brand-mark"><Router size={18} strokeWidth={2.2} /></div>
    <div className="leading-tight"><div className="text-[14px] font-semibold tracking-[-.02em] text-white">K&apos;sRouter</div>{!compact && <div className="mt-1 text-[10px] tracking-wide text-slate-600">AI GATEWAY</div>}</div>
  </div>;
}

function Navigation({ page, setPage }: { page: Page; setPage: (page: Page) => void }) {
  return <nav className="mt-4 space-y-1 px-3">{pages.map(({ name, icon: Icon }) => <button key={name} onClick={() => setPage(name)} className={`sidebar-link ${page === name ? 'active' : ''}`}><Icon size={17} strokeWidth={1.8} /><span>{name}</span>{name === 'Request Logs' && <span className="nav-count">live</span>}</button>)}</nav>;
}

function PageHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="mb-7 flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><div><div className="eyebrow">{eyebrow}</div><h1 className="mt-2 text-[25px] font-semibold tracking-[-.045em] text-white sm:text-[30px]">{title}</h1><p className="mt-1.5 max-w-2xl text-sm leading-6 text-slate-500">{description}</p></div>{action}</div>;
}

function OverviewPage({ overview, providers, logs, successRate, setPage }: { overview: Overview; providers: Provider[]; logs: RequestLog[]; successRate: number | null; setPage: (page: Page) => void }) {
  const cards = [
    { label: 'Gateway status', value: 'Operational', detail: `Uptime ${prettyDuration(overview.uptimeSeconds)}`, icon: Gauge, color: 'emerald' },
    { label: 'Providers', value: overview.providerCount, detail: 'Configured in memory', icon: Server, color: 'blue' },
    { label: 'Available models', value: overview.modelCount, detail: 'Model routes active', icon: Cpu, color: 'violet' },
    { label: 'Success rate', value: successRate === null ? '—' : `${successRate}%`, detail: `${overview.requestCount} recent requests`, icon: Activity, color: 'amber' },
  ];
  return <>
    <PageHeading eyebrow="CONTROL PLANE" title="Gateway overview" description="A live view of your self-hosted model routing layer." action={<a className="secondary-button" href="/health" target="_blank" rel="noreferrer"><Activity size={15} /> Health endpoint <ArrowUpRight size={14} /></a>} />
    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{cards.map(({ label, value, detail, icon: Icon, color }) => <div className="stat-card" key={label}><div className="flex items-center justify-between"><span className="text-xs font-medium text-slate-500">{label}</span><div className={`stat-icon ${color}`}><Icon size={16} /></div></div><div className="mt-5 text-[25px] font-semibold tracking-[-.045em] text-slate-100">{value}</div><div className="mt-1.5 text-[11px] text-slate-600">{detail}</div></div>)}</section>
    <div className="mt-5 grid gap-5 xl:grid-cols-[1.45fr_1fr]">
      <section className="panel"><div className="panel-heading"><div><h2 className="panel-title">Provider connections</h2><p className="panel-subtitle">Configured upstreams and routed model count</p></div><button className="text-xs font-medium text-slate-500 hover:text-slate-200" onClick={() => setPage('Providers')}>Manage providers <ArrowUpRight size={13} className="ml-1 inline" /></button></div>
        {providers.length ? <div className="divide-y divide-white/[.045]">{providers.slice(0, 5).map((provider, index) => <div key={provider.name} className="flex items-center gap-3.5 py-4"><div className={`provider-avatar avatar-${index % 4}`}>{provider.name.slice(0, 1).toUpperCase()}</div><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><span className="truncate text-sm font-medium text-slate-200">{provider.name}</span><span className="tiny-pill"><span className="live-dot" />active</span></div><div className="mt-1 truncate text-xs text-slate-600">{provider.baseUrl}</div></div><div className="text-right"><div className="text-sm font-medium text-slate-300">{provider.models.length}</div><div className="mt-1 text-[10px] text-slate-600">models</div></div></div>)}</div> : <EmptyState icon={Server} title="No providers configured" detail="Add an upstream provider to begin routing." />}
      </section>
      <section className="panel"><div className="panel-heading"><div><h2 className="panel-title">Recent requests</h2><p className="panel-subtitle">Metadata only. Prompts and secrets are never stored.</p></div><button className="icon-button" title="Open logs" onClick={() => setPage('Request Logs')}><ArrowUpRight size={15} /></button></div>
        {logs.length ? <div className="space-y-0.5">{logs.slice(0, 5).map((log) => <div key={log.id} className="flex items-center gap-3 border-b border-white/[.04] py-3 last:border-0"><StatusDot success={log.status === 'success'} /><div className="min-w-0 flex-1"><div className="truncate text-xs font-medium text-slate-300">{log.model}</div><div className="mt-1 text-[10px] text-slate-600">{log.provider} · {formatTime(log.timestamp)}</div></div><div className="text-right"><div className="text-xs text-slate-400">{log.latencyMs} ms</div><div className="mt-1 text-[10px] text-slate-600">HTTP {log.httpStatus}</div></div></div>)}</div> : <EmptyState icon={Activity} title="Waiting for traffic" detail="Requests will appear here once the gateway is used." />}
      </section>
    </div>
    <div className="mt-5 flex flex-col gap-4 rounded-2xl border border-white/[.055] bg-gradient-to-r from-[#101923] to-[#10151d] p-5 sm:flex-row sm:items-center sm:justify-between sm:px-6"><div className="flex items-start gap-3"><div className="rounded-xl bg-sky-400/[.08] p-2.5 text-sky-300"><LockKeyhole size={17} /></div><div><div className="text-sm font-medium text-slate-200">Local by default. Private by design.</div><div className="mt-1 max-w-xl text-xs leading-5 text-slate-500">Dashboard changes stay in memory until the gateway restarts. Provider credentials remain on the server.</div></div></div><button onClick={() => setPage('Settings')} className="secondary-button shrink-0">Review settings <ArrowDownRight size={14} /></button></div>
  </>;
}

function ProvidersPage({ providers, onAdd, onEdit, onDelete }: { providers: Provider[]; onAdd: () => void; onEdit: (provider: Provider) => void; onDelete: (provider: Provider) => void }) {
  return <>
    <PageHeading eyebrow="UPSTREAMS" title="Providers" description="Manage upstream endpoints and model routing. Credentials are write-only and never returned." action={<button className="primary-button" onClick={onAdd}><Plus size={16} /> Add provider</button>} />
    {providers.length ? <div className="grid gap-4 xl:grid-cols-2">{providers.map((provider, index) => <article className="panel provider-card" key={provider.name}><div className="flex items-start gap-3.5"><div className={`provider-avatar large avatar-${index % 4}`}>{provider.name.slice(0, 1).toUpperCase()}</div><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><h2 className="truncate text-[15px] font-semibold text-slate-100">{provider.name}</h2><span className="tiny-pill"><span className="live-dot" />ready</span></div><div className="mt-1.5 break-all text-xs text-slate-500">{provider.baseUrl}</div></div><div className="flex gap-1"><button className="icon-button" title="Edit provider" onClick={() => onEdit(provider)}><Settings2 size={15} /></button><button className="icon-button danger" title="Remove provider" onClick={() => onDelete(provider)}><Trash2 size={15} /></button></div></div><div className="mt-5 border-t border-white/[.055] pt-4"><div className="mb-2 flex items-center justify-between"><span className="text-[10px] font-semibold uppercase tracking-[.15em] text-slate-600">Routed models</span><span className="text-[10px] text-slate-600">{provider.models.length} total</span></div><div className="flex flex-wrap gap-2">{provider.models.map((model) => <span className="model-chip" key={model}>{model}</span>)}</div></div><div className="mt-4 flex items-center gap-2 text-[11px] text-slate-600"><KeyRound size={13} className="text-emerald-500/70" /> API key stored server-side <span className="ml-auto text-emerald-400/70">{provider.hasApiKey ? 'Configured' : 'Missing'}</span></div></article>)}</div> : <div className="panel"><EmptyState icon={Server} title="No providers yet" detail="Connect an OpenAI-compatible provider to make its models available." action={<button className="primary-button" onClick={onAdd}><Plus size={16} /> Add first provider</button>} /></div>}
    <div className="mt-5 flex gap-3 rounded-xl border border-amber-400/[.12] bg-amber-400/[.035] p-4 text-xs leading-5 text-amber-100/65"><CircleHelp size={16} className="mt-0.5 shrink-0 text-amber-300/70" /><span>Changes made here live in memory and reset when K&apos;sRouter restarts. Set providers in the environment for persistent startup configuration.</span></div>
  </>;
}

function ModelsPage({ models }: { models: Model[] }) {
  const [query, setQuery] = useState('');
  const filtered = models.filter((item) => `${item.model} ${item.provider}`.toLowerCase().includes(query.toLowerCase()));
  return <>
    <PageHeading eyebrow="MODEL ROUTES" title="Models" description="Every model name routes to exactly one configured provider." />
    <div className="panel"><div className="panel-heading flex-wrap"><div><h2 className="panel-title">Available models <span className="ml-2 rounded-md bg-white/[.05] px-1.5 py-1 text-[10px] font-medium text-slate-500">{models.length}</span></h2><p className="panel-subtitle">Use the model name exactly as shown in API requests.</p></div><label className="search-box"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find model or provider" /></label></div>
      {filtered.length ? <div className="overflow-x-auto"><table className="data-table"><thead><tr><th>Model</th><th>Provider</th><th>Route status</th><th>API compatibility</th></tr></thead><tbody>{filtered.map((item) => <tr key={`${item.provider}-${item.model}`}><td><div className="flex items-center gap-2.5"><Cpu size={15} className="text-violet-300/70" /><span className="font-medium text-slate-200">{item.model}</span></div></td><td><span className="provider-inline"><span className="provider-mini">{item.provider.slice(0, 1).toUpperCase()}</span>{item.provider}</span></td><td><span className="table-status"><span className="live-dot" />Routed</span></td><td className="text-slate-500">Chat Completions</td></tr>)}</tbody></table></div> : <EmptyState icon={Cpu} title={models.length ? 'No matching models' : 'No model routes'} detail={models.length ? 'Try another search.' : 'Add a provider with one or more model names.'} />}
    </div>
  </>;
}

function LogsPage({ logs }: { logs: RequestLog[] }) {
  const [filter, setFilter] = useState('all');
  const visible = logs.filter((log) => filter === 'all' || log.status === filter);
  return <>
    <PageHeading eyebrow="OBSERVABILITY" title="Request logs" description="Recent request metadata held in bounded memory. Message contents and API keys are never recorded." action={<div className="filter-pills">{['all', 'success', 'error'].map((value) => <button key={value} className={filter === value ? 'selected' : ''} onClick={() => setFilter(value)}>{value === 'all' ? 'All' : value === 'success' ? 'Success' : 'Errors'}</button>)}</div>} />
    <section className="panel"><div className="panel-heading"><div><h2 className="panel-title">Latest activity</h2><p className="panel-subtitle">Up to 100 most recent records, newest first.</p></div><div className="inline-health"><span className="live-dot" />Recording</div></div>
      {visible.length ? <><div className="overflow-x-auto"><table className="data-table logs-table"><thead><tr><th>Status</th><th>Time</th><th>Provider</th><th>Model</th><th>Latency</th><th>HTTP</th></tr></thead><tbody>{visible.map((log) => <tr key={log.id}><td><span className={`log-status ${log.status}`}><span />{log.status}</span></td><td className="whitespace-nowrap text-slate-500">{formatDate(log.timestamp)}</td><td className="text-slate-300">{log.provider}</td><td className="max-w-[260px] truncate font-medium text-slate-200">{log.model}</td><td className="whitespace-nowrap text-slate-400">{log.latencyMs} ms</td><td><span className={`http-code ${log.status}`}>{log.httpStatus}</span></td></tr>)}</tbody></table></div>
        <div className="mobile-log-list">{visible.map((log) => <div className="mobile-log" key={log.id}><div className="flex items-center justify-between"><span className={`log-status ${log.status}`}><span />{log.status}</span><span className="text-[11px] text-slate-600">{formatTime(log.timestamp)}</span></div><div className="mt-2 truncate text-sm font-medium text-slate-200">{log.model}</div><div className="mt-1 flex justify-between text-[11px] text-slate-500"><span>{log.provider}</span><span>{log.latencyMs} ms · HTTP {log.httpStatus}</span></div></div>)}</div>
      </> : <EmptyState icon={Activity} title={logs.length ? 'No matching requests' : 'No requests recorded'} detail={logs.length ? 'Change the filter to see other requests.' : 'The gateway is ready. Usage will appear here.'} />}
    </section>
    <div className="mt-4 flex items-center gap-2 text-[11px] text-slate-600"><ShieldCheck size={14} className="text-emerald-400/70" /> Logs contain metadata only. Prompt and completion payloads are excluded.</div>
  </>;
}

function SettingsPage({ settings, overview }: { settings: Settings | null; overview: Overview }) {
  const rows = [
    ['Bind address', `${settings?.host ?? '127.0.0.1'}:${settings?.port ?? 3000}`, 'Gateway listener'],
    ['Admin authentication', 'Enabled', 'Bearer token required for all admin APIs'],
    ['Provider secrets', 'Server only', 'Never returned in API responses'],
    ['Request log capacity', `${settings?.requestLogLimit ?? overview.requestLogLimit} records`, 'Old entries are removed automatically'],
    ['Provider configuration', 'Environment + memory', 'Dashboard changes reset on restart'],
    ['Process uptime', prettyDuration(settings?.uptimeSeconds ?? overview.uptimeSeconds), 'Since last gateway start'],
  ];
  return <>
    <PageHeading eyebrow="GATEWAY CONFIGURATION" title="Settings" description="Security posture and runtime information for this K&apos;sRouter instance." />
    <div className="grid gap-5 xl:grid-cols-[1.3fr_.7fr]">
      <section className="panel"><div className="panel-heading"><div><h2 className="panel-title">Runtime configuration</h2><p className="panel-subtitle">Sensitive environment values are intentionally hidden.</p></div><Settings2 size={17} className="text-slate-600" /></div><div className="divide-y divide-white/[.045]">{rows.map(([label, value, detail]) => <div key={label} className="flex flex-col gap-1.5 py-4 sm:flex-row sm:items-center"><div className="min-w-0 flex-1"><div className="text-sm text-slate-300">{label}</div><div className="mt-1 text-xs text-slate-600">{detail}</div></div><div className="font-mono text-xs text-slate-300 sm:text-right">{value}</div></div>)}</div></section>
      <div className="space-y-4"><div className="panel"><div className="flex items-center gap-3"><div className="rounded-xl border border-emerald-400/10 bg-emerald-400/[.06] p-2.5 text-emerald-300"><ShieldCheck size={18} /></div><div><div className="text-sm font-medium text-slate-200">Security checks</div><div className="mt-1 text-xs text-slate-600">Current admin protections</div></div></div><div className="mt-5 space-y-3">{['Dashboard APIs require admin auth', 'Provider keys are write-only', 'No browser persistence', 'Listener defaults to localhost'].map((item) => <div className="flex items-center gap-2.5 text-xs text-slate-400" key={item}><Check size={14} className="text-emerald-400" />{item}</div>)}</div></div><div className="panel"><div className="flex items-center gap-2 text-sm font-medium text-slate-200"><Activity size={16} className="text-sky-300" />Health check</div><p className="mt-2 text-xs leading-5 text-slate-500">The public health endpoint returns only the gateway process status. It includes no provider or secret details.</p><a href="/health" target="_blank" rel="noreferrer" className="secondary-button mt-4 w-full justify-center">Open /health <ArrowUpRight size={14} /></a></div></div>
    </div>
  </>;
}

function ProviderModal({ provider, error, onClose, onSave }: { provider: Provider | null; error: string; onClose: () => void; onSave: (event: FormEvent<HTMLFormElement>) => void }) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><form className="modal-card" onSubmit={onSave}><div className="flex items-start justify-between"><div><div className="eyebrow">UPSTREAM CONFIGURATION</div><h2 className="mt-2 text-lg font-semibold text-white">{provider ? 'Edit provider' : 'Add provider'}</h2><p className="mt-1 text-xs text-slate-500">API key is sent directly to your local gateway and is never shown again.</p></div><button type="button" onClick={onClose} className="icon-button"><X size={16} /></button></div>
    <div className="mt-5 space-y-4"><label className="field-label">Provider ID<input name="name" required pattern="[A-Za-z0-9_-]+" placeholder="openai" defaultValue={provider?.name} readOnly={Boolean(provider)} className={provider ? 'readonly' : ''} /><span className="field-hint">Letters, numbers, hyphens, underscores.</span></label><label className="field-label">OpenAI-compatible base URL<input name="baseUrl" required type="url" placeholder="https://api.example.com/v1" defaultValue={provider?.baseUrl} /></label><label className="field-label">API key<input name="apiKey" type="password" autoComplete="new-password" placeholder={provider ? 'Leave blank to keep the current key' : 'Paste provider key'} required={!provider} /></label><label className="field-label">Models<input name="models" required placeholder="model-a, model-b" defaultValue={provider?.models.join(', ')} /><span className="field-hint">Comma-separated. Each model must route to one provider only.</span></label></div>
    {error && <div role="alert" className="mt-4 rounded-lg border border-rose-400/15 bg-rose-400/[.06] px-3 py-2.5 text-xs text-rose-200">{error}</div>}
    <div className="mt-6 flex justify-end gap-2"><button className="secondary-button" type="button" onClick={onClose}>Cancel</button><button className="primary-button" type="submit"><Check size={15} /> Save provider</button></div>
  </form></div>;
}

function Login({ candidate, setCandidate, onSubmit, error, loading }: { candidate: string; setCandidate: (value: string) => void; onSubmit: (event: FormEvent) => void; error: string; loading: boolean }) {
  return <main className="login-screen"><div className="login-glow" /><div className="login-card"><Brand /><div className="mt-9"><div className="eyebrow">PRIVATE CONTROL PLANE</div><h1 className="mt-2 text-[25px] font-semibold tracking-[-.04em] text-white">Sign in to your gateway</h1><p className="mt-2 text-sm leading-6 text-slate-500">Enter the admin key configured in your server environment to continue.</p></div><form className="mt-7" onSubmit={onSubmit}><label className="field-label">Admin API key<input type="password" autoComplete="off" value={candidate} onChange={(event) => setCandidate(event.target.value)} placeholder="Your local admin key" /></label>{error && <div className="mt-3 rounded-lg border border-rose-400/15 bg-rose-400/[.06] px-3 py-2.5 text-xs text-rose-200">{error}</div>}<button className="primary-button mt-5 w-full justify-center" disabled={loading || !candidate.trim()}><LockKeyhole size={15} />{loading ? 'Verifying…' : 'Unlock dashboard'}</button></form><div className="mt-5 flex items-center justify-center gap-1.5 text-[10px] text-slate-600"><ShieldCheck size={13} />Key exists in memory only and is not saved in browser storage.</div></div><div className="login-foot">K&apos;sRouter <span>·</span> Local AI gateway</div></main>;
}

function EmptyState({ icon: Icon, title, detail, action }: { icon: typeof Activity; title: string; detail: string; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-icon"><Icon size={19} /></div><div className="mt-3 text-sm font-medium text-slate-300">{title}</div><div className="mt-1 max-w-sm text-xs leading-5 text-slate-600">{detail}</div>{action && <div className="mt-4">{action}</div>}</div>;
}

function StatusDot({ success }: { success: boolean }) { return <span className={`status-dot ${success ? 'success' : 'error'}`} />; }
function formatTime(value: string) { return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function formatDate(value: string) { return new Date(value).toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); }

export default App;
