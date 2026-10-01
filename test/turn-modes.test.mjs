// The modes the app pins for one chat turn — "More like this" and the script storyboard — and
// the per-project write queue that keeps quick writes from being erased by a full save.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MORE_LIKE_THIS, storyboardScriptDirection, STORYBOARD_MAX_FRAMES } from '../server/turn-modes.js';
import { createWriteQueue } from '../server/data.js';

test('"More like this" asks for fresh directions in the gem\'s own format', () => {
  assert.ok(MORE_LIKE_THIS.startsWith('--- MORE LIKE THIS'));
  assert.ok(MORE_LIKE_THIS.includes('keep what makes it work'));
  assert.ok(MORE_LIKE_THIS.includes("Follow the user's guidance on how to push or tighten it"));
  assert.ok(MORE_LIKE_THIS.includes('give three alternatives instead, each complete in its own fenced block'));
});

test('a script storyboard asks for exactly N titled frames, in a format the cards can read', () => {
  const s = storyboardScriptDirection(8);
  assert.ok(s.startsWith('\n\n--- STORYBOARD FROM SCRIPT'));
  assert.ok(s.includes('a storyboard of exactly 8 frames'));
  assert.ok(s.includes('FRAME k — <a short title for the beat, 2 to 6 words>'));
  assert.ok(s.includes('Number them 1 to 8'));
  assert.ok(s.includes('use no code blocks'));
  assert.ok(s.includes('spread across the whole script'));
  assert.ok(storyboardScriptDirection(1).includes('exactly 1 frame.'));   // singular
  assert.ok(storyboardScriptDirection('12').includes('exactly 12 frames'));
  assert.ok(storyboardScriptDirection(80).includes(`exactly ${STORYBOARD_MAX_FRAMES} frames`));   // capped
  for (const bad of [0, -3, 'abc', null, undefined, NaN]) assert.equal(storyboardScriptDirection(bad), '', `frames ${bad}`);
});

const tick = (ms) => new Promise(r => setTimeout(r, ms));

test('a quick write waits for the full save already running on that project', async () => {
  const serialize = createWriteQueue();
  const log = [];
  const save = serialize('p1', async () => { log.push('save:read'); await tick(30); log.push('save:write'); });
  const add = serialize('p1', async () => { log.push('addImage'); });
  await Promise.all([save, add]);
  assert.deepEqual(log, ['save:read', 'save:write', 'addImage']);
});

test('writes to different projects run side by side', async () => {
  const serialize = createWriteQueue();
  const log = [];
  const a = serialize('p1', async () => { await tick(30); log.push('p1'); });
  const b = serialize('p2', async () => { log.push('p2'); });
  await Promise.all([a, b]);
  assert.deepEqual(log, ['p2', 'p1']);
});

test('a failed write reports its error and does not hold up the next one', async () => {
  const serialize = createWriteQueue();
  const failed = serialize('p1', async () => { throw new Error('boom'); });
  const next = serialize('p1', async () => 'ok');
  await assert.rejects(failed, /boom/);
  assert.equal(await next, 'ok');
});
