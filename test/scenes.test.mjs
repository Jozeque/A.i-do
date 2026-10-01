// Scenes — the ids and chat keys, the brief block the gems get, the strip's ordering, the local
// data store's scene writes, and Expenses reading scene chats (SCENES.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import * as srv from '../server/scenes.js';
import * as cli from '../public/scenes.js';
import { createDataStore } from '../server/data.js';
import { computeUsage } from '../server/usage.js';

const S1 = 'sc0123456789abcdef', S2 = 'scfedcba9876543210', S3 = 'sc00000000aaaaaaaa';
const scene = (id, title, order, extra = {}) => ({ id, title, brief: '', order, createdAt: order, updatedAt: order, ...extra });

test('scene ids: only ones the server made name a scene — anything else is General', () => {
  assert.equal(srv.cleanSceneId(S1), S1);
  assert.equal(srv.newSceneId('0123456789abcdef'), S1);
  for (const bad of ['', 'general', 'sc12', 'SC0123456789ABCDEF', 'sc0123456789abcdef~x', '../etc', 42, null, undefined]) assert.equal(srv.cleanSceneId(bad), '', String(bad));
});

test('a scene chat is {sceneId}~{gemId}; General keeps the plain gem id', () => {
  assert.equal(srv.chatKey('nb-frames', S1), `${S1}~nb-frames`);
  assert.equal(srv.chatKey('nb-frames', ''), 'nb-frames');
  assert.equal(srv.chatKey('nb-frames', 'general'), 'nb-frames');
  assert.equal(srv.chatKey('nb-frames', 'bogus'), 'nb-frames');
  assert.deepEqual(srv.parseChatKey(`${S1}~kling-advisor`), { sceneId: S1, gemId: 'kling-advisor' });
  assert.deepEqual(srv.parseChatKey('storyboard'), { sceneId: 'general', gemId: 'storyboard' });
  // the client builds the same keys
  assert.equal(cli.chatKey('seedance', S2), `${S2}~seedance`);
  assert.equal(cli.chatKey('seedance', cli.GENERAL), 'seedance');
  assert.equal(cli.chatKey('seedance', undefined), 'seedance');
});

test('scenes sort by order, then age; a new one goes last', () => {
  const list = [scene(S2, 'B', 2), scene(S1, 'A', 1), scene(S3, 'C', 1.5)];
  assert.deepEqual(srv.sortScenes(list).map(s => s.title), ['A', 'C', 'B']);
  assert.deepEqual(cli.sortScenes(list).map(s => s.title), ['A', 'C', 'B']);
  assert.equal(srv.nextOrder(list), 3);
  assert.equal(srv.nextOrder([]), 1);
  assert.equal(srv.nextOrder(undefined), 1);
  assert.equal(list[0].title, 'B', 'sorting never reorders the list it was given');
});

test('names and briefs are trimmed and capped', () => {
  assert.equal(srv.cleanTitle('  Night   chase \n'), 'Night chase');
  assert.equal(srv.cleanTitle('x'.repeat(200)).length, srv.SCENE_TITLE_MAX);
  assert.equal(srv.cleanBrief(' a\r\nb '), 'a\nb');
  assert.equal(srv.cleanBrief('y'.repeat(9000)).length, srv.SCENE_BRIEF_MAX);
  assert.equal(srv.cleanTitle(undefined), '');
});

test('the brief block: numbered as in the strip, a block of its own, none for General or an empty brief', () => {
  const list = [scene(S2, 'Night chase', 2, { brief: 'Maya runs through the market at night.' }), scene(S1, 'Opening', 1)];
  const b = srv.sceneBriefBlock(list, S2);
  assert.ok(b.startsWith('\n\n--- SCENE CONTEXT'));
  assert.ok(b.includes('scene 2 of the project, "Night chase"'));
  assert.ok(b.includes('Maya runs through the market at night.'));
  assert.ok(b.includes('What the user asks for in each message still decides what you produce.'));
  assert.equal(srv.sceneBriefBlock(list, S1), '', 'a scene without a brief adds nothing');
  assert.equal(srv.sceneBriefBlock(list, ''), '', 'General adds nothing');
  assert.equal(srv.sceneBriefBlock(list, S3), '', 'an unknown scene adds nothing');
});

test("an image's scene: its sceneId while that scene exists, else General", () => {
  const list = [scene(S1, 'Opening', 1)];
  assert.equal(cli.imageScene({ sceneId: S1 }, list), S1);
  assert.equal(cli.imageScene({}, list), cli.GENERAL);
  assert.equal(cli.imageScene({ sceneId: S2 }, list), cli.GENERAL, 'a deleted scene leaves its images in General');
  assert.equal(cli.imageScene({ sceneId: S1 }, []), cli.GENERAL);
  assert.equal(cli.sceneLabel(S1, list), '1 · Opening');
  assert.equal(cli.sceneLabel(cli.GENERAL, list), 'General');
  assert.equal(cli.sceneLabel(S2, list), 'General');
});

