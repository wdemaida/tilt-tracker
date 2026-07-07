import { Router } from 'express';
import { readFileSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import { db, users, scores, machines, venues, stats, statHistory } from '@workspace/db';
import { desc, asc, count, sql, eq } from 'drizzle-orm';
import { requireAppUser, requireAdmin } from '../middleware/requireAuth.js';
import { getAllMachines } from '../lib/pinballMap.js';
import { captureStatSnapshot } from '../lib/statSnapshot.js';

const router = Router();
router.use(requireAppUser, requireAdmin);

// GET /api/admin/users — full user list
router.get('/users', async (_req, res) => {
  try {
    const rows = await db
      .select({ id: users.id, username: users.username, displayName: users.displayName, role: users.role, createdAt: users.createdAt, pinballMapUsername: users.pinballMapUsername })
      .from(users)
      .orderBy(desc(users.createdAt));
    res.json(rows);
  } catch (err) {
    console.error('admin/users error:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// PATCH /api/admin/users/:id — update a user's role and/or displayName
router.patch('/users/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return void res.status(400).json({ error: 'Invalid user id' });

  const { role, displayName, username } = req.body as { role?: string; displayName?: string; username?: string };
  const allowed = ['admin', 'user'];
  if (role && !allowed.includes(role)) return void res.status(400).json({ error: 'Invalid role' });

  const updates: Record<string, any> = {};
  if (role) updates.role = role;
  if (displayName !== undefined) updates.displayName = displayName.trim();
  if (username !== undefined) updates.username = username.trim();

  if (Object.keys(updates).length === 0) return void res.status(400).json({ error: 'Nothing to update' });

  try {
    const [updated] = await db
      .update(users)
      .set(updates)
      .where(eq(users.id, id))
      .returning({ id: users.id, username: users.username, displayName: users.displayName, role: users.role, createdAt: users.createdAt, pinballMapUsername: users.pinballMapUsername });
    if (!updated) return void res.status(404).json({ error: 'User not found' });
    res.json(updated);
  } catch (err: any) {
    if (err?.code === '23505') return void res.status(409).json({ error: 'Username already taken' });
    console.error('admin/users PATCH error:', err);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// GET /api/admin/health — system health dashboard data
router.get('/health', async (_req, res) => {
  // --- Database check (includes size) ---
  const dbCheck = await (async () => {
    const start = Date.now();
    try {
      const [versionResult, sizeResult] = await Promise.all([
        db.execute(sql`SELECT version()`),
        db.execute(sql`SELECT pg_database_size(current_database()) as size_bytes`),
      ]);
      const latencyMs = Date.now() - start;
      const postgresVersion = (versionResult[0] as any)?.version?.split(' ').slice(0, 2).join(' ') ?? 'unknown';
      const sizeBytes = Number((sizeResult[0] as any)?.size_bytes ?? 0);
      const [sc, mc, vc, uc] = await Promise.all([
        db.select({ total: count() }).from(scores),
        db.select({ total: count() }).from(machines),
        db.select({ total: count() }).from(venues),
        db.select({ total: count() }).from(users),
      ]);
      return {
        status: 'ok' as const,
        latencyMs,
        postgresVersion,
        sizeBytes,
        counts: { scores: sc[0].total, machines: mc[0].total, venues: vc[0].total, users: uc[0].total },
      };
    } catch (err) {
      return { status: 'error' as const, latencyMs: Date.now() - start, error: String(err) };
    }
  })();

  // --- External service checks (run in parallel) ---
  const [hereCheck, pmCheck, anthropicCheck, clerkCheck, githubCheck, vercelCheck] = await Promise.all([
    // HERE API
    (async () => {
      const key = process.env.HERE_API_KEY;
      if (!key) return { status: 'unchecked' as const, note: 'HERE_API_KEY not set' };
      const start = Date.now();
      try {
        const r = await fetch(`https://browse.search.hereapi.com/v1/browse?at=40.7484,-73.9967&limit=1&apiKey=${key}`, { signal: AbortSignal.timeout(5000) });
        const latencyMs = Date.now() - start;
        return r.ok ? { status: 'ok' as const, latencyMs } : { status: 'error' as const, latencyMs, error: `HTTP ${r.status}` };
      } catch (err) {
        return { status: 'error' as const, latencyMs: Date.now() - start, error: String(err) };
      }
    })(),

    // Pinball Map cache
    (async () => {
      try {
        const all = await getAllMachines();
        return all.length > 0
          ? { status: 'ok' as const, machineCount: all.length }
          : { status: 'error' as const, error: 'Cache empty' };
      } catch (err) {
        return { status: 'error' as const, error: String(err) };
      }
    })(),

    // Anthropic — live key verification via /v1/models
    (async () => {
      const key = process.env.ANTHROPIC_API_KEY;
      const model = 'claude-sonnet-4-6';
      if (!key) return { status: 'error' as const, note: 'ANTHROPIC_API_KEY not set', model };
      const start = Date.now();
      try {
        const r = await fetch('https://api.anthropic.com/v1/models', {
          headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
          signal: AbortSignal.timeout(5000),
        });
        const latencyMs = Date.now() - start;
        return r.ok
          ? { status: 'ok' as const, latencyMs, note: 'Key verified', model }
          : { status: 'error' as const, latencyMs, error: `HTTP ${r.status}`, model };
      } catch (err) {
        return { status: 'error' as const, latencyMs: Date.now() - start, error: String(err), model };
      }
    })(),

    // Clerk — live key verification via backend API
    (async () => {
      const key = process.env.CLERK_SECRET_KEY;
      if (!key) return { status: 'error' as const, note: 'CLERK_SECRET_KEY not set' };
      const start = Date.now();
      try {
        const r = await fetch('https://api.clerk.com/v1/users?limit=1', {
          headers: { 'Authorization': `Bearer ${key}` },
          signal: AbortSignal.timeout(5000),
        });
        const latencyMs = Date.now() - start;
        return r.ok
          ? { status: 'ok' as const, latencyMs, note: 'Key verified' }
          : { status: 'error' as const, latencyMs, error: `HTTP ${r.status}` };
      } catch (err) {
        return { status: 'error' as const, latencyMs: Date.now() - start, error: String(err) };
      }
    })(),

    // GitHub — repo check (public) or graceful fallback for private repos
    (async () => {
      const start = Date.now();
      try {
        const ghHeaders: Record<string, string> = { 'User-Agent': 'tilttrack-health-check' };
        if (process.env.GITHUB_TOKEN) ghHeaders['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
        const r = await fetch('https://api.github.com/repos/wdemaida/tilt-tracker', {
          headers: ghHeaders,
          signal: AbortSignal.timeout(5000),
        });
        const latencyMs = Date.now() - start;
        if (r.ok) {
          const data = await r.json() as any;
          const pushed = new Date(data.pushed_at).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
          return { status: 'ok' as const, latencyMs, note: `Last push ${pushed}` };
        }
        if (r.status === 404 || r.status === 403) {
          // 404 = private repo (no token), 403 = rate-limited (no token) — fall back to server start time
          const deployedAt = new Date(Date.now() - process.uptime() * 1000)
            .toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
          const reason = r.status === 403 ? 'Rate limited' : 'Private repo';
          return { status: 'ok' as const, latencyMs, note: `${reason} · live as of ${deployedAt}` };
        }
        return { status: 'error' as const, latencyMs, error: `HTTP ${r.status}` };
      } catch (err) {
        return { status: 'error' as const, latencyMs: Date.now() - start, error: String(err) };
      }
    })(),

    // Vercel — frontend production URL ping
    (async () => {
      const start = Date.now();
      try {
        const r = await fetch('https://tilttrack.vercel.app', {
          method: 'HEAD',
          signal: AbortSignal.timeout(5000),
        });
        const latencyMs = Date.now() - start;
        return r.ok
          ? { status: 'ok' as const, latencyMs, note: 'Frontend reachable' }
          : { status: 'error' as const, latencyMs, error: `HTTP ${r.status}` };
      } catch (err) {
        return { status: 'error' as const, latencyMs: Date.now() - start, error: String(err) };
      }
    })(),
  ]);

  // --- Env vars ---
  const ENV_DEFS = [
    { name: 'DATABASE_URL',          label: 'Database URL',       service: 'Neon',        urlType: true },
    { name: 'ANTHROPIC_API_KEY',     label: 'API Key',            service: 'Anthropic',   urlType: false },
    { name: 'HERE_API_KEY',          label: 'API Key',            service: 'HERE',        urlType: false },
    { name: 'CLERK_SECRET_KEY',      label: 'Secret Key',         service: 'Clerk',       urlType: false },
    { name: 'CLERK_PUBLISHABLE_KEY', label: 'Publishable Key',    service: 'Clerk',       urlType: false },
    { name: 'FRONTEND_URL',          label: 'Frontend URL (CORS)',service: 'Server',      urlType: true },
    { name: 'PORT',                  label: 'Server Port',        service: 'Server',      urlType: false },
  ];
  const envVars = ENV_DEFS.map(({ name, label, service, urlType }) => {
    const val = process.env[name];
    return {
      name,
      label,
      service,
      isSet: !!val,
      masked: val
        ? (urlType ? 'configured' : (name === 'PORT' ? val : `...${val.slice(-4)}`))
        : null,
    };
  });

  // --- Server info ---
  const server = {
    uptimeSeconds: Math.floor(process.uptime()),
    nodeVersion: process.version,
    memoryMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    platform: process.platform,
  };

  // --- Frontend info (read package.json) ---
  let frontend = { viteVersion: 'unknown', port: process.env.FRONTEND_URL?.includes('5174') ? '5174' : '5173', https: true };
  try {
    const pkgPath = join(process.cwd(), '../pinball-tracker/package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    frontend.viteVersion = pkg.devDependencies?.vite ?? pkg.dependencies?.vite ?? 'unknown';
  } catch { /* non-fatal */ }

  // --- Service summary ---
  const services = [
    { id: 'anthropic', name: 'Anthropic AI', ...anthropicCheck },
    { id: 'here',      name: 'HERE Maps',    ...hereCheck },
    { id: 'pm',        name: 'Pinball Map',  ...pmCheck },
    { id: 'clerk',     name: 'Clerk Auth',   ...clerkCheck },
    { id: 'github',    name: 'GitHub',       ...githubCheck },
    { id: 'vercel',    name: 'Vercel',       ...vercelCheck },
    { id: 'render',    name: 'Render',       status: 'ok' as const, note: 'API server is running here' },
  ];

  res.json({ server, database: dbCheck, services, envVars, frontend });
});

// POST /api/admin/drizzle-studio/start — spawn `drizzle-kit studio` on this machine (local dev only)
router.post('/drizzle-studio/start', async (_req, res) => {
  if (process.env.RENDER) {
    return void res.status(403).json({ error: 'Drizzle Studio can only be launched from a local dev server, not Render' });
  }

  // Drizzle Studio's local API listens on 4983 — if it's already answering, don't spawn a second instance.
  try {
    await fetch('http://localhost:4983', { signal: AbortSignal.timeout(800) });
    return void res.json({ status: 'already-running' });
  } catch {
    // not reachable yet — fall through and spawn it
  }

  const dbDir = join(process.cwd(), '../../lib/db');
  const child = spawn('pnpm', ['run', 'db:studio'], {
    cwd: dbDir,
    shell: true,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  res.json({ status: 'starting' });
});

// GET /api/admin/stats — stat definitions (label/key/description) managed here so the
// StatHistory snapshot job can reference a stable id instead of a hardcoded name.
router.get('/stats', async (_req, res) => {
  try {
    const rows = await db.select().from(stats).orderBy(asc(stats.id));
    res.json(rows);
  } catch (err) {
    console.error('admin/stats GET error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// GET /api/admin/stats/history?days=60 — recent stat_history rows, most recent first
router.get('/stats/history', async (req, res) => {
  const days = Math.min(Number(req.query.days) || 60, 365);
  try {
    const rows = await db
      .select({
        id: statHistory.id,
        statId: statHistory.statId,
        key: stats.key,
        label: stats.label,
        value: statHistory.value,
        periodDate: statHistory.periodDate,
      })
      .from(statHistory)
      .innerJoin(stats, eq(statHistory.statId, stats.id))
      .orderBy(desc(statHistory.periodDate))
      .limit(days * 10); // generous cap regardless of how many stat definitions exist
    res.json(rows);
  } catch (err) {
    console.error('admin/stats/history GET error:', err);
    res.status(500).json({ error: 'Failed to fetch stat history' });
  }
});

// POST /api/admin/stats/snapshot — manually run today's snapshot (also the way to verify the
// 1am cron job's logic without waiting for it, or to backfill today's row after adding a stat)
router.post('/stats/snapshot', async (_req, res) => {
  try {
    const result = await captureStatSnapshot();
    res.json(result);
  } catch (err) {
    console.error('admin/stats/snapshot error:', err);
    res.status(500).json({ error: 'Failed to capture snapshot' });
  }
});

// PATCH /api/admin/stats/:id — rename/redescribe a stat. `key` is intentionally not editable here —
// it's the stable identifier the snapshot job matches against, so renaming it would silently stop
// that stat from ever getting new history rows.
router.patch('/stats/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { label, description } = req.body as { label?: string; description?: string };

  const updates: Record<string, any> = {};
  if (label !== undefined) updates.label = label.trim();
  if (description !== undefined) updates.description = description.trim() || null;
  if (Object.keys(updates).length === 0) return void res.status(400).json({ error: 'Nothing to update' });

  try {
    const [updated] = await db.update(stats).set(updates).where(eq(stats.id, id)).returning();
    if (!updated) return void res.status(404).json({ error: 'Stat not found' });
    res.json(updated);
  } catch (err) {
    console.error('admin/stats PATCH error:', err);
    res.status(500).json({ error: 'Failed to update stat' });
  }
});

// DELETE /api/admin/stats/:id — blocked if any history rows reference it
router.delete('/stats/:id', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const [{ total }] = await db.select({ total: count() }).from(statHistory).where(eq(statHistory.statId, id));
    if (total > 0) {
      return void res.status(409).json({ error: `Cannot delete — ${total} history row${total === 1 ? '' : 's'} reference this stat` });
    }
    await db.delete(stats).where(eq(stats.id, id));
    res.status(204).send();
  } catch (err) {
    console.error('admin/stats DELETE error:', err);
    res.status(500).json({ error: 'Failed to delete stat' });
  }
});

export default router;
