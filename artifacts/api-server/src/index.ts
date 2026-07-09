import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { clerkMiddleware } from '@clerk/express';

import scoresRouter from './routes/scores.js';
import machinesRouter from './routes/machines.js';
import usersRouter from './routes/users.js';
import uploadRouter from './routes/upload.js';
import statsRouter from './routes/stats.js';
import venuesRouter from './routes/venues.js';
import pinballmapRouter from './routes/pinballmap.js';
import adminRouter from './routes/admin.js';
import { captureStatSnapshot } from './lib/statSnapshot.js';

const app = express();
const PORT = process.env.PORT ?? 3001;

const allowedOrigins = (process.env.FRONTEND_URL ?? 'http://localhost:5173,http://localhost:5174').split(',');
// The Drizzle Studio launcher is a loopback-only dev tool (blocked on Render via process.env.RENDER,
// and still gated by Clerk admin auth) — it needs to be callable from the deployed Vercel origin too,
// since the button lives on the same admin page whether you're on localhost or the live site.
app.use(cors((req, cb) => {
  const isDrizzleStudioRoute = req.path === '/api/admin/drizzle-studio/start';
  const origin = req.header('Origin');
  const allowed = isDrizzleStudioRoute || !origin || allowedOrigins.some(o => origin.startsWith(o));
  cb(null, { origin: allowed, credentials: true });
}));
app.use(express.json({ limit: '2mb' }));
app.use(clerkMiddleware());

app.get('/ping', (_req, res) => res.status(200).send('ok'));

// POST /api/cron/stat-snapshot — external-cron entry point for the daily StatHistory snapshot.
// Render's free tier spins the process down when idle, so the in-process 1am node-cron job below
// only fires if something happened to keep the dyno warm through that window — it often doesn't.
// This route lets a GitHub Actions schedule hit the live URL directly (which also wakes the dyno),
// so the snapshot no longer depends on the process already being alive at 1am. Guarded by a shared
// secret instead of Clerk auth since the caller is a cron job, not a logged-in admin.
app.post('/api/cron/stat-snapshot', async (req, res) => {
  if (!process.env.CRON_SECRET) return void res.status(500).json({ error: 'CRON_SECRET not configured' });
  if (req.header('x-cron-secret') !== process.env.CRON_SECRET) return void res.status(401).json({ error: 'Unauthorized' });
  try {
    const result = await captureStatSnapshot();
    res.json(result);
  } catch (err) {
    console.error('Cron stat snapshot error:', err);
    res.status(500).json({ error: 'Failed to capture snapshot' });
  }
});

app.use('/api/scores', scoresRouter);
app.use('/api/machines', machinesRouter);
app.use('/api/users', usersRouter);
app.use('/api/upload', uploadRouter);
app.use('/api/stats', statsRouter);
app.use('/api/venues', venuesRouter);
app.use('/api/pinballmap', pinballmapRouter);
app.use('/api/admin', adminRouter);

// Backup in-process trigger for the same snapshot — fires if the dyno happens to already be warm
// at 1am America/New_York. The GitHub Actions workflow calling /api/cron/stat-snapshot above is the
// primary mechanism now; this is harmless to leave running since captureStatSnapshot() upserts.
cron.schedule('0 1 * * *', () => {
  captureStatSnapshot().catch(err => console.error('Stat snapshot job failed:', err));
}, { timezone: 'America/New_York' });

app.listen(PORT, () => console.log(`API server → http://localhost:${PORT}`));
