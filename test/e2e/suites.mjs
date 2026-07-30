// Browser test suites. Each is an async function receiving a context of
// { page, origin, check } and driving the real editor.

export const suites = [

/* ------------------------------------------------------------------ editor */
['editor', async ({ page, origin, check }) => {
  await page.goto(`${origin}/`);
  check('palette lists every catalogued module', await page.eval(
    `fetch('/api/modules').then(r => r.json())
       .then(c => c.length === document.querySelectorAll('.pal-item').length && c.length)`) === 25);
  check('palette groups the 4 categories',
    await page.eval(`document.querySelectorAll('.pal-group').length`) === 4);
  check('the empty-canvas hint is visible',
    await page.eval(`!document.querySelector('#canvas-hint').hidden`));
  check('an empty params strip takes no space',
    await page.eval(`document.querySelector('#params-strip').offsetHeight`) === 0);

  const hostile = await page.eval(`fetch('/api/pipes', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'x', modules: [null], wires: [] }) }).then(r => r.status)`);
  check('the API refuses a pipe the editor could not render', hostile === 400, hostile);

  await page.dropModule('item_builder', 500, 150);
  await page.dropModule('output', 520, 430);
  check('dropping from the palette creates cards', (await page.counts()).modules === 2);
  check('the hint disappears once a module exists',
    await page.eval(`document.querySelector('#canvas-hint').hidden`));

  await page.eval(`(() => {
    const inputs = document.querySelector('.module-card').querySelectorAll('.row input');
    inputs[1].value = 'こんにちは世界';
    inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
    return true; })()`);

  const p = await page.portPair();
  await page.drag(p.ox, p.oy, p.ix, p.iy);
  check('dragging port to port creates a wire', (await page.counts()).wires === 1);

  await page.eval(`document.querySelector('#btn-run').click()`);
  check('every card shows its item count', await page.until(
    `[...document.querySelectorAll('.badge')].filter(b => !b.hidden && b.textContent === '1').length === 2`));
  check('the debugger shows the built item',
    await page.until(`document.querySelector('#debugger-body').textContent.includes('こんにちは世界')`));

  const before = await page.eval(`document.querySelector('#wires g.wire .wire-line').getAttribute('d')`);
  const head = await page.eval(`(() => {
    const r = document.querySelectorAll('.module-card')[1].querySelector('.card-header').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await page.drag(head.x, head.y, head.x + 140, head.y + 60);
  check('wires follow a dragged card',
    (await page.eval(`document.querySelector('#wires g.wire .wire-line').getAttribute('d')`)) !== before);
}],

/* -------------------------------------------------------------- demo pipes */
['demo pipes', async ({ page, origin, check }) => {
  await page.goto(`${origin}/?pipe=demo-tech-filter`);
  const c = await page.counts();
  check('the deep link loads the pipe', c.modules === 6 && c.wires === 4, c);
  check('the pipe name is restored',
    await page.eval(`document.querySelector('#pipe-name').value`) === 'デモ: テックニュース絞り込み');
  check('the params strip offers the declared input',
    await page.eval(`document.querySelector('#params-strip').textContent.includes('キーワード')`));
  check('Open RSS points at the saved pipe',
    await page.eval(`document.querySelector('#open-rss').getAttribute('href')`) === '/pipes/demo-tech-filter/run');

  await page.eval(`document.querySelector('#btn-run').click()`);
  const badge = await page.until(`(() => {
    const out = [...document.querySelectorAll('.module-card')].find(c => c.querySelector('.card-header.cat-output'));
    const b = out && out.querySelector('.badge');
    return b && !b.hidden ? b.textContent : null; })()`);
  check('the output count is filtered and truncated',
    badge !== null && Number(badge) > 0 && Number(badge) <= 5, badge);
  check('the debugger lists matching items',
    (await page.eval(`document.querySelector('#debugger-body').textContent`)).includes('AI'));

  await page.eval(`(() => {
    const i = document.querySelector('#params-strip input');
    i.value = 'Rust';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#btn-run').click();
    return true; })()`);
  await page.until(`document.querySelector('#debugger-body').textContent.includes('Rust')`);
  const dbg = await page.eval(`document.querySelector('#debugger-body').textContent`);
  check('changing a param changes the result', dbg.includes('Rust') && !dbg.includes('AI Inference'), dbg.slice(0, 120));

  await page.eval(`(() => {
    const card = [...document.querySelectorAll('.module-card')]
      .find(c => c.querySelector('.card-title').textContent === 'Filter');
    card.querySelector('.card-header').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    return true; })()`);
  check('selecting a card retargets the debugger',
    (await page.eval(`document.querySelector('#dbg-title').textContent`)).startsWith('Filter'));

  await page.eval(`document.querySelector('#dbg-json-toggle').click()`);
  check('the JSON view renders', await page.eval(`!!document.querySelector('.dbg-json')`));
}],

/* ------------------------------------------------------------- undo / redo */
['undo/redo', async ({ page, origin, check }) => {
  await page.goto(`${origin}/`);
  let c = await page.counts();
  check('a fresh pipe has nothing to undo', c.undoDisabled && c.redoDisabled, c);

  await page.dropModule('item_builder', 500, 150);
  await page.dropModule('output', 520, 430);
  c = await page.counts();
  check('undo becomes available after an edit', !c.undoDisabled && c.redoDisabled, c);

  await page.eval(`document.querySelector('#btn-undo').click()`);
  await new Promise((r) => setTimeout(r, 120));
  c = await page.counts();
  check('undo removes the module', c.modules === 1 && !c.redoDisabled, c);
  await page.eval(`document.querySelector('#btn-redo').click()`);
  await new Promise((r) => setTimeout(r, 120));
  c = await page.counts();
  check('redo puts it back', c.modules === 2 && c.redoDisabled, c);

  const p = await page.portPair();
  await page.drag(p.ox, p.oy, p.ix, p.iy);
  check('wire created', (await page.counts()).wires === 1);
  await page.key('z', { ctrl: true });
  check('Ctrl+Z undoes the wire', (await page.counts()).wires === 0);
  await page.key('z', { ctrl: true, shift: true });
  check('Ctrl+Shift+Z redoes it', (await page.counts()).wires === 1);

  const field = `document.querySelectorAll('.module-card')[0].querySelectorAll('.row input')[1]`;
  const typedFrom = await page.eval(`${field}.value`);
  await page.eval(`(() => { const i = ${field}; i.focus();
    for (const ch of 'hello') { i.value += ch; i.dispatchEvent(new Event('input', { bubbles: true })); }
    return true; })()`);
  await page.eval(`document.activeElement.blur()`);
  await page.key('z', { ctrl: true });
  check('one undo reverts a whole run of typing',
    (await page.eval(`${field}.value`)) === typedFrom);
  await page.key('z', { ctrl: true, shift: true });
  check('redo restores the typed text',
    (await page.eval(`${field}.value`)) === typedFrom + 'hello');

  const wires = (await page.counts()).wires;
  await page.eval(`${field}.focus()`);
  await page.key('z', { ctrl: true });
  check('Ctrl+Z inside a text field leaves the graph alone', (await page.counts()).wires === wires);
  await page.eval(`document.activeElement.blur()`);

  const pos = `document.querySelectorAll('.module-card')[1].style.left + '/' + document.querySelectorAll('.module-card')[1].style.top`;
  const posBefore = await page.eval(pos);
  const head = await page.eval(`(() => {
    const r = document.querySelectorAll('.module-card')[1].querySelector('.card-header').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await page.drag(head.x, head.y, head.x + 120, head.y + 70);
  check('the card moved', (await page.eval(pos)) !== posBefore);
  await page.key('z', { ctrl: true });
  check('one undo reverts the whole drag', (await page.eval(pos)) === posBefore);
  await page.key('z', { ctrl: true, shift: true });

  const before = await page.counts();
  await page.eval(`(() => { const card = document.querySelectorAll('.module-card')[1];
    const h = card.querySelector('.card-header');
    h.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    h.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
    card.querySelector('.card-del').click(); return true; })()`);
  await new Promise((r) => setTimeout(r, 120));
  const afterDel = await page.counts();
  check('deleting a module takes its wires with it',
    afterDel.modules === before.modules - 1 && afterDel.wires === 0, afterDel);
  await page.key('z', { ctrl: true });
  const restored = await page.counts();
  check('undo brings back the module and its wires',
    restored.modules === before.modules && restored.wires === before.wires, restored);

  await page.key('z', { ctrl: true });
  check('redo is available after undoing', !(await page.counts()).redoDisabled);
  await page.dropModule('reverse', 900, 200);
  check('a new edit drops the redo tail', (await page.counts()).redoDisabled);

  await page.goto(`${origin}/?pipe=demo-tech-filter`);
  c = await page.counts();
  check('loading a pipe resets the history', c.modules === 6 && c.undoDisabled && c.redoDisabled, c);
  await page.eval(`(() => { const h = document.querySelector('.module-card .card-header');
    h.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    h.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
    document.querySelector('.module-card .card-del').click(); return true; })()`);
  await new Promise((r) => setTimeout(r, 120));
  check('a module was deleted from the loaded pipe', (await page.counts()).modules === 5);
  await page.key('z', { ctrl: true });
  c = await page.counts();
  check('undo restores it and empties the history again', c.modules === 6 && c.undoDisabled, c);

  await page.eval(`document.querySelector('#btn-run').click()`);
  check('the restored pipe still runs',
    await page.until(`document.querySelector('#debugger-body').textContent.includes('AI')`));
}],

/* ------------------------------------------ history cap and the dirty flag */
['history limits', async ({ page, origin, check }) => {
  await page.goto(`${origin}/`);
  for (let i = 0; i < 75; i++) {
    await page.dropModule('reverse', 300 + (i % 10) * 20, 120 + Math.floor(i / 10) * 15);
  }
  check('75 modules on the canvas',
    await page.eval(`document.querySelectorAll('.module-card').length`) === 75);

  let steps = 0;
  while (!(await page.eval(`document.querySelector('#btn-undo').disabled`)) && steps++ < 200) {
    await page.eval(`document.querySelector('#btn-undo').click()`);
  }
  // 60 retained states means 59 undoable steps
  const left = await page.eval(`document.querySelectorAll('.module-card').length`);
  check('undo stops at the cap rather than at the beginning',
    left === 16 && steps === 59, { left, steps });

  steps = 0;
  while (!(await page.eval(`document.querySelector('#btn-redo').disabled`)) && steps++ < 200) {
    await page.eval(`document.querySelector('#btn-redo').click()`);
  }
  check('redo walks all the way forward again',
    await page.eval(`document.querySelectorAll('.module-card').length`) === 75);
}],

/* -------------------------------------------------------------- dirty flag */
// New() only prompts when the pipe is dirty, so a stubbed confirm() reads the
// flag without a modal. Each case is a bug that shipped once.
['dirty flag', async ({ page, origin, check }) => {
  const save = () => page.eval(`(async () => { document.querySelector('#btn-save').click();
    await new Promise(r => setTimeout(r, 600)); return true; })()`);
  const armConfirm = () => page.eval(
    `window.__prompted = 0; window.confirm = () => { window.__prompted++; return false; };`);
  const promptedOnNew = async () => {
    await page.eval(`document.querySelector('#btn-new').click()`);
    await new Promise((r) => setTimeout(r, 150));
    return (await page.eval(`window.__prompted`)) === 1;
  };
  const fresh = () => page.goto(`${origin}/`);

  await fresh();
  await page.dropModule('item_builder', 500, 150);
  await save();
  await page.eval(`document.querySelector('#btn-undo').click()`);
  await new Promise((r) => setTimeout(r, 150));
  await page.dropModule('reverse', 700, 300);
  await armConfirm();
  check('save, undo, then a different edit is dirty', await promptedOnNew());

  await fresh();
  await page.dropModule('item_builder', 500, 150);
  await page.eval(`document.querySelector('#btn-save').click()`);
  await page.dropModule('reverse', 700, 300);
  await new Promise((r) => setTimeout(r, 700));
  await armConfirm();
  check('an edit made while the save was in flight is dirty', await promptedOnNew());

  await fresh();
  await page.dropModule('item_builder', 500, 150);
  await page.eval(`(() => { const i = document.querySelector('.module-card .row input');
    i.focus(); i.value = 'ab'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await save();
  await page.eval(`(() => { const i = document.querySelector('.module-card .row input');
    i.focus(); i.value = 'abc'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await armConfirm();
  check('typing that straddles a save is dirty', await promptedOnNew());

  await fresh();
  await page.dropModule('item_builder', 500, 150);
  await save();
  await armConfirm();
  check('a freshly saved pipe is clean', !(await promptedOnNew()));

  await fresh();
  await page.dropModule('item_builder', 500, 150);
  await save();
  await page.dropModule('reverse', 700, 300);
  await page.eval(`document.querySelector('#btn-undo').click()`);
  await new Promise((r) => setTimeout(r, 150));
  await armConfirm();
  check('undoing back to the saved state is clean again', !(await promptedOnNew()));

  await fresh();
  await page.dropModule('reverse', 500, 150);
  await armConfirm();
  check('an unsaved edit still prompts', await promptedOnNew());
  check('declining the prompt keeps the pipe',
    await page.eval(`document.querySelectorAll('.module-card').length`) === 1);
}],

/* --------------------------------------------------------------------- zoom */
// Every coordinate the editor stores is unscaled, while everything
// getBoundingClientRect reports is scaled, so each conversion is a chance to
// be off by a factor of the zoom.
['zoom', async ({ page, origin, check }) => {
  const label = `document.querySelector('#zoom-label').textContent`;
  const zoomIn = () => page.eval(`document.querySelector('#zoom-in').click()`);
  const zoomOut = () => page.eval(`document.querySelector('#zoom-out').click()`);
  // an IIFE: repeated Runtime.evaluate calls share one global scope, so a
  // top-level `const` would be a redeclaration the second time round
  const home = () => page.eval(`(() => { const w = document.querySelector('#canvas-wrap');
    w.scrollLeft = 0; w.scrollTop = 0; return true; })()`);

  await page.goto(`${origin}/`);
  check('starts at 100%', (await page.eval(label)) === '100%');

  await zoomOut();
  check('one step out is 80%', (await page.eval(label)) === '80%');
  await zoomIn(); await zoomIn();
  check('two steps in is 125%', (await page.eval(label)) === '125%');
  check('the canvas is really scaled',
    (await page.eval(`getComputedStyle(document.querySelector('#canvas')).transform`)).startsWith('matrix(1.25'));
  check('the sizer grew so the scrollbars stay honest',
    (await page.eval(`document.querySelector('#canvas-sizer').style.width`)) === '5000px');

  await home();
  await page.dropModule('item_builder', 500, 300);
  const dropped = await page.eval(`(() => { const m = document.querySelector('.module-card');
    const c = document.querySelector('#canvas').getBoundingClientRect();
    return { left: parseFloat(m.style.left), top: parseFloat(m.style.top),
             wantX: (500 - c.left) / 1.25 - 130, wantY: (300 - c.top) / 1.25 - 16 }; })()`);
  check('a drop lands under the pointer while zoomed',
    Math.abs(dropped.left - dropped.wantX) <= 1 && Math.abs(dropped.top - dropped.wantY) <= 1, dropped);

  // wire two cards placed at 100%, then scaled up
  await page.goto(`${origin}/`);
  await home();
  await page.dropModule('item_builder', 500, 150);
  await page.dropModule('output', 520, 430);
  await zoomIn();
  await home();
  const p = await page.portPair();
  await page.drag(p.ox, p.oy, p.ix, p.iy);
  check('a wire can still be drawn while zoomed', (await page.counts()).wires === 1);
  check('the wire meets the port in canvas coordinates', await page.eval(`(() => {
    const d = document.querySelector('#wires g.wire .wire-line').getAttribute('d');
    const m = d.match(/^M ([\\d.-]+) ([\\d.-]+)/);
    const o = document.querySelectorAll('.module-card')[0]
      .querySelector('.port[data-dir="out"]').getBoundingClientRect();
    const c = document.querySelector('#canvas').getBoundingClientRect();
    return Math.abs(Number(m[1]) - (o.left + o.width / 2 - c.left) / 1.25) < 1.5
        && Math.abs(Number(m[2]) - (o.top + o.height / 2 - c.top) / 1.25) < 1.5; })()`));

  const pos = `parseFloat(document.querySelectorAll('.module-card')[1].style.left)`;
  const before = await page.eval(pos);
  const head = await page.eval(`(() => { const r = document.querySelectorAll('.module-card')[1]
    .querySelector('.card-header').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await page.drag(head.x, head.y, head.x + 125, head.y);
  const after = await page.eval(pos);
  check('125 screen pixels of drag move a card 100 canvas pixels',
    Math.abs((after - before) - 100) <= 2, { before, after });

  await page.eval(`document.querySelector('#zoom-label').click()`);
  check('clicking the readout returns to 100%', (await page.eval(label)) === '100%');

  for (let i = 0; i < 10; i++) await zoomIn();
  check('zoom stops at the top of the range', (await page.eval(label)) === '200%');
  for (let i = 0; i < 12; i++) await zoomOut();
  check('zoom stops at the bottom of the range', (await page.eval(label)) === '40%');
}],

/* ------------------------------------------ multi-select and copy / paste */
['multi-select', async ({ page, origin, check }) => {
  const selected = () => page.eval(`document.querySelectorAll('.module-card.selected').length`);
  const headerAt = (i) => page.eval(`(() => { const r = document.querySelectorAll('.module-card')[${i}]
    .querySelector('.card-header').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const clickHeader = (i, mods = {}) => page.eval(`(() => {
    const h = document.querySelectorAll('.module-card')[${i}].querySelector('.card-header');
    const init = { bubbles: true, button: 0, shiftKey: ${!!mods.shift} };
    h.dispatchEvent(new PointerEvent('pointerdown', init));
    h.dispatchEvent(new PointerEvent('pointerup', init));
    return true; })()`);

  await page.goto(`${origin}/`);
  await page.dropModule('item_builder', 400, 150);
  await page.dropModule('reverse', 700, 150);
  await page.dropModule('output', 400, 430);
  check('the last dropped module is selected', (await selected()) === 1);

  await clickHeader(0);
  check('a plain click selects one', (await selected()) === 1);
  await clickHeader(1, { shift: true });
  check('shift-click adds to the selection', (await selected()) === 2);
  await clickHeader(1, { shift: true });
  check('shift-clicking again removes it', (await selected()) === 1);

  await page.key('a', { ctrl: true });
  check('Ctrl+A selects every module', (await selected()) === 3);
  await page.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  check('Escape clears the selection', (await selected()) === 0);

  // rubber band over the two modules on the upper row
  const band = await page.eval(`(() => {
    const c = document.querySelector('#canvas').getBoundingClientRect();
    const cards = [...document.querySelectorAll('.module-card')];
    const top = cards.map((m) => m.getBoundingClientRect()).filter((r) => r.top < c.top + 300);
    return { x1: c.left + 5, y1: c.top + 5,
             x2: Math.max(...top.map((r) => r.right)) + 10,
             y2: Math.min(...top.map((r) => r.bottom)) - 5 }; })()`);
  await page.drag(band.x1, band.y1, band.x2, band.y2);
  check('a rubber band selects what it covers', (await selected()) === 2, band);
  check('the marquee is gone afterwards', await page.eval(`!document.querySelector('.marquee')`));

  // dragging one member moves the whole set
  await page.key('a', { ctrl: true });
  const before = await page.eval(`[...document.querySelectorAll('.module-card')].map((m) => m.style.left)`);
  const head = await headerAt(0);
  await page.drag(head.x, head.y, head.x + 60, head.y);
  const after = await page.eval(`[...document.querySelectorAll('.module-card')].map((m) => m.style.left)`);
  check('dragging a selected card moves all of them',
    after.every((v, i) => parseFloat(v) - parseFloat(before[i]) === 60), { before, after });
  await page.key('z', { ctrl: true });
  check('the group move is a single undo step',
    (await page.eval(`[...document.querySelectorAll('.module-card')].map((m) => m.style.left)`))
      .join() === before.join());

  // copy and paste
  await page.dropModule('filter', 900, 300);   // clears the selection to one
  await clickHeader(0);
  await clickHeader(2, { shift: true });
  await page.key('c', { ctrl: true });
  await page.key('v', { ctrl: true });
  check('paste adds the copied modules', (await page.counts()).modules === 6);
  check('the pasted copies end up selected', (await selected()) === 2);
  check('paste is one undo step', await (async () => {
    await page.key('z', { ctrl: true });
    return (await page.counts()).modules === 4;
  })());

  // wires between copied modules come along; dangling ones do not
  await page.goto(`${origin}/`);
  await page.dropModule('item_builder', 400, 150);
  await page.dropModule('output', 420, 430);
  const p = await page.portPair();
  await page.drag(p.ox, p.oy, p.ix, p.iy);
  check('one wire to start with', (await page.counts()).wires === 1);
  await page.key('a', { ctrl: true });
  await page.key('c', { ctrl: true });
  await page.key('v', { ctrl: true });
  const c = await page.counts();
  check('copying both ends brings the wire too', c.modules === 4 && c.wires === 2, c);

  await page.key('a', { ctrl: true });
  await page.key('x', { ctrl: true });
  check('cut empties the canvas', (await page.counts()).modules === 0);
  await page.key('v', { ctrl: true });
  check('and paste brings it back', (await page.counts()).modules === 4);
}],

/* ------------------------------------------------------------- auto layout */
['auto layout', async ({ page, origin, check }) => {
  const boxes = () => page.eval(`(() => {
    const out = {};
    for (const c of document.querySelectorAll('.module-card')) {
      out[c.querySelector('.card-title').textContent] =
        { x: parseFloat(c.style.left), y: parseFloat(c.style.top) };
    }
    return out; })()`);

  await page.goto(`${origin}/?pipe=demo-loop`);
  // scatter the tidy demo pipe, then ask for it back
  await page.eval(`(() => {
    document.querySelectorAll('.module-card').forEach((c, i) => {
      c.style.left = (900 - i * 130) + 'px';
      c.style.top = (60 + (i % 2) * 500) + 'px';
    });
    return true; })()`);

  await page.eval(`document.querySelector('#btn-layout').click()`);
  await new Promise((r) => setTimeout(r, 400));
  const laid = await boxes();
  const order = ['Fetch Feed', 'Sort', 'Truncate', 'Loop', 'Strip HTML', 'Pipe Output'];
  check('every module in the chain got a row', order.every((n) => laid[n]), Object.keys(laid));
  check('rows follow the direction of the wires',
    order.every((n, i) => i === 0 || laid[n].y > laid[order[i - 1]].y),
    order.map((n) => laid[n] && laid[n].y));
  check('a single chain lines up in one column',
    new Set(order.map((n) => laid[n].x)).size === 1, order.map((n) => laid[n].x));

  await page.key('z', { ctrl: true });
  const undone = await boxes();
  check('the whole arrangement is one undo step',
    undone['Fetch Feed'].x !== laid['Fetch Feed'].x, { undone, laid });

  // user inputs sit beside the flow, not in it
  await page.goto(`${origin}/?pipe=demo-tech-filter`);
  await page.eval(`document.querySelector('#btn-layout').click()`);
  await new Promise((r) => setTimeout(r, 400));
  const withInput = await boxes();
  check('a user input is placed left of the chain',
    withInput['Text Input'].x < withInput['Fetch Feed'].x, withInput);

  await page.goto(`${origin}/`);
  await page.eval(`document.querySelector('#btn-layout').click()`);
  check('arranging an empty canvas does nothing at all',
    (await page.counts()).modules === 0);
}],

/* ----------------------------------------------------------- duplicate pipe */
['duplicate pipe', async ({ page, origin, check }) => {
  await page.goto(`${origin}/`);
  const listNames = () => page.eval(
    `fetch('/api/pipes').then(r => r.json()).then(l => l.map(p => p.name))`);

  await page.eval(`window.confirm = () => true`);
  await page.eval(`document.querySelector('#btn-load').click()`);
  const ready = await page.until(
    `!![...document.querySelectorAll('#load-menu .menu-item')]
        .find((r) => r.dataset.name === 'デモ: フィードのマージ')`);
  check('the load menu lists the demo pipe', ready === true);
  await page.eval(`(() => { const rows = [...document.querySelectorAll('#load-menu .menu-item')];
    rows.find((r) => r.dataset.name === 'デモ: フィードのマージ')
      .querySelector('.menu-act').click(); return true; })()`);
  await page.until(`fetch('/api/pipes').then(r => r.json())
    .then(l => l.some(p => p.name.endsWith('のコピー')))`);

  const names = await listNames();
  check('the copy is saved under its own name',
    names.includes('デモ: フィードのマージ のコピー'), names);
  check('the original is still there', names.includes('デモ: フィードのマージ'));

  const copy = await page.eval(`fetch('/api/pipes').then(r => r.json())
    .then(l => l.find(p => p.name.endsWith('のコピー')))
    .then(p => fetch('/api/pipes/' + p.id).then(r => r.json()))`);
  check('the copy has the same graph', copy.modules.length === 6 && copy.wires.length === 5,
    { modules: copy.modules.length, wires: copy.wires.length });
  check('and a different id', copy.id !== 'demo-merged', copy.id);
}],

/* ------------------------------------------------- palette click and files */
['palette click and JSON files', async ({ page, origin, check }) => {
  await page.goto(`${origin}/`);
  await page.eval(`[...document.querySelectorAll('.pal-item')]
    .find((i) => i.textContent.includes('Reverse')).click()`);
  await new Promise((r) => setTimeout(r, 150));
  check('clicking a palette item adds it without dragging',
    (await page.counts()).modules === 1);
  const where = await page.eval(`(() => { const m = document.querySelector('.module-card');
    const w = document.querySelector('#canvas-wrap');
    return { x: parseFloat(m.style.left), viewW: w.clientWidth, scroll: w.scrollLeft }; })()`);
  check('and puts it where the user is looking',
    Math.abs(where.x - (where.scroll + where.viewW / 2 - 130)) < 2, where);

  // export writes a file the editor can read back
  // the anchor click is stubbed out: a real download in headless Chrome needs
  // Page.setDownloadBehavior and would hang the run waiting for it
  const exported = await page.eval(`(async () => {
    let captured = null;
    const realCreate = URL.createObjectURL;
    const realClick = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = (blob) => { captured = blob; return 'blob:stub'; };
    HTMLAnchorElement.prototype.click = function () {};
    try {
      document.querySelector('#btn-load').click();
      for (let i = 0; i < 100 && !document.querySelector('.menu-file'); i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      document.querySelector('.menu-file').click();
      await new Promise((r) => setTimeout(r, 200));
      return captured ? await captured.text() : null;
    } finally {
      URL.createObjectURL = realCreate;
      HTMLAnchorElement.prototype.click = realClick;
    } })()`);
  const parsed = JSON.parse(exported);
  check('the export is the pipe as JSON',
    parsed.modules.length === 1 && parsed.modules[0].type === 'reverse', parsed);

  // and importing one replaces the canvas
  await page.eval(`window.confirm = () => true`);
  const imported = await page.eval(`(async () => {
    const pipe = { name: '取り込んだパイプ', modules: [
      { id: 'a', type: 'item_builder', params: {}, x: 40, y: 40 },
      { id: 'b', type: 'output', params: {}, x: 40, y: 300 }],
      wires: [{ id: 'w', from: { module: 'a', port: 'out' }, to: { module: 'b', port: 'in' } }] };
    const file = new File([JSON.stringify(pipe)], 'x.json', { type: 'application/json' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const picker = document.querySelector('#load-menu input[type=file]');
    picker.files = dt.files;
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    return { name: document.querySelector('#pipe-name').value,
             rss: document.querySelector('#open-rss').hidden }; })()`);
  const after = await page.counts();
  check('importing replaces the canvas', after.modules === 2 && after.wires === 1, after);
  check('and takes the name from the file', imported.name === '取り込んだパイプ', imported);
  check('an imported pipe is not yet saved on this server', imported.rss === true);
}],

/* ------------------------------------------------------------------ minimap */
['minimap', async ({ page, origin, check }) => {
  const hidden = () => page.eval(`document.querySelector('#minimap').hidden`);
  // any non-transparent pixel means something was drawn
  const painted = () => page.eval(`(() => {
    const c = document.querySelector('#minimap');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n; })()`);

  await page.goto(`${origin}/`);
  check('an empty pipe has no minimap to show', await hidden());

  await page.dropModule('item_builder', 400, 150);
  check('adding a module reveals it', !(await hidden()));
  const one = await painted();
  check('and something is drawn on it', one > 0, one);

  await page.dropModule('output', 420, 430);
  const p = await page.portPair();
  await page.drag(p.ox, p.oy, p.ix, p.iy);
  const two = await painted();
  check('a second module and a wire add to it', two > one, { one, two });

  // clicking the map scrolls the canvas to that point
  await page.goto(`${origin}/?pipe=demo-loop`);
  check('the minimap is shown for a loaded pipe', !(await hidden()));
  const before = await page.eval(`document.querySelector('#canvas-wrap').scrollTop`);
  const target = await page.eval(`(() => { const r = document.querySelector('#minimap').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.bottom - 8 }; })()`);
  await page.drag(target.x, target.y, target.x, target.y, 1);
  const after = await page.eval(`document.querySelector('#canvas-wrap').scrollTop`);
  check('clicking near the bottom scrolls down', after > before, { before, after });

  await page.eval(`document.querySelector('#btn-run').click()`);
  check('the pipe still runs with the minimap up',
    await page.until(`document.querySelector('#debugger-body').textContent.includes('OpenPipes Demo')`));
}],

/* --------------------------------------------------------- saved pipe list */
['saved pipes', async ({ page, origin, check }) => {
  await page.goto(`${origin}/`);
  await page.dropModule('item_builder', 500, 150);
  await page.eval(`(() => { const n = document.querySelector('#pipe-name');
    n.value = 'e2e-throwaway'; n.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await page.eval(`(async () => { document.querySelector('#btn-save').click();
    await new Promise(r => setTimeout(r, 600)); return true; })()`);
  check('saving reveals the RSS link',
    await page.eval(`!document.querySelector('#open-rss').hidden`));

  await page.eval(`document.querySelector('#btn-load').click()`);
  await page.until(`[...document.querySelectorAll('#load-menu .menu-name')]
    .some(n => n.textContent === 'e2e-throwaway')`);
  const names = await page.eval(`[...document.querySelectorAll('#load-menu .menu-name')].map(n => n.textContent)`);
  check('the saved pipe appears in the load menu', names.includes('e2e-throwaway'), names);

  const id = await page.eval(`document.querySelector('#open-rss').getAttribute('href').split('/')[2]`);
  await page.eval(`window.confirm = () => true;`);
  await page.eval(`(() => { const rows = [...document.querySelectorAll('#load-menu .menu-item')];
    rows.find(r => r.dataset.name === 'e2e-throwaway')
      .querySelector('.menu-del').click(); return true; })()`);
  await page.until(`fetch('/api/pipes').then(r => r.json())
    .then(l => !l.some(p => p.name === 'e2e-throwaway'))`);
  const after = await page.eval(`fetch('/api/pipes').then(r => r.json()).then(l => l.map(p => p.id))`);
  check('deleting from the menu removes it server-side', !after.includes(id), { id, after });
  check('the deleted pipe is no longer the open document',
    await page.eval(`document.querySelector('#open-rss').hidden`));
  check('the demo pipes are untouched', after.includes('demo-tech-filter') && after.includes('demo-merged'), after);
}],

]
