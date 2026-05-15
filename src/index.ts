/*
 * File: index.ts
 * Project: deepsproxy
 * Author: Pedro Farias
 * Created: 2026-05-09
 * 
 * Last Modified: Sat May 09 2026
 * Modified By: Pedro Farias
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { chatCompletions } from './routes/chat.ts';
import * as dotenv from 'dotenv';
import { initPlaywright, closePlaywright } from './services/playwright.ts';

dotenv.config();

export const app = new Hono();

app.use('*', cors());

app.use('*', async (c, next) => {
  const apiKey = process.env.API_KEY;
  if (apiKey) {
    const authHeader = c.req.header('Authorization');
    const xApiKey = c.req.header('X-API-Key');
    const providedKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : xApiKey;
    if (!providedKey || providedKey !== apiKey) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
  }
  await next();
});

// Basic health check
app.get('/health', (c) => c.json({ status: 'ok' }));

// OpenAI compatible routes (with and without /v1 prefix)
app.post('/v1/chat/completions', chatCompletions);
app.post('/chat/completions', chatCompletions);

app.get('/v1/models', (c) => {
  return c.json({
    object: 'list',
    data: [
      {
        id: 'deepseek-thinking',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'deepseek',
        permission: [],
        root: 'deepseek-thinking',
        parent: null,
      },
      {
        id: 'deepseek-no-thinking',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'deepseek',
        permission: [],
        root: 'deepseek-no-thinking',
        parent: null,
      }
    ]
  });
});

// Initialize playwright when server starts
import { fileURLToPath } from 'url';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const remote = process.env.PLAYWRIGHT_REMOTE_URL;
  const headless = process.env.PLAYWRIGHT_HEADLESS === 'false' ? false : true;
  const maybeInit = remote ? Promise.resolve() : initPlaywright(headless);
  maybeInit.then(() => {
    console.log('Playwright initialized.');
    const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
    console.log(`Server is running on port ${port}`);

    serve({
      fetch: app.fetch,
      port
    });
  }).catch((err: any) => {
    console.error('Failed to initialize playwright:', err);
    process.exit(1);
  });
  
  // Gracefully handle termination signals to allow Playwright to persist profile
  const gracefulShutdown = async (signal: string) => {
    console.log(`Received ${signal}, shutting down...`);
    try {
      await closePlaywright();
      console.log('Playwright closed.');
    } catch (e) {
      console.error('Error closing Playwright:', e);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}
