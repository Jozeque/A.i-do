// NB Frames' reference board — the send order, each image's role label, the list that opens the
// gem's message, and the labels the server puts in front of each image (chat and Nano Banana).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RB_SECTIONS, newBoard, newRbBlock, orderedBoard, refLabel, boardManifest, boardSignature, ASSET_ROLE } from '../public/refboard.js';
import { refMeta, refCaption, cleanRefLabel } from '../server/ref-labels.js';

let n = 0;
const img = (name) => ({ id: `i${++n}`, name, mimeType: 'image/jpeg', data: 'AAAA', url: `blob:${name}` });
const blockOf = (b, kind) => b.blocks.find(x => x.kind === kind);

// Every section filled; the blocks deliberately out of order in the array.
function fullBoard() {
  const b = newBoard();
  const maya = blockOf(b, 'character');
  maya.name = 'Maya'; maya.images.push(img('maya-front'), img('maya-side'));
  const prop = blockOf(b, 'prop');
  prop.name = 'Trophy'; prop.images.push(img('trophy'));
  const dan = newRbBlock('character');
  dan.name = 'Dan'; dan.images.push(img('dan'));
  b.blocks.unshift(dan);                 // Dan sits first in the array but is character 2 by section
  b.blocks.splice(1, 0, b.blocks.splice(b.blocks.indexOf(maya), 1)[0]);
  blockOf(b, 'location').images.push(img('lobby'));
  blockOf(b, 'location').note = 'at night';
  blockOf(b, 'composition').images.push(img('frame'));
  return b;
}

test('the board starts with one block per section, in role order', () => {
  assert.deepEqual(RB_SECTIONS.map(s => s.kind), ['composition', 'location', 'character', 'prop']);
  assert.deepEqual(newBoard().blocks.map(x => x.kind), ['composition', 'location', 'character', 'prop']);
  assert.equal(orderedBoard(newBoard()).length, 0);
  assert.equal(boardManifest(newBoard()), '', 'an empty board adds nothing to the message');
});

test('send order: composition, location, characters in block order, props', () => {
  const items = orderedBoard(fullBoard());
  assert.deepEqual(items.map(it => it.img.name), ['frame', 'lobby', 'dan', 'maya-front', 'maya-side', 'trophy']);
  assert.deepEqual(items.map(it => it.n), [1, 2, 3, 4, 5, 6]);
});

test('each image carries its role — and which view of one person it is', () => {
  const items = orderedBoard(fullBoard());
  assert.equal(items[0].label, 'COMPOSITION reference — follow its framing, camera angle and layout only, not its people, place, objects or look');
  assert.equal(items[1].label, 'LOCATION reference — the place and its light, not its people');
  assert.equal(items[2].label, 'CHARACTER 1 "Dan" — this person\'s identity and wardrobe');
  assert.equal(items[3].label, 'CHARACTER 2 "Maya" (view 1 of 2) — this person\'s identity and wardrobe');
  assert.equal(items[4].label, 'CHARACTER 2 "Maya" (view 2 of 2) — this person\'s identity and wardrobe');
  assert.equal(items[5].label, 'PROP 1 "Trophy" — its exact design, materials and colour');
  assert.equal(refLabel({ kind: 'character', name: '' }, 3), 'CHARACTER 3 — this person\'s identity and wardrobe');
});

test('the manifest lists every image by number, then the composer\'s images, then names without an image', () => {
  const b = fullBoard();
  const ghost = newRbBlock('prop'); ghost.name = 'Red umbrella'; ghost.note = 'open, dripping';
  b.blocks.push(ghost);
  const m = boardManifest(b, 2);
  assert.ok(m.startsWith('REFERENCE IMAGES (sorted on the app\'s reference board — Nano Banana 2 gets the same images, in this order, with these roles):'));
  assert.ok(m.includes('\nImage 1 = COMPOSITION reference — follow its framing'));
  assert.ok(m.includes('\nImage 2 = LOCATION reference — the place and its light, not its people. Note: at night'));
  assert.ok(m.includes('\nImage 5 = CHARACTER 2 "Maya" (view 2 of 2)'));
  assert.ok(m.includes('\nImage 7 = additional reference attached in the chat — its role is in my message.'));
  assert.ok(m.includes('\nImage 8 = additional reference attached in the chat'));
  assert.ok(!m.includes('Image 9'));
  assert.ok(m.includes('ALSO IN THE FRAME (no image — write them in words):\nProp 2 "Red umbrella" — open, dripping'));
});

test('the signature changes when images change — not when a name or note does', () => {
  const b = fullBoard();
  const before = boardSignature(orderedBoard(b));
  blockOf(b, 'location').note = 'at dawn';
  b.blocks.find(x => x.name === 'Maya').name = 'Maya K';
  assert.equal(boardSignature(orderedBoard(b)), before);
  const maya = b.blocks.find(x => x.name === 'Maya K');
  maya.images.reverse();
  assert.notEqual(boardSignature(orderedBoard(b)), before, 'reordered');
  maya.images.pop();
  assert.notEqual(boardSignature(orderedBoard(b)), before, 'removed');
});

test('assets land in their section; looks and frames have none on the board', () => {
  assert.equal(ASSET_ROLE.character, 'character');
  assert.equal(ASSET_ROLE.mascot, 'character');
  assert.equal(ASSET_ROLE.location, 'location');
  assert.equal(ASSET_ROLE.vehicle, 'prop');
  assert.equal(ASSET_ROLE.look, undefined);
  assert.equal(ASSET_ROLE.frame, undefined);
});

test('server: each image is captioned with its number and role, before the gem and before Nano Banana', () => {
  assert.equal(refCaption(0, 3, 'LOCATION reference — the place'), 'Image 1 — LOCATION reference — the place:');
  assert.equal(refCaption(0, 1, 'COMPOSITION reference — framing only'), 'Image 1 — COMPOSITION reference — framing only:', 'a lone image with a role still says it');
  assert.equal(refCaption(1, 2, ''), 'Image 2:');
  assert.equal(refCaption(0, 1, undefined), '', 'a lone ordinary image needs no caption — as before');
  assert.equal(cleanRefLabel('  a\n  b  '), 'a b');
  assert.equal(cleanRefLabel('z'.repeat(500)).length, 240);
});

test('server: a saved chat image keeps its role (and nothing for an ordinary attachment)', () => {
  assert.deepEqual(refMeta({ label: 'CHARACTER 1 "Maya" — identity', role: 'character', refName: ' Maya ' }), { label: 'CHARACTER 1 "Maya" — identity', role: 'character', refName: 'Maya' });
  assert.deepEqual(refMeta({ label: 'x', role: 'villain' }), { label: 'x' }, 'unknown roles are dropped');
  assert.deepEqual(refMeta({ mimeType: 'image/png', data: 'AAAA' }), {});
  assert.deepEqual(refMeta(undefined), {});
});
