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
app.use(cors({ origin: (origin, cb) => cb(null, !origin || allowedOrigins.some(o => origin.startsWith(o))), credentials: true }));
app.use(express.json());
app.use(clerkMiddleware());

app.use('/api/scores', scoresRouter);
app.use('/api/machines', machinesRouter);
app.use('/api/users', usersRouter);
app.use('/api/upload', uploadRouter);
app.use('/api/stats', statsRouter);
app.use('/api/venues', venuesRouter);
app.use('/api/pinballmap', pinballmapRouter);
app.use('/api/admin', adminRouter);

app.listen(PORT, () => console.log(`API server → http://localhost:${PORT}`));
