// Browser test suites. Each is an async function receiving a context of
// { page, origin, check } and driving the real editor.

export const suites = [

/* ------------------------------------------------------------------ editor */
['editor', async ({ page, origin, check }) => {
  await page.goto(`${origin}/`);
  check('palette lists every catalogued module', await page.eval(
    `fetch('/api/modules').then(r => r.json())
       .then(c => c.length === document.querySelectorAll('.pal-item').length && c.length)`) === 22);
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
  await new Promise((r) => setTimeout(r, 800));
  check('every card shows its item count', await page.eval(
    `[...document.querySelectorAll('.badge')].filter(b => !b.hidden && b.textContent === '1').length`) === 2);
  check('the debugger shows the built item',
    (await page.eval(`document.querySelector('#debugger-body').textContent`)).includes('こんにちは世界'));

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
  await page.goto(`${origin}/?pipe=demo-tech-filter`, 1600);
  const c = await page.counts();
  check('the deep link loads the pipe', c.modules === 6 && c.wires === 4, c);
  check('the pipe name is restored',
    await page.eval(`document.querySelector('#pipe-name').value`) === 'デモ: テックニュース絞り込み');
  check('the params strip offers the declared input',
    await page.eval(`document.querySelector('#params-strip').textContent.includes('キーワード')`));
  check('Open RSS points at the saved pipe',
    await page.eval(`document.querySelector('#open-rss').getAttribute('href')`) === '/pipes/demo-tech-filter/run');

  await page.eval(`document.querySelector('#btn-run').click()`);
  await new Promise((r) => setTimeout(r, 1400));
  const badge = await page.eval(`(() => {
    const out = [...document.querySelectorAll('.module-card')].find(c => c.querySelector('.card-header.cat-output'));
    return out ? out.querySelector('.badge').textContent : null; })()`);
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
  await new Promise((r) => setTimeout(r, 1400));
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

  await page.goto(`${origin}/?pipe=demo-tech-filter`, 1600);
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
  await new Promise((r) => setTimeout(r, 1400));
  check('the restored pipe still runs',
    (await page.eval(`document.querySelector('#debugger-body').textContent`)).includes('AI'));
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
  await new Promise((r) => setTimeout(r, 500));
  const names = await page.eval(`[...document.querySelectorAll('#load-menu .menu-name')].map(n => n.textContent)`);
  check('the saved pipe appears in the load menu', names.includes('e2e-throwaway'), names);

  const id = await page.eval(`document.querySelector('#open-rss').getAttribute('href').split('/')[2]`);
  await page.eval(`window.confirm = () => true;`);
  await page.eval(`(() => { const rows = [...document.querySelectorAll('#load-menu .menu-item')];
    const row = rows.find(r => r.querySelector('.menu-name').textContent === 'e2e-throwaway');
    row.querySelector('.menu-del').click(); return true; })()`);
  await new Promise((r) => setTimeout(r, 600));
  const after = await page.eval(`fetch('/api/pipes').then(r => r.json()).then(l => l.map(p => p.id))`);
  check('deleting from the menu removes it server-side', !after.includes(id), { id, after });
  check('the deleted pipe is no longer the open document',
    await page.eval(`document.querySelector('#open-rss').hidden`));
  check('the demo pipes are untouched', after.includes('demo-tech-filter') && after.includes('demo-merged'), after);
}],

]
