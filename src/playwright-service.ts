import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import * as dotenv from 'dotenv';
import { initPlaywright, getDeepSeekHeaders, closePlaywright } from './services/playwright.ts';

dotenv.config();

const app = new Hono();

// Tracks whether the browser is ready to serve requests
let browserReady = false;
let browserError: string | null = null;

app.get('/health', (c) => {
  if (!browserReady) {
    return c.json({ status: browserError ? 'error' : 'starting', error: browserError }, browserError ? 503 : 503);
  }
  return c.json({ status: 'ok' });
});

app.post('/headers', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const forceNew = !!body.forceNew;
  try {
    await initPlaywright(process.env.PLAYWRIGHT_HEADLESS !== 'false');
    const res = await getDeepSeekHeaders(forceNew);
    return c.json(res);
  } catch (err: any) {
    return c.json({ error: String(err.message || err) }, 500);
  }
});

const port = process.env.PLAYWRIGHT_SERVICE_PORT ? parseInt(process.env.PLAYWRIGHT_SERVICE_PORT) : 9301;
process.env.PORT = String(port);

serve({ fetch: app.fetch, port });

console.log(`Playwright service listening on :${port}`);

// Eagerly initialize browser so it's ready on first request
const headless = process.env.PLAYWRIGHT_HEADLESS !== 'false';
initPlaywright(headless)
  .then(() => {
    browserReady = true;
    browserError = null;
    console.log('[playwright-service] Browser initialized and ready.');
  })
  .catch((err) => {
    browserError = String(err?.message || err);
    console.error('[playwright-service] Failed to initialize browser on startup:', browserError);
  });

process.on('SIGINT', async () => {
  console.log('Playwright service shutting down...');
  try {
    await closePlaywright();
  } catch (e) {
    console.error(e);
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Playwright service shutting down (SIGTERM)...');
  try {
    await closePlaywright();
  } catch (e) {
    console.error(e);
  }
  process.exit(0);
});
