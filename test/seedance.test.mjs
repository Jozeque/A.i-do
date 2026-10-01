// Seedance brief builder — the pure parts: upload order, the message the gem receives,
// shot timing, validation, and the server's pinned mode/length/aspect direction.
// Run with `npm test` (node's built-in runner, no dependencies).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SD_SECTIONS, newBrief, newBlock, newShot, orderedImages, composeBrief, validateBrief,
  rescaleShots, clampShotLen, shotTimes, sumShots, blockTag, limitsFor,
} from '../public/seedance.js';
import { seedanceBriefDirection } from '../server/seedance.js';

let n = 0;
const img = (name) => ({ id: `i${++n}`, name, mimeType: 'image/jpeg', data: 'AAAA', url: `blob:${name}` });
const blockOf = (brief, kind) => brief.blocks.find(b => b.kind === kind);

// A brief with every section filled, blocks deliberately out of order in the array.
function fullBrief() {
  const b = newBrief();
  const prop = blockOf(b, 'prop');
  prop.name = 'Trophy'; prop.images.push(img('trophy'));
  const maya = blockOf(b, 'character');
  maya.name = 'Maya'; maya.note = 'the host, red coat'; maya.images.push(img('maya-front'), img('maya-side'));
  const dan = newBlock('character');
  dan.name = 'Dan'; dan.images.push(img('dan'));
  b.blocks.push(dan);                          // Dan sits after the prop in the array, still ships before it
  const loc = blockOf(b, 'location');
  loc.name = 'Showroom'; loc.images.push(img('showroom'));
  const look = blockOf(b, 'look');
  look.note = 'anamorphic, warm practicals'; look.images.push(img('look'));
  return b;
}

test('a new brief opens on the assets step with one empty block per section, in order', () => {
  const b = newBrief();
  assert.equal(b.step, 'assets');
  assert.equal(b.mode, 'creative');
  assert.deepEqual(b.blocks.map(x => x.kind), ['look', 'location', 'character', 'prop']);
  assert.ok(b.blocks.every(x => x.images.length === 0));
  assert.deepEqual(SD_SECTIONS.map(s => s.kind), ['look', 'location', 'character', 'prop']);
});

test('upload order is look → location → characters → props, whatever the array order', () => {
  const items = orderedImages(fullBrief());
  assert.deepEqual(items.map(i => i.img.name), ['look', 'showroom', 'maya-front', 'maya-side', 'dan', 'trophy']);
  assert.deepEqual(items.map(i => i.n), [1, 2, 3, 4, 5, 6]);
  const mayaSide = items[3];
  assert.equal(mayaSide.blockIndex, 1);
  assert.equal(mayaSide.k, 2);
  assert.equal(mayaSide.of, 2);
  assert.equal(items[4].blockIndex, 2);   // Dan is the second character block
});

test('blocks with no images get no number, so later numbers close up', () => {
  const b = newBrief();
  blockOf(b, 'prop').images.push(img('only-prop'));
  assert.deepEqual(orderedImages(b).map(i => [i.n, i.sec.kind]), [[1, 'prop']]);
});

test('@names: an asset tag wins, then the name, then the place in the section', () => {
  const c = newBlock('character');
  assert.equal(blockTag(c, 2), 'character2');
  c.name = 'Maya Cole';
  assert.equal(blockTag(c, 2), 'maya_cole');
  c.tag = 'maya_v2';
  assert.equal(blockTag(c, 2), 'maya_v2');
  assert.equal(blockTag(newBlock('look'), 1), 'look');
  const heb = newBlock('location');
  heb.name = 'סטודיו';
  assert.equal(blockTag(heb, 3), 'location3');   // non-Latin names fall back to a safe tag
});

