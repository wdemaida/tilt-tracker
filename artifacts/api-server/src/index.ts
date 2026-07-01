import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { clerkMiddleware } from '@clerk/express';

import scoresRouter from './routes/scores.js';
import machinesRouter from './routes/machines.js';
import usersRouter from './routes/users.js';
import uploadRouter from './routes/upload.js';
import statsRouter from './routes/stats.js';
import venuesRouter from './routes/venues.js';
import pinballmapRouter from './routes/pinballmap.js';
import adminRouter from './routes/admin.js';

const app = express();
const PORT = process.env.PORT ?? 3000;

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

app.use('/api/scores', scoresRouter);
app.use('/api/machines', machinesRouter);
app.use('/api/users', usersRouter);
app.use('/api/upload', uploadRouter);
app.use('/api/stats', statsRouter);
app.use('/api/venues', venuesRouter);
app.use('/api/pinballmap', pinballmapRouter);
app.use('/api/admin', adminRouter);

app.listen(PORT, () => console.log(`API server → http://localhost:${PORT}`));
