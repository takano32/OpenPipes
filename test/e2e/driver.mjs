// A very small Chrome DevTools Protocol client, so the browser tests need no
// dependencies either. Node >= 18 gives us fetch and WebSocket (>= 22 for the
// global; older versions are handled by the caller's check in run.mjs).

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  'chromium',
  'chromium-browser',
  'google-chrome',
  'google-chrome-stable',
].filter(Boolean);

export function chromeCandidates() {
  return CHROME_CANDIDATES;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(label, probe, { tries = 60, every = 250 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      if (await probe()) return true;
    } catch { /* not up yet */ }
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// Opens a fresh tab and returns a thin wrapper around it.
export async function connect(cdpPort) {
  const target = await (await fetch(
    `http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('could not open the CDP websocket'));
  });

  let seq = 0;
  const pending = new Map();
  const pageErrors = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(msg.params.exceptionDetails?.exception?.description || 'uncaught exception');
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      pageErrors.push(String(msg.params.args?.[0]?.value ?? 'console.error'));
    }
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send('Page.enable');
  await send('Runtime.enable');

  const page = {
    pageErrors,
    send,
    close: () => ws.close(),

    async eval(expression) {
      const r = await send('Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true });
      const details = r.result?.exceptionDetails;
      if (details) {
        throw new Error('page threw: ' +
          (details.exception?.description || details.text || JSON.stringify(details)).slice(0, 400));
      }
      return r.result?.result?.value;
    },

    async goto(url, settleMs = 1300) {
      await send('Page.navigate', { url });
      await sleep(settleMs);
    },

    async key(k, { ctrl = false, shift = false } = {}) {
      const base = {
        modifiers: (ctrl ? 2 : 0) | (shift ? 8 : 0),
        key: k,
        code: `Key${k.toUpperCase()}`,
        windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0),
      };
      await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      await sleep(80);
    },

    async drag(x1, y1, x2, y2, steps = 12) {
      await send('Input.dispatchMouseEvent',
        { type: 'mousePressed', x: x1, y: y1, button: 'left', buttons: 1, clickCount: 1 });
      for (let i = 1; i <= steps; i++) {
        await send('Input.dispatchMouseEvent', {
          type: 'mouseMoved', button: 'left', buttons: 1,
          x: x1 + ((x2 - x1) * i) / steps,
          y: y1 + ((y2 - y1) * i) / steps,
        });
        await sleep(20);
      }
      await send('Input.dispatchMouseEvent',
        { type: 'mouseReleased', x: x2, y: y2, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(80);
    },

    // The palette uses HTML5 drag and drop, which CDP cannot synthesise
    // portably; dispatching the drop event directly exercises the same handler.
    dropModule(type, x, y) {
      return page.eval(`(() => {
        const dt = new DataTransfer();
        dt.setData('text/plain', ${JSON.stringify(type)});
        document.querySelector('#canvas').dispatchEvent(new DragEvent('drop',
          { bubbles: true, cancelable: true, dataTransfer: dt, clientX: ${x}, clientY: ${y} }));
        return true;
      })()`);
    },

    counts() {
      return page.eval(`({
        modules: document.querySelectorAll('.module-card').length,
        wires: document.querySelectorAll('#wires g.wire').length,
        undoDisabled: document.querySelector('#btn-undo').disabled,
        redoDisabled: document.querySelector('#btn-redo').disabled,
      })`);
    },

    // Centre points of the first card's output port and the second's input.
    portPair(fromIndex = 0, toIndex = 1) {
      return page.eval(`(() => {
        const cards = document.querySelectorAll('.module-card');
        const o = cards[${fromIndex}].querySelector('.port[data-dir="out"]').getBoundingClientRect();
        const i = cards[${toIndex}].querySelector('.port[data-dir="in"]').getBoundingClientRect();
        return { ox: o.left + o.width / 2, oy: o.top + o.height / 2,
                 ix: i.left + i.width / 2, iy: i.top + i.height / 2 };
      })()`);
    },
  };
  return page;
}
