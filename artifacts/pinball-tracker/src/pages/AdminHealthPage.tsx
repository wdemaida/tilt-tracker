import { useQuery } from '@tanstack/react-query';
import { Link, useLocation } from 'wouter';
import { ShieldCheck, RefreshCw, CheckCircle2, XCircle, HelpCircle, Database, Server, Cpu } from 'lucide-react';
import { useApi } from '../lib/useApi';

function StatusDot({ status }: { status: 'ok' | 'error' | 'unchecked' }) {
  if (status === 'ok') return <span className="w-2.5 h-2.5 rounded-full bg-green-400 flex-shrink-0 shadow-[0_0_6px_#4ade80]" />;
  if (status === 'error') return <span className="w-2.5 h-2.5 rounded-full bg-red-400 flex-shrink-0" />;
  return <span className="w-2.5 h-2.5 rounded-full bg-yellow-400 flex-shrink-0" />;
}

function StatusIcon({ status }: { status: 'ok' | 'error' | 'unchecked' }) {
  if (status === 'ok') return <CheckCircle2 className="w-4 h-4 text-green-400" />;
  if (status === 'error') return <XCircle className="w-4 h-4 text-red-400" />;
  return <HelpCircle className="w-4 h-4 text-yellow-400" />;
}

function formatUptime(seconds: number) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function AdminNav() {
  const [location] = useLocation();
  const tabs = [
    { href: '/admin', label: 'Users' },
    { href: '/admin/health', label: 'Health' },
  ];
  return (
    <div className="flex gap-1 border-b border-white/10 mb-8">
      {tabs.map(t => (
        <Link key={t.href} href={t.href} className={`px-4 py-2.5 text-sm font-bold uppercase tracking-wider border-b-2 -mb-px transition-colors ${
          location === t.href ? 'border-primary text-white' : 'border-transparent text-muted-foreground hover:text-white'
        }`}>{t.label}</Link>
      ))}
    </div>
  );
}