test('creative brief: role-labeled manifest, then the scene, length and aspect', () => {
  const b = fullBrief();
  b.creative = 'Maya unveils the trophy to Dan.';
  b.length = 12;
  b.aspect = '9:16';
  const c = composeBrief(b, { version: '2.5' });
  assert.equal(c.mode, 'creative');
  assert.equal(c.length, 12);
  assert.equal(c.aspect, '9:16');
  assert.deepEqual(c.images.map(i => i.name), ['look', 'showroom', 'maya-front', 'maya-side', 'dan', 'trophy']);
  const lines = c.text.split('\n');
  assert.equal(lines[0], 'ATTACHED REFERENCE FILES — upload to OpenArt in this exact order:');
  assert.match(lines[1], /^Image 1 = LOOK & CINEMATOGRAPHY \(@look\) — take its lens character, lighting and overall look\/grade ONLY.* Note: anamorphic, warm practicals$/);
  assert.match(lines[2], /^Image 2 = LOCATION 1 "Showroom" \(@showroom\) — the place and its geography only/);
  assert.match(lines[3], /^Image 3 = CHARACTER 1 "Maya" \(@maya\), view 1 of 2 of this one person — identity and wardrobe\. Note: the host, red coat$/);
  assert.match(lines[4], /^Image 4 = CHARACTER 1 "Maya" \(@maya\), view 2 of 2 of this one person — identity and wardrobe\.$/);   // the note rides on view 1 only
  assert.match(lines[5], /^Image 5 = CHARACTER 2 "Dan" \(@dan\) — /);
  assert.match(lines[6], /^Image 6 = PROP 1 "Trophy" \(@trophy\) — its exact design, materials and color\.$/);
  assert.ok(c.text.includes('BRIEF MODE: CREATIVE — break the scene into shots yourself.\nLENGTH: 12s · ASPECT RATIO: 9:16'));
  assert.ok(c.text.endsWith('SCENE:\nMaya unveils the trophy to Dan.'));
  assert.ok(!c.text.includes('SHOT LIST'));
});

test('director brief: numbered shots with time ranges, specs and action; length is their sum', () => {
  const b = fullBrief();
  b.mode = 'director';
  b.scene = 'Night showroom.';
  b.shots = [
    { ...newShot(3), size: 'Wide', lens: '24mm', move: 'Slow push-in', action: 'Maya walks in.' },
    { ...newShot(4), size: 'Close-up', lens: '85mm', action: 'Dan reacts.\nHe smiles.' },
    { ...newShot(5), move: 'Rack focus' },
  ];
  b.length = 99;   // ignored in director mode
  const c = composeBrief(b, { version: '2.5' });
  assert.equal(c.mode, 'director');
  assert.equal(c.length, 12);
  assert.ok(c.text.includes('BRIEF MODE: DIRECTOR / DOP — keep my shot list exactly.\nLENGTH: 12s'));
  assert.ok(!c.text.includes('ASPECT RATIO'));   // project default → left to the gem
  assert.ok(c.text.includes('SCENE: Night showroom.'));
  assert.ok(c.text.includes([
    'SHOT LIST — 3 shots, 12s:',
    'Shot 1 · 0–3s · Wide · 24mm · Slow push-in — Maya walks in.',
    'Shot 2 · 3–7s · Close-up · 85mm — Dan reacts. He smiles.',
    'Shot 3 · 7–12s · Rack focus',
  ].join('\n')));
});

test('a named block without an image is still in the scene, in words; empty blocks are not', () => {
  const b = newBrief();
  const extra = newBlock('character');
  extra.name = 'Guard'; extra.note = 'in the background';
  b.blocks.push(extra);
  b.creative = 'x';
  const c = composeBrief(b);
  assert.ok(c.text.includes('ALSO IN THE SCENE, WITHOUT A REFERENCE IMAGE:\nCHARACTER 2 "Guard" (@guard) — in the background'));
  assert.ok(!c.text.includes('CHARACTER 1'));
  assert.ok(!c.text.includes('ATTACHED REFERENCE FILES'));
  assert.equal(c.images.length, 0);
});

test('a creative length past the version maximum is cut to it', () => {
  const b = newBrief();
  b.creative = 'x';
  b.length = 30;
  assert.equal(composeBrief(b, { version: '2.0' }).length, 15);
  assert.equal(composeBrief(b, { version: '2.5' }).length, 30);
});

test('shot times run end to end', () => {
  const shots = [newShot(2.5), newShot(3), newShot(1.5)];
  assert.deepEqual(shotTimes(shots), [{ start: 0, end: 2.5 }, { start: 2.5, end: 5.5 }, { start: 5.5, end: 7 }]);
  assert.equal(sumShots(shots), 7);
});

test('rescaling keeps proportions, lands exactly on the total, and never goes under a second', () => {
  assert.deepEqual(rescaleShots([3, 3, 4], 20), [6, 6, 8]);
  assert.deepEqual(rescaleShots([1, 1, 1], 10), [3, 3.5, 3.5]);
  for (const [lens, total] of [[[3, 4, 5], 7.5], [[1, 9], 4], [[2, 2, 2, 2, 2], 13], [[0.5, 10], 30]]) {
    const out = rescaleShots(lens, total);
    assert.equal(sumShots(out.map(len => ({ len }))), total, `${lens} → ${total}`);
    assert.ok(out.every(l => l >= 1 && Number.isInteger(l * 2)), `${out} stays on the 0.5s grid, ≥1s`);
  }
  assert.deepEqual(rescaleShots([5, 5, 5], 2), [1, 1, 1]);   // can't go under 1s a shot
  assert.deepEqual(rescaleShots([0, 0], 4), [2, 2]);        // no lengths yet → an even split
  assert.deepEqual(rescaleShots([], 10), []);
});

