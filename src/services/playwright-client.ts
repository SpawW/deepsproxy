import { getDeepSeekHeaders as localGetDeepSeekHeaders } from './playwright.ts';

const remoteUrl = process.env.PLAYWRIGHT_REMOTE_URL;

export async function getDeepSeekHeaders(forceNew = false) {
  if (remoteUrl) {
    const resp = await fetch(`${remoteUrl.replace(/\/$/, '')}/headers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ forceNew })
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error(`Playwright remote service error: ${resp.status} ${resp.statusText} - ${txt}`);
    }
    return resp.json();
  }

  return localGetDeepSeekHeaders(forceNew);
}

export default { getDeepSeekHeaders };