export default function AdminHealthPage() {
  const api = useApi();

  const { data, isLoading, isFetching, refetch, dataUpdatedAt } = useQuery({
    queryKey: ['admin-health'],
    queryFn: () => api.admin.health(),
    staleTime: 0,
    refetchOnWindowFocus: false,
  });

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <ShieldCheck className="w-7 h-7 text-primary" />
          <h1 className="text-3xl font-black uppercase tracking-widest text-white">Admin</h1>
        </div>
        <div className="flex items-center gap-3">
          {dataUpdatedAt > 0 && (
            <span className="text-xs text-muted-foreground">
              Updated {new Date(dataUpdatedAt).toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-white/10 text-sm text-muted-foreground hover:text-white hover:border-white/30 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      <AdminNav />

      {isLoading ? (
        <p className="text-muted-foreground text-sm">Running health checks...</p>
      ) : !data ? (
        <p className="text-red-400 text-sm">Failed to load health data.</p>
      ) : (
        <div className="flex flex-col gap-8">

          {/* Database */}
          <section>
            <h2 className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3 flex items-center gap-2">
              <Database className="w-3.5 h-3.5" /> Database
            </h2>
            <div className="rounded-xl border border-white/10 bg-card p-5">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2.5">
                  <StatusDot status={data.database.status} />
                  <span className="font-black uppercase tracking-wider text-white">Neon PostgreSQL</span>
                </div>
                <div className="flex items-center gap-3 text-sm">
                  {data.database.status === 'ok' && (
                    <>
                      <span className="text-muted-foreground">{data.database.postgresVersion}</span>
                      <span className="text-green-400 font-medium">{data.database.latencyMs} ms</span>
                    </>
                  )}
                  {data.database.status === 'error' && (
                    <span className="text-red-400 text-xs">{data.database.error}</span>
                  )}
                </div>
              </div>
              {data.database.status === 'ok' && (
                <div className="grid grid-cols-4 gap-3">
                  {Object.entries(data.database.counts).map(([table, n]) => (
                    <div key={table} className="rounded-lg bg-white/5 border border-white/10 p-3 text-center">
                      <p className="text-2xl font-black text-primary">{n as number}</p>
                      <p className="text-xs text-muted-foreground uppercase tracking-wider mt-0.5">{table}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          {/* External Services */}
          <section>
            <h2 className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3 flex items-center gap-2">
              <Server className="w-3.5 h-3.5" /> External Services
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {(data.services as any[]).map((svc: any) => (
                <div key={svc.id} className="rounded-xl border border-white/10 bg-card p-4 flex items-start gap-3">
                  <StatusDot status={svc.status} />
                  <div className="min-w-0 flex-1">
                    <p className="font-black uppercase tracking-wider text-white text-sm">{svc.name}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {svc.latencyMs != null && <span className="text-green-400 mr-2">{svc.latencyMs} ms</span>}
                      {svc.note ?? (svc.status === 'ok' ? 'OK' : svc.error ?? 'Error')}
                      {svc.machineCount != null && ` · ${Number(svc.machineCount).toLocaleString()} machines cached`}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Server + Frontend */}
          <section>
            <h2 className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3 flex items-center gap-2">
              <Cpu className="w-3.5 h-3.5" /> Runtime
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="rounded-xl border border-white/10 bg-card p-4">
                <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-3">API Server</p>
                <div className="flex flex-col gap-2">
                  {[
                    ['Uptime',   formatUptime(data.server.uptimeSeconds)],
                    ['Node.js',  data.server.nodeVersion],
                    ['Memory',   `${data.server.memoryMb} MB heap`],
                    ['Platform', data.server.platform],
                  ].map(([k, v]) => (
                    <div key={k} className="flex justify-between text-sm">
                      <span className="text-muted-foreground">{k}</span>
                      <span className="text-white font-medium">{v}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="rounded-xl border border-white/10 bg-card p-4">
                <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-3">Frontend (Vite)</p>
                <div className="flex flex-col gap-2">
                  {[
                    ['Version', data.frontend.viteVersion],
                    ['Port',    data.frontend.port],
                    ['HTTPS',   data.frontend.https ? 'Enabled' : 'Disabled'],
                    ['Status',  'Running (you\'re here)'],
                  ].map(([k, v]) => (
                    <div key={k} className="flex justify-between text-sm">
                      <span className="text-muted-foreground">{k}</span>
                      <span className={`font-medium ${k === 'Status' ? 'text-green-400' : 'text-white'}`}>{v as string}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>

          {/* Environment Variables */}
          <section>
            <h2 className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3">Environment Variables</h2>
            <div className="rounded-xl border border-white/10 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10 bg-white/5">
                    <th className="text-left px-4 py-3 text-xs font-bold uppercase tracking-wider text-muted-foreground">Variable</th>
                    <th className="text-left px-4 py-3 text-xs font-bold uppercase tracking-wider text-muted-foreground">Service</th>
                    <th className="text-left px-4 py-3 text-xs font-bold uppercase tracking-wider text-muted-foreground">Status</th>
                    <th className="text-left px-4 py-3 text-xs font-bold uppercase tracking-wider text-muted-foreground">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.envVars as any[]).map((v: any) => (
                    <tr key={v.name} className="border-b border-white/5 last:border-0 hover:bg-white/5">
                      <td className="px-4 py-3 font-mono text-xs text-white">{v.name}</td>
                      <td className="px-4 py-3 text-muted-foreground">{v.service}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1.5">
                          <StatusIcon status={v.isSet ? 'ok' : 'error'} />
                          <span className={`text-xs font-medium ${v.isSet ? 'text-green-400' : 'text-red-400'}`}>
                            {v.isSet ? 'Set' : 'Missing'}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                        {v.masked ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

        </div>
      )}
    </div>
  );
}