test("one shot's slider keeps the clip within 4s and the version's maximum", () => {
  const max = limitsFor('2.0').maxLen;   // 15
  assert.equal(clampShotLen([3, 4, 5], 0, 10, { maxTotal: max }), 6);    // 4 + 5 already used
  assert.equal(clampShotLen([3, 4, 5], 1, 0.2, { maxTotal: max }), 1);   // floor of a second
  assert.equal(clampShotLen([2], 0, 1, { maxTotal: max }), 4);           // a lone shot is the whole clip
  assert.equal(clampShotLen([3, 4], 0, 2.74, { maxTotal: 30 }), 2.5);    // snaps to the 0.5s grid
});

test('validation: what to fix before the brief can go', () => {
  const b = newBrief();
  assert.equal(validateBrief(b), 'Describe the scene first.');
  b.creative = 'A scene.';
  assert.equal(validateBrief(b), '');

  b.mode = 'director';
  b.shots = [];
  assert.equal(validateBrief(b), 'Add at least one shot.');
  b.shots = [newShot(3), newShot(3)];
  assert.equal(validateBrief(b), 'Write what happens in at least one shot.');
  b.shots[1].action = 'She turns.';
  assert.equal(validateBrief(b), '');
  b.shots = [{ ...newShot(10), action: 'x' }, newShot(10)];
  assert.match(validateBrief(b, '2.0'), /run 20s — Seedance 2.0 takes up to 15s/);
  b.shots = [{ ...newShot(1), action: 'x' }, newShot(1)];
  assert.match(validateBrief(b), /needs at least 4s/);

  const many = newBrief();
  many.creative = 'x';
  for (let i = 0; i < 10; i++) blockOf(many, 'prop').images.push(img(`p${i}`));
  assert.match(validateBrief(many, '2.0'), /^Seedance 2\.0 takes up to 9 images — this brief has 10\. Remove 1, or switch to 2\.5\.$/);
  assert.equal(validateBrief(many, '2.5'), '');
});

test('server: director mode pins the shot list and its timing format', () => {
  const s = seedanceBriefDirection({ mode: 'director', length: 12, aspect: '16:9', version: '2.5' });
  assert.ok(s.startsWith('\n\n--- ACTIVE BRIEF MODE: DIRECTOR / DOP'));
  assert.ok(s.includes('Keep EXACTLY those shots, in that order, with those durations'));
  assert.ok(s.includes('"Shot 1 (0–3s): wide, 24mm, slow push-in — …"'));
  assert.ok(s.includes('TARGET LENGTH: 12s'));
  assert.ok(s.includes('ASPECT RATIO: 16:9'));
  assert.ok(!s.includes('BRIEF MODE: CREATIVE'));
});

test('server: creative mode hands the coverage to the gem', () => {
  const s = seedanceBriefDirection({ mode: 'creative', length: 8, version: '2.0' });
  assert.ok(s.includes('--- ACTIVE BRIEF MODE: CREATIVE'));
  assert.ok(s.includes('design the coverage yourself'));
  assert.ok(s.includes('TARGET LENGTH: 8s'));
  assert.ok(!s.includes('DIRECTOR'));
  assert.ok(!s.includes('ASPECT RATIO'));
});

test('server: length is clamped per version and rounded to half seconds; bad input adds nothing', () => {
  assert.ok(seedanceBriefDirection({ length: 40, version: '2.0' }).includes('TARGET LENGTH: 15s'));
  assert.ok(seedanceBriefDirection({ length: 40, version: '2.5' }).includes('TARGET LENGTH: 30s'));
  assert.ok(seedanceBriefDirection({ length: 7.3 }).includes('TARGET LENGTH: 7.5s'));
  assert.ok(seedanceBriefDirection({ length: '10' }).includes('TARGET LENGTH: 10s'));
  for (const length of [0, -5, 'abc', '', null, undefined, NaN]) {
    assert.ok(!seedanceBriefDirection({ length }).includes('TARGET LENGTH'), `length ${length}`);
  }
  assert.equal(seedanceBriefDirection({ mode: 'freestyle', aspect: '2:1' }), '');
  assert.equal(seedanceBriefDirection(), '');
  assert.equal(seedanceBriefDirection({ mode: 'creative' }).includes('CREATIVE'), true);
});
