#!/usr/bin/env node

async function main() {
  const shareUrl = process.argv[2] || 'https://fh.dji.com/share/cpEdxI2hl3C?zone=vg?from=pilot';
  const tabs = await (await fetch('http://127.0.0.1:9222/json')).json();
  const page = tabs.find(t => t.type === 'page' && t.url.includes('/share/')) || tabs.find(t => t.type === 'page');
  if (!page) throw new Error('No CDP page found on 127.0.0.1:9222');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 1;
  const pending = new Map();
  const events = [];
  const responseIds = [];

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const callId = id++;
      pending.set(callId, { resolve, reject, method });
      ws.send(JSON.stringify({ id: callId, method, params }));
      setTimeout(() => {
        if (pending.has(callId)) {
          pending.delete(callId);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 20000);
    });
  }

  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      p.resolve(msg);
      return;
    }
    if (msg.method && msg.method.startsWith('Network.')) {
      events.push(msg);
      if (msg.method === 'Network.responseReceived') {
        const url = msg.params.response && msg.params.response.url || '';
        if (/share\/live\/api\/v3\/(validate-token|devices|streams|rtmp|audience)/i.test(url)) {
          responseIds.push({ requestId: msg.params.requestId, url, status: msg.params.response.status });
        }
      }
    }
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  await send('Network.enable');
  await send('Runtime.enable');

  if (!page.url.includes('/share/')) {
    await send('Page.navigate', { url: shareUrl });
    await new Promise(resolve => setTimeout(resolve, 12000));
  } else {
    await send('Page.reload', { ignoreCache: true });
    await new Promise(resolve => setTimeout(resolve, 12000));
  }

  const expr = `
JSON.stringify({
  url: location.href,
  be: window.CURRENT_BE_ENV_CONFIG || null,
  fe: window.CURRENT_FE_ENV_CONFIG || null,
  sessionStorage: Object.fromEntries(Object.keys(sessionStorage).map(k => [k, sessionStorage.getItem(k)])),
  localStorageInteresting: Object.fromEntries(Object.keys(localStorage)
    .filter(k => /token|share|zone|env|server/i.test(k))
    .map(k => [k, localStorage.getItem(k)]))
})`;
  const state = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });

  const requests = events
    .filter(e => e.method === 'Network.requestWillBeSent')
    .map(e => ({
      url: e.params.request.url,
      method: e.params.request.method,
      headers: e.params.request.headers,
      postData: e.params.request.postData || ''
    }))
    .filter(r => /share|live|rtmp|stream|token|device|flv|m3u8|webrtc|rtc/i.test(r.url));

  const responses = [];
  for (const r of responseIds) {
    try {
      const body = await send('Network.getResponseBody', { requestId: r.requestId });
      responses.push({ ...r, body: body.result.body, base64Encoded: body.result.base64Encoded });
    } catch (err) {
      responses.push({ ...r, error: String(err && err.message || err) });
    }
  }

  console.log(JSON.stringify({
    pageUrl: page.url,
    state: JSON.parse(state.result.result.value),
    requests,
    responses
  }, null, 2));

  ws.close();
}

main().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
