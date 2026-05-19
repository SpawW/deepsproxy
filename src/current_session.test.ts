import test from 'node:test';
import assert from 'node:assert';
import { app } from './index.ts';

test('current_session_streaming: uses existing Playwright session (requires RUN_REAL_BROWSER_TESTS=1)', async () => {
  // Diagnostic: print the Playwright address the process will use
  console.log('DEBUG PLAYWRIGHT_REMOTE_URL=', process.env.PLAYWRIGHT_REMOTE_URL);
  console.log('DEBUG PLAYWRIGHT_SERVICE_PORT=', process.env.PLAYWRIGHT_SERVICE_PORT);
  if (process.env.RUN_REAL_BROWSER_TESTS !== '1') {
    return;
  }

  const payload = {
    model: 'deepseek-thinking',
    messages: [{ role: 'user', content: 'Say hello in one short sentence.' }],
    stream: true
  };

  const port = process.env.PORT || '3000';
  const apiHost = process.env.API_HOST || 'localhost';
  const reqUrl = `http://${apiHost}:${port}/v1/chat/completions`;
  console.log('DEBUG TEST REQ URL=', reqUrl);
  const req = new Request(reqUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const res = await app.fetch(req);
  assert.strictEqual(res.status, 200);
  // Expect streaming SSE from the proxy
  assert.strictEqual(res.headers.get('Content-Type'), 'text/event-stream');

  const reader = res.body?.getReader();
  assert.ok(reader, 'Response should have a readable body');

  const decoder = new TextDecoder();
  let collected = '';

  while (true) {
    const { done, value } = await reader!.read();
    if (done) break;
    const chunk = decoder.decode(value);
    for (const line of chunk.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const dataStr = line.slice(6);
      if (dataStr === '[DONE]') break;
      try {
        const data = JSON.parse(dataStr);
        const delta = data.choices?.[0]?.delta;
        if (delta?.content) collected += delta.content;
      } catch (e) {
        // ignore partial JSON
      }
    }
  }

  assert.ok(collected.length > 0, 'Expected model to emit some content using existing browser session');
});
