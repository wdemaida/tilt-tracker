import { Router } from 'express';
import { publicWelcomeContent, PUBLIC_CACHE_TTL_MS } from '../lib/siteContent.js';

// Public, unauthenticated reads of admin-edited page copy (lib/siteContent.ts). Mounted at /api/content.
const router = Router();

// GET /api/content/welcome — {key: value} for the welcome.* sections an admin has overridden. Keys
// with no override are absent: the page shows its built-in default for those. Never 500s — a DB
// problem returns {} and the page renders its defaults.
router.get('/welcome', async (_req, res) => {
  const value = await publicWelcomeContent();
  res.set('Cache-Control', `public, max-age=${Math.round(PUBLIC_CACHE_TTL_MS / 1000)}`);
  res.json(value);
});

export default router;