test('reordering writes one new order — halfway between the new neighbours', () => {
  const list = [scene(S1, 'A', 1), scene(S2, 'B', 2), scene(S3, 'C', 3)];
  assert.deepEqual(cli.orderFor(list, S3, 0), { order: 0 });     // C to the front
  assert.deepEqual(cli.orderFor(list, S1, 2), { order: 4 });     // A to the end
  assert.deepEqual(cli.orderFor(list, S3, 1), { order: 1.5 });   // C between A and B
  assert.deepEqual(cli.orderFor([scene(S1, 'A', 1)], S1, 0), { order: 1 });
  // a gap halved too thin renumbers every scene instead
  const tight = [scene(S1, 'A', 1), scene(S2, 'B', 1 + 1e-9), scene(S3, 'C', 3)];
  assert.deepEqual(cli.orderFor(tight, S3, 1), { renumber: [{ id: S1, order: 1 }, { id: S3, order: 2 }, { id: S2, order: 3 }] });
});

// The local backend (DATA_BACKEND=local) on a throwaway folder.
async function tempStore(project) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'avs-scenes-'));
  const store = createDataStore(dir, { backend: 'local' });
  await store.saveProject(project);
  return { dir, store };
}

test('local store: add, rename and reorder a scene', async () => {
  const { dir, store } = await tempStore({ id: 'p1', name: 'P', chats: { 'nb-frames': [] }, images: [] });
  try {
    await store.addScene('p1', scene(S1, 'Opening', 1));
    await store.addScene('p1', scene(S2, 'Chase', 2));
    assert.deepEqual((await store.getScenes('p1')).map(s => s.title), ['Opening', 'Chase']);
    const renamed = await store.patchScene('p1', S2, { title: 'Night chase', order: 0 });
    assert.equal(renamed.title, 'Night chase');
    assert.deepEqual((await store.getScenes('p1')).map(s => s.title), ['Night chase', 'Opening']);
    assert.equal(await store.patchScene('p1', S3, { title: 'x' }), null, 'an unknown scene patches nothing');
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('local store: deleting a scene deletes its chats and moves its images to General — deletes no image', async () => {
  const msgs = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }];
  const { dir, store } = await tempStore({
    id: 'p1', name: 'P',
    scenes: [scene(S1, 'Opening', 1), scene(S2, 'Chase', 2)],
    chats: { 'nb-frames': msgs, [`${S1}~nb-frames`]: msgs, [`${S1}~seedance`]: msgs, [`${S2}~nb-frames`]: msgs },
    images: [{ id: 'a', file: 'a.png' }, { id: 'b', file: 'b.png', sceneId: S1 }, { id: 'c', file: 'c.png', sceneId: S2 }],
  });
  try {
    const res = await store.deleteScene('p1', S1);
    assert.deepEqual(res, { movedImages: 1, deletedChats: 2 });
    const p = await store.getProject('p1');
    assert.deepEqual(p.scenes.map(s => s.id), [S2]);
    assert.deepEqual(Object.keys(p.chats).sort(), ['nb-frames', `${S2}~nb-frames`].sort());
    assert.equal(p.images.length, 3, 'every image is still there');
    assert.equal(p.images.find(i => i.id === 'b').sceneId, undefined, 'back in General');
    assert.equal(p.images.find(i => i.id === 'c').sceneId, S2, 'other scenes keep theirs');
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('Expenses: a scene chat costs what the same chat costs in General', async () => {
  const at = new Date(2026, 8, 10).getTime();
  const chat = [
    { role: 'user', content: 'a frame of the hero at dawn', images: [{ file: 'x.jpg' }], at },
    { role: 'assistant', content: 'PROMPT 1 — x '.repeat(80), at },
    { role: 'user', content: 'warmer light', at },
    { role: 'assistant', content: 'PROMPT 1 — y '.repeat(80), at },
  ];
  const fake = (chats) => ({
    listProjects: async () => [{ id: 'p' }],
    getProject: async () => ({ id: 'p', createdAt: at, chats, images: [], characters: [], gemOverrides: {} }),
  });
  const general = await computeUsage(fake({ 'nb-frames': chat }), 'claude-haiku-4-5', 'claude-sonnet-5');
  const inScene = await computeUsage(fake({ [`${S1}~nb-frames`]: chat }), 'claude-haiku-4-5', 'claude-sonnet-5');
  assert.equal(inScene.total.claude, general.total.claude);
  assert.equal(inScene.total.claudeCalls, 2);
  assert.ok(general.total.claude > 0);
  // a board turn that kept its history is priced with that history
  const kept = chat.map((m, i) => (i === 2 ? { ...m, images: [{ file: 'x.jpg' }], keptHistory: true } : m));
  const plainImg = chat.map((m, i) => (i === 2 ? { ...m, images: [{ file: 'x.jpg' }] } : m));
  const a = await computeUsage(fake({ 'nb-frames': kept }), 'claude-haiku-4-5', 'claude-sonnet-5');
  const b = await computeUsage(fake({ 'nb-frames': plainImg }), 'claude-haiku-4-5', 'claude-sonnet-5');
  assert.ok(a.total.claude > b.total.claude);
});
