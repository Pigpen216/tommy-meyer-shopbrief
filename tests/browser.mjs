import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const target = process.env.SHOPBRIEF_URL || 'http://127.0.0.1:8088';
const output = new URL('../docs/browser-results.json', import.meta.url);
const results = [];
const browser = await chromium.launch({ headless: true, ...(process.env.SHOPBRIEF_BROWSER ? {channel: process.env.SHOPBRIEF_BROWSER} : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(error.message));

async function check(id, scenario, expected, run) {
  try {
    const observed = await run();
    results.push({ id, scenario, expected, observed, status: 'PASS' });
    console.log(`PASS ${id}: ${scenario}`);
  } catch (error) {
    results.push({ id, scenario, expected, observed: error.message, status: 'FAIL' });
    console.log(`FAIL ${id}: ${error.message}`);
  }
}

async function generate(values) {
  for (const [field, value] of Object.entries(values)) await page.locator(`#${field}`).fill(value);
  const completedRequest = page.waitForResponse(response => response.url().endsWith('/api/plan') && response.request().method() === 'POST');
  await page.locator('#generate-plan').click();
  const response = await completedRequest;
  assert.equal(response.status(), 200);
  await page.locator('#current-action').waitFor({ state: 'visible' });
  await page.waitForFunction(goal => document.body.innerText.includes(goal), values.goal);
}

try {
  await page.goto(target);
  await check('B01', 'The actual homepage provides labeled blank project intake.', 'Four correctly labeled fields and a blank required goal.', async () => {
    for (const field of ['goal', 'tools', 'materials', 'constraints']) {
      assert.equal(await page.locator(`#${field}`).count(), 1);
      assert.ok(await page.locator(`label[for="${field}"]`).innerText());
    }
    assert.equal(await page.locator('#goal').inputValue(), '');
    return 'All four labeled fields are present and goal is blank.';
  });
  await check('B02', 'A whitespace-only goal is rejected without discarding the form.', 'A visible goal error and the entered tools remain.', async () => {
    await page.locator('#goal').fill('   ');
    await page.locator('#tools').fill('drill');
    await page.locator('#generate-plan').click();
    await page.waitForFunction(() => document.querySelector('#goal')?.getAttribute('aria-invalid') === 'true');
    assert.equal(await page.locator('#tools').inputValue(), 'drill');
    const errorId = await page.locator('#goal').getAttribute('aria-describedby');
    assert.ok(errorId);
    assert.match(await page.locator('body').innerText(), /goal/i);
    return 'Goal marked invalid; entered drill remains in its field.';
  });
  await check('B03', 'The paint-rack example produces a constraint-specific route.', 'At least six actions, a measurement-related current action, and the supplied 12-inch limit.', async () => {
    await page.locator('#example-button').click();
    await page.locator('#generate-plan').click();
    await page.locator('#current-action').waitFor({ state: 'visible' });
    const actions = await page.locator('#action-list input[type="checkbox"]').count();
    assert.ok(actions >= 6 && actions <= 8);
    assert.match(await page.locator('#current-action').innerText(), /measur|fit|space/i);
    assert.match(await page.locator('body').innerText(), /12/);
    return `${actions} actions rendered with a fit/measurement first step and supplied dimensions.`;
  });
  await check('B04', 'Completing an action advances the current step.', 'Current action changes and progress increases by one.', async () => {
    const before = await page.locator('#current-action').innerText();
    await page.locator('#outcome-note').fill('Measured the available mounting space: 12 inches wide.');
    await page.locator('#complete-action').click();
    await page.waitForFunction(old => document.querySelector('#current-action')?.innerText !== old, before);
    assert.equal(await page.locator('#action-list input[type="checkbox"]:checked').count(), 1);
    return 'First action completed; next action is current.';
  });
  await check('B05', 'Reloading restores the project, progress, and outcome note.', 'One completed action survives reload and saved project text remains.', async () => {
    await page.reload();
    await page.locator('#current-action').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#action-list input[type="checkbox"]:checked').count(), 1);
    assert.match(await page.locator('#goal').inputValue(), /paint rack/i);
    const stored = await page.evaluate(() => JSON.stringify(Object.fromEntries(Object.entries(localStorage))));
    assert.match(stored, /Measured the available mounting space/);
    return 'Project, completed action, and recorded measurement restored from browser storage.';
  });
  await check('B06', 'Reopening an earlier action clears dependent completion.', 'Reopened action is current and later completed states are reset.', async () => {
    await page.locator('#complete-action').click();
    assert.equal(await page.locator('#action-list input[type="checkbox"]:checked').count(), 2);
    await page.locator('#action-list input[type="checkbox"]').first().uncheck();
    assert.equal(await page.locator('#action-list input[type="checkbox"]:checked').count(), 0);
    assert.match(await page.locator('#current-action').innerText(), /measur|fit|space/i);
    return 'Reopening the first action reset both completed steps and restored the first action.';
  });
  await check('B07', 'User-entered special characters remain text.', 'Markup is visibly preserved as text and cannot execute.', async () => {
    const unsafe = '<img src=x onerror="window.shopbriefInjection=1"> organizer & ruler';
    await generate({ goal: unsafe, tools: 'drill; DRILL; calipers', materials: 'plywood, plywood', constraints: '' });
    assert.match(await page.locator('body').innerText(), /<img src=x/);
    assert.equal(await page.evaluate(() => window.shopbriefInjection), undefined);
    assert.equal(await page.locator('img[onerror]').count(), 0);
    return 'Literal markup and punctuation displayed safely; no injected image/event handler executed.';
  });
  await check('B08', 'Missing information remains explicit.', 'Absent tools/materials/constraints are identified as unknown rather than assumed.', async () => {
    await generate({ goal: 'Make a desk organizer', tools: '', materials: '', constraints: '' });
    const text = await page.locator('body').innerText();
    assert.match(text, /not provided|not supplied|not yet|unknown|confirm/i);
    assert.match(text, /tools/i);
    assert.match(text, /materials/i);
    return 'A goal-only project identifies missing resources and limits.';
  });
  await check('B09', 'The interface has no horizontal overflow at desktop and narrow mobile sizes.', 'Page scroll width does not exceed viewport at 1440, 390 and 320 pixels.', async () => {
    const observations = [];
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      const dimensions = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
      assert.ok(dimensions.content <= dimensions.viewport, JSON.stringify(dimensions));
      observations.push(dimensions);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    return observations;
  });
  await check('B10', 'Keyboard navigation exposes visible focus.', 'Tab reaches an interactive control with a visible focus outline.', async () => {
    await page.goto(target);
    await page.keyboard.press('Tab');
    const focus = await page.evaluate(() => {
      const element = document.activeElement;
      const styles = getComputedStyle(element);
      return { tag: element.tagName, outline: styles.outlineStyle, width: styles.outlineWidth };
    });
    assert.ok(['A', 'BUTTON', 'INPUT', 'TEXTAREA'].includes(focus.tag));
    assert.notEqual(focus.outline, 'none');
    assert.notEqual(focus.width, '0px');
    return focus;
  });
  await check('B12', 'The entire action route reaches and restores its finished state.', 'All seven actions can complete in order; reload retains seven completions and offers no extra completion action.', async () => {
    await generate({ goal: 'Make a compact tool tray', tools: 'ruler, hand saw', materials: 'plywood', constraints: '10-inch width' });
    const count = await page.locator('#action-list input[type="checkbox"]').count();
    assert.equal(count, 7);
    for (let index = 0; index < count; index++) await page.locator('#complete-action').click();
    assert.equal(await page.locator('#action-list input[type="checkbox"]:checked').count(), 7);
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('#action-list input[type="checkbox"]:checked').length === 7);
    const button = page.locator('#complete-action');
    assert.ok(!(await button.isVisible()) || !(await button.isEnabled()));
    return 'All seven steps completed in order and restored after reload; no extra step can be completed.';
  });
  await check('B13', 'A browser that blocks local storage can still use the planner honestly.', 'Plan generation and in-session progress work with an explicit saving-unavailable notice.', async () => {
    const blockedContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await blockedContext.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Blocked', 'SecurityError'); } }));
    const blockedPage = await blockedContext.newPage();
    const errors = [];
    blockedPage.on('pageerror', error => errors.push(error.message));
    await blockedPage.goto(target);
    await blockedPage.locator('#goal').fill('Build a small desk organizer');
    await blockedPage.locator('#generate-plan').click();
    await blockedPage.locator('#current-action').waitFor({ state: 'visible' });
    await blockedPage.locator('#complete-action').click();
    assert.equal(await blockedPage.locator('#action-list input[type="checkbox"]:checked').count(), 1);
    assert.match(await blockedPage.locator('body').innerText(), /not saved|unavailable|this session|temporary|cannot save/i);
    assert.deepEqual(errors, []);
    await blockedContext.close();
    return 'Planner and one completion worked with storage blocked; saving limitation was disclosed.';
  });
  await check('B14', 'The main planning workflow is operable with the keyboard alone.', 'Logical field order, keyboard form submission, notes, completion and reopening all work without pointer actions.', async () => {
    const keyboardContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const keyboardPage = await keyboardContext.newPage();
    await keyboardPage.goto(target);
    async function tabTo(selector, limit = 60) {
      for (let index = 0; index < limit; index++) {
        if (await keyboardPage.evaluate(s => document.activeElement?.matches(s), selector)) return;
        await keyboardPage.keyboard.press('Tab');
      }
      throw new Error(`Keyboard could not reach ${selector}`);
    }
    await tabTo('#goal');
    const order = [];
    for (const [field, value] of [['goal', 'Make a pencil tray'], ['tools', 'ruler, hand saw'], ['materials', 'plywood'], ['constraints', '8-inch width']]) {
      const active = await keyboardPage.evaluate(() => document.activeElement.id);
      order.push(active);
      assert.equal(active, field);
      await keyboardPage.keyboard.type(value);
      await keyboardPage.keyboard.press('Tab');
    }
    assert.equal(await keyboardPage.evaluate(() => document.activeElement.id), 'generate-plan');
    await keyboardPage.keyboard.press('Enter');
    await keyboardPage.locator('#current-action').waitFor({ state: 'visible' });
    await keyboardPage.waitForSelector('#brief-form[aria-busy="false"]');
    await tabTo('#outcome-note');
    await keyboardPage.keyboard.type('Keyboard note: confirm the available width.');
    await tabTo('#complete-action');
    await keyboardPage.keyboard.press('Space');
    assert.equal(await keyboardPage.locator('#action-list input[type="checkbox"]:checked').count(), 1);
    await tabTo('#action-list input[type="checkbox"]');
    await keyboardPage.keyboard.press('Space');
    assert.equal(await keyboardPage.locator('#action-list input[type="checkbox"]:checked').count(), 0);
    await keyboardContext.close();
    return { field_order: order, generated_with: 'Enter', completed_and_reopened_with: 'Space', pointer_actions: 0 };
  });
  await check('B15', 'A malformed saved plan does not break the workspace or discard a valid brief.', 'Reload rejects the broken plan, retains the draft goal, discloses the restore problem, and raises no uncaught error.', async () => {
    const recoveryContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const recoveryPage = await recoveryContext.newPage();
    const errors = [];
    recoveryPage.on('pageerror', error => errors.push(error.message));
    await recoveryPage.goto(target);
    const goal = 'Make a small tray for drill bits';
    await recoveryPage.locator('#goal').fill(goal);
    await recoveryPage.locator('#generate-plan').click();
    await recoveryPage.locator('#current-action').waitFor({ state: 'visible' });
    await recoveryPage.waitForSelector('#brief-form[aria-busy="false"]');
    await recoveryPage.evaluate(() => {
      const snapshot = JSON.parse(localStorage.getItem('shopbrief.workspace.v1'));
      snapshot.plan.requirements = [null];
      localStorage.setItem('shopbrief.workspace.v1', JSON.stringify(snapshot));
    });
    await recoveryPage.reload();
    await recoveryPage.locator('#goal').waitFor();
    assert.deepEqual(errors, []);
    assert.equal(await recoveryPage.locator('#goal').inputValue(), goal);
    assert.equal(await recoveryPage.locator('#action-list input[type="checkbox"]').count(), 0);
    assert.match(await recoveryPage.locator('body').innerText(), /could not be restored|couldn't be restored|invalid saved|saved plan.*restore/i);
    await recoveryContext.close();
    return 'Corrupt saved plan rejected without a page error; valid draft goal retained with an honest restore message.';
  });
  await check('B11', 'No runtime JavaScript errors occurred during the exercised flows.', 'No uncaught page errors.', async () => {
    assert.deepEqual(pageErrors, []);
    return 'No uncaught page errors.';
  });
} finally {
  await fs.writeFile(output, JSON.stringify({ as_of: new Date().toISOString(), url: target, results }, null, 2));
  await browser.close();
}
if (results.some(row => row.status === 'FAIL')) process.exitCode = 1;
