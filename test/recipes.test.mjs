// Recipes — the Tune versions an image records, finding the reply a "Try it here" belongs to,
// and Expenses counting the options that were tried but not kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changedTunes, tuneRef, findReply, cleanFrom, TRY_MAX } from '../server/recipes.js';
import { computeUsage } from '../server/usage.js';

test('a Tune version is a save that changed the text — per gem', () => {
  assert.deepEqual(changedTunes({ 'nb-frames': 'warm', kling: '' }, { 'nb-frames': 'warm', kling: '' }), []);
  assert.deepEqual(changedTunes({ 'nb-frames': 'warm' }, { 'nb-frames': 'cool' }), ['nb-frames']);
  assert.deepEqual(changedTunes({ 'nb-frames': 'warm ' }, { 'nb-frames': ' warm' }), [], 'whitespace alone is not a change');
  assert.deepEqual(changedTunes({}, { seedance: 'x' }).sort(), ['seedance']);
  assert.deepEqual(changedTunes({ storyboard: 'x' }, {}), ['storyboard'], 'clearing it is a change too');
  assert.deepEqual(changedTunes(undefined, undefined), []);
});

test('a recipe names the Tune the gem had: v N, none, or one from before versions', () => {
  const meta = { gemOverrides: { 'nb-frames': 'warm grade', storyboard: 'ink', kling: '' }, tuneVersions: { 'nb-frames': 3 } };
  assert.deepEqual(tuneRef(meta, 'nb-frames'), { gem: 'nb-frames', v: 3 });
  assert.deepEqual(tuneRef(meta, 'kling'), { gem: 'kling', v: 0 }, 'no project Tune — the gem as written');
  assert.deepEqual(tuneRef(meta, 'storyboard'), { gem: 'storyboard', v: 0, pre: true }, 'set before versions were kept');
  assert.deepEqual(tuneRef(null, 'nb-advisor'), { gem: 'nb-advisor', v: 0 });
  assert.equal(tuneRef(meta, ''), null);
});

test('"Try it here" finds its reply: at its index, else wherever it moved', () => {
  const msgs = [
    { role: 'user', content: 'change the sky' },
    { role: 'assistant', content: 'PROMPT — Using the attached image, change only the sky…' },
    { role: 'user', content: 'warmer' },
    { role: 'assistant', content: 'Using the attached image, make the light warmer…' },
  ];
  assert.equal(findReply(msgs, 3, 'Using the attached image, make'), 3);
  assert.equal(findReply(msgs, 1, 'Using the attached image, make'), 3, 'the index is stale — found by its start');
  assert.equal(findReply(msgs, 0, 'change the sky'), -1, 'never a user turn');
  assert.equal(findReply(msgs, NaN, 'PROMPT — Using'), 1);
  assert.equal(findReply([], 0, 'x'), -1);
  assert.equal(findReply(msgs, 9, ''), -1);
});

test('where a prompt came from is kept only in a known shape', () => {
  assert.deepEqual(cleanFrom({ gem: 'nb-frames', chat: 'sc0123456789abcdef~nb-frames', index: 4 }), { gem: 'nb-frames', chat: 'sc0123456789abcdef~nb-frames', index: 4 });
  assert.deepEqual(cleanFrom({ gem: 'storyboard', index: -1 }), { gem: 'storyboard' });
  assert.equal(cleanFrom({ gem: '<script>' }), null);
  assert.equal(cleanFrom('nb-frames'), null);
  assert.equal(cleanFrom(null), null);
  assert.equal(TRY_MAX, 4);
});

test('Expenses: options tried and not kept are counted on their reply; a kept one is counted once, as a Library image', async () => {
  const at = new Date(2026, 8, 12).getTime();
  const reply = (cands) => ({ 'nb-advisor': [
    { role: 'user', content: 'sky', at },
    { role: 'assistant', content: 'Using the attached image…', at, candidates: cands },
  ] });
  const fake = (chats, images = []) => ({
    listProjects: async () => [{ id: 'p' }],
    getProject: async () => ({ id: 'p', createdAt: at, chats, images, characters: [], gemOverrides: {} }),
  });
  const nb = { id: 'a', model: 'gemini-3.1-flash-image', size: '2K', createdAt: at };
  const gpt = { id: 'b', model: 'gpt-image-2', size: '1024x1024', createdAt: at };
  const none = await computeUsage(fake(reply([])), 'claude-haiku-4-5', 'claude-sonnet-5');
  const two = await computeUsage(fake(reply([nb, gpt])), 'claude-haiku-4-5', 'claude-sonnet-5');
  assert.equal(two.total.nbImages - none.total.nbImages, 1);
  assert.equal(two.total.swapImages - none.total.swapImages, 1);
  assert.ok(Math.abs(two.total.nb - none.total.nb - 0.101) < 1e-9, 'NB2 at 2K');
  assert.ok(Math.abs(two.total.swap - none.total.swap - 0.22) < 1e-9, 'GPT Image 2');
  // keep the NB one: it's a Library image now — still counted exactly once
  const kept = await computeUsage(fake(reply([{ ...nb, savedImageId: 'a' }, gpt]), [{ id: 'a', model: nb.model, size: '2K', createdAt: at }]), 'claude-haiku-4-5', 'claude-sonnet-5');
  assert.equal(kept.total.nbImages, two.total.nbImages);
  assert.equal(kept.total.nb, two.total.nb);
});
