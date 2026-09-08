#!/usr/bin/env node

async function main() {
  const tabs = await (await fetch('http://127.0.0.1:9222/json')).json();
  const page = tabs.find(t => t.type === 'page' && t.url.includes('/share/live/')) ||
    tabs.find(t => t.type === 'page' && t.url.includes('/share/'));
  if (!page) throw new Error('No FlightHub share page found on CDP port 9222');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 1;
  const pending = new Map();
  const captured = [];

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
    if (msg.method === 'Network.requestWillBeSent') {
      const r = msg.params.request;
      if (/share\/live\/api\/v3\/(streams|rtmp|audience)/i.test(r.url)) {
        captured.push({ url: r.url, method: r.method, headers: r.headers, postData: r.postData || '' });
      }
    }
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  await send('Network.enable');
  await send('Runtime.enable');

  const dump = await send('Runtime.evaluate', {
    returnByValue: true,
    awaitPromise: true,
    expression: `
(() => {
  const visible = el => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const nodes = [...document.querySelectorAll('button, [role=button], .device, .camera, .live, div, span')]
    .filter(visible)
    .map((el, i) => {
      const r = el.getBoundingClientRect();
      return { i, tag: el.tagName, cls: el.className, text: (el.innerText || el.textContent || '').trim().slice(0, 120), x: r.x, y: r.y, w: r.width, h: r.height };
    })
    .filter(x => /Matrice|H30|红外|广角|变焦|IR|Zoom|Wide|直播|Live|live/i.test(x.text + ' ' + x.cls))
    .slice(0, 80);
  return JSON.stringify(nodes);
})()`
  });
  console.log('DOM_CANDIDATES');
  console.log(dump.result.result.value);

  const xyArg = process.argv.find(a => a.startsWith('--xy='));
  let clickResult;
  if (xyArg) {
    const [x, y] = xyArg.slice(5).split(',').map(Number);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await new Promise(r => setTimeout(r, 15000));
    clickResult = { result: { result: { value: `xy:${x},${y}` } } };
  } else {
    clickResult = await send('Runtime.evaluate', {
    returnByValue: true,
    awaitPromise: true,
    expression: `
(async () => {
  const all = [...document.querySelectorAll('button, [role=button], div, span')];
  const visible = el => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 5 && r.height > 5 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const target = all.find(el => visible(el) && /H30|红外|IR|Thermal|Matrice|Live|直播/i.test((el.innerText || el.textContent || '') + ' ' + el.className));
  if (!target) return 'no-target';
  target.scrollIntoView({block: 'center', inline: 'center'});
  await new Promise(r => setTimeout(r, 500));
  target.click();
  await new Promise(r => setTimeout(r, 15000));
  return (target.innerText || target.textContent || target.className || '').toString().slice(0, 200);
})()`
    });
  }
  console.log('CLICK_RESULT');
  console.log(clickResult.result.result.value);
  console.log('CAPTURED_REQUESTS');
  console.log(JSON.stringify(captured, null, 2));
  ws.close();
}

main().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
