import { Router } from 'express';
import { readFileSync } from 'fs';
import { join } from 'path';
import { db, users, scores, machines, venues } from '@workspace/db';
import { desc, count, sql } from 'drizzle-orm';
import { requireAppUser, requireAdmin } from '../middleware/requireAuth.js';
import { getAllMachines } from '../lib/pinballMap.js';

const router = Router();
router.use(requireAppUser, requireAdmin);

// GET /api/admin/users — full user list
router.get('/users', async (_req, res) => {
  try {
    const rows = await db
      .select({ id: users.id, username: users.username, displayName: users.displayName, role: users.role, createdAt: users.createdAt })
      .from(users)
      .orderBy(desc(users.createdAt));
    res.json(rows);
  } catch (err) {
    console.error('admin/users error:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// GET /api/admin/health — system health dashboard data
router.get('/health', async (_req, res) => {
  // --- Database check ---
  const dbCheck = await (async () => {
    const start = Date.now();
    try {
      const versionResult = await db.execute(sql`SELECT version()`);
      const latencyMs = Date.now() - start;
      const postgresVersion = (versionResult[0] as any)?.version?.split(' ').slice(0, 2).join(' ') ?? 'unknown';
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
        counts: { scores: sc[0].total, machines: mc[0].total, venues: vc[0].total, users: uc[0].total },
      };
    } catch (err) {
      return { status: 'error' as const, latencyMs: Date.now() - start, error: String(err) };
    }
  })();

  // --- HERE API check ---
  const hereCheck = await (async () => {
    const key = process.env.HERE_API_KEY;
    if (!key) return { status: 'unchecked' as const, note: 'HERE_API_KEY not set' };
    const start = Date.now();
    try {
      const url = `https://browse.search.hereapi.com/v1/browse?at=40.7484,-73.9967&limit=1&apiKey=${key}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const latencyMs = Date.now() - start;
      return r.ok
        ? { status: 'ok' as const, latencyMs }
        : { status: 'error' as const, latencyMs, error: `HTTP ${r.status}` };
    } catch (err) {
      return { status: 'error' as const, latencyMs: Date.now() - start, error: String(err) };
    }
  })();

  // --- Pinball Map cache check ---
  const pmCheck = await (async () => {
    try {
      const all = await getAllMachines();
      return all.length > 0
        ? { status: 'ok' as const, machineCount: all.length }
        : { status: 'error' as const, error: 'Cache empty' };
    } catch (err) {
      return { status: 'error' as const, error: String(err) };
    }
  })();

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
    { id: 'anthropic', name: 'Anthropic AI', status: process.env.ANTHROPIC_API_KEY ? 'ok' : 'error', note: process.env.ANTHROPIC_API_KEY ? 'Key configured' : 'ANTHROPIC_API_KEY missing' },
    { id: 'here',      name: 'HERE Maps',    ...hereCheck },
    { id: 'pm',        name: 'Pinball Map',  ...pmCheck },
    { id: 'clerk',     name: 'Clerk Auth',   status: (process.env.CLERK_SECRET_KEY && process.env.CLERK_PUBLISHABLE_KEY) ? 'ok' : 'error', note: (process.env.CLERK_SECRET_KEY && process.env.CLERK_PUBLISHABLE_KEY) ? 'Keys configured' : 'One or more keys missing' },
  ];

  res.json({ server, database: dbCheck, services, envVars, frontend });
});

export default router;
