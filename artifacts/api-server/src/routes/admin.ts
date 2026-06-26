import { Router } from 'express';
import { readFileSync } from 'fs';
import { join } from 'path';
import { db, users, scores, machines, venues } from '@workspace/db';
import { desc, count, sql, eq } from 'drizzle-orm';
import { requireAppUser, requireAdmin } from '../middleware/requireAuth.js';
import { getAllMachines } from '../lib/pinballMap.js';

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

    // GitHub — public repo accessibility
    (async () => {
      const start = Date.now();
      try {
        const r = await fetch('https://api.github.com/repos/wdemaida/tilt-tracker', {
          headers: { 'User-Agent': 'tilttrack-health-check' },
          signal: AbortSignal.timeout(5000),
        });
        const latencyMs = Date.now() - start;
        if (r.ok) {
          const data = await r.json() as any;
          const pushed = new Date(data.pushed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          return { status: 'ok' as const, latencyMs, note: `Last push ${pushed}` };
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
  ];

  res.json({ server, database: dbCheck, services, envVars, frontend });
});

export default router;
