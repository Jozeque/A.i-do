// The Video tab's brief builder — the pure parts: upload order and @image numbering, the message
// the gem receives, shot timing, each model's limits, validation, and the server's pinned
// model / mode / length / aspect direction.
// Run with `npm test` (node's built-in runner, no dependencies).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SD_SECTIONS, FRAME_SECS, newBrief, newBlock, newShot, orderedImages, composeBrief, validateBrief, imageRange,
  rescaleShots, clampShotLen, shotTimes, sumShots, blockTag, limitsFor, tagSlug, assetTag, mentionAt, mentionCandidates,
  VIDEO_MODELS, MODEL_IDS, normModel, modelOf, nearestAspect, KLING_ASPECTS, SD_ASPECTS,
} from '../public/seedance.js';
import { seedanceBriefDirection, klingBriefDirection, cleanVideoModel, VIDEO_MODELS as SERVER_MODELS } from '../server/seedance.js';

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
// Start & End: just the two frames.
function framesBrief() {
  const b = newBrief();
  b.gen = 'frames';
  b.frames.start.images.push(img('first'));
  b.frames.end.images.push(img('last'));
  b.aspect = '16:9';
  return b;
}

test('a new brief opens on the references step with one empty block per section, in order', () => {
  const b = newBrief();
  assert.equal(b.step, 'assets');
  assert.equal(b.mode, 'creative');
  assert.equal(b.gen, 'refs');
  assert.deepEqual(b.blocks.map(x => x.kind), ['look', 'location', 'character', 'prop']);
  assert.ok(b.blocks.every(x => x.images.length === 0));
  assert.deepEqual([b.frames.start.kind, b.frames.end.kind], ['start', 'end']);
  assert.deepEqual(SD_SECTIONS.map(s => s.kind), ['look', 'location', 'character', 'prop']);
  assert.equal(SD_SECTIONS[0].single, true, 'the look holds one frame');
});

test('upload order is look → location → characters → props, whatever the array order — and that order is the @image number', () => {
  const items = orderedImages(fullBrief());
  assert.deepEqual(items.map(i => i.img.name), ['look', 'showroom', 'maya-front', 'maya-side', 'dan', 'trophy']);
  assert.deepEqual(items.map(i => i.n), [1, 2, 3, 4, 5, 6]);
  const mayaSide = items[3];
  assert.equal(mayaSide.blockIndex, 1);
  assert.equal(mayaSide.k, 2);
  assert.equal(mayaSide.of, 2);
  assert.equal(items[4].blockIndex, 2);   // Dan is the second character block
  assert.equal(imageRange([3, 4]), '@image3–4');
  assert.equal(imageRange([1]), '@image1');
  assert.equal(imageRange([]), '');
});

test('blocks with no images get no number, so later numbers close up', () => {
  const b = newBrief();
  blockOf(b, 'prop').images.push(img('only-prop'));
  assert.deepEqual(orderedImages(b).map(i => [i.n, i.sec.kind]), [[1, 'prop']]);
});

test('Start & End: the start frame is @image1, the end frame @image2 — the references are not sent', () => {
  const b = framesBrief();
  blockOf(b, 'look').images.push(img('look'));   // still in the brief, but not in this mode
  const items = orderedImages(b);
  assert.deepEqual(items.map(i => [i.n, i.sec.kind, i.img.name]), [[1, 'start', 'first'], [2, 'end', 'last']]);
  assert.deepEqual(FRAME_SECS.map(s => s.kind), ['start', 'end']);
});

test('names for files: an asset tag wins, then the name, then the place in the section', () => {
  const c = newBlock('character');
  assert.equal(blockTag(c, 2), 'character2');
  c.name = 'Maya Cole';
  assert.equal(blockTag(c, 2), 'maya_cole');
  c.tag = 'maya_v2';
  assert.equal(blockTag(c, 2), 'maya_v2');
  assert.equal(blockTag(newBlock('look'), 1), 'look');
  const heb = newBlock('location');
  heb.name = 'סטודיו גדול';
  assert.equal(blockTag(heb, 3), 'סטודיו_גדול');   // a Hebrew name keeps Hebrew letters
  heb.name = '!!!';
  assert.equal(blockTag(heb, 3), 'location3');      // nothing usable → its place in the section
});

test('creative brief: the upload list with @image tags and roles, then the scene, model, length and aspect', () => {
  const b = fullBrief();
  b.creative = 'Maya unveils the trophy to Dan.';
  b.length = 12;
  b.aspect = '9:16';
  const c = composeBrief(b, { model: 'seedance-2.5' });
  assert.equal(c.mode, 'creative');
  assert.equal(c.gen, 'refs');
  assert.equal(c.model, 'seedance-2.5');
  assert.equal(c.length, 12);
  assert.equal(c.aspect, '9:16');
  assert.deepEqual(c.images.map(i => i.name), ['look', 'showroom', 'maya-front', 'maya-side', 'dan', 'trophy']);
  assert.deepEqual(c.images.map(i => i.role), ['look', 'location', 'character', 'character', 'character', 'prop']);
  assert.deepEqual(c.images.map(i => i.refName), ['', 'Showroom', 'Maya', 'Maya', 'Dan', 'Trophy']);
  assert.equal(c.images[2].label, 'CHARACTER 1 "Maya", view 1 of 2 of this one person (@image3) — identity and wardrobe');
  const lines = c.text.split('\n');
  assert.equal(lines[0], 'ATTACHED REFERENCE FILES — upload in this exact order (OpenArt and Higgsfield number them @image1, @image2 …):');
  assert.match(lines[1], /^Image 1 = LOOK & CINEMATOGRAPHY \(@image1\) — take its lens character, lighting and overall look\/grade ONLY.* Note: anamorphic, warm practicals$/);
  assert.match(lines[2], /^Image 2 = LOCATION 1 "Showroom" \(@image2\) — the place and its geography only/);
  assert.match(lines[3], /^Image 3 = CHARACTER 1 "Maya", view 1 of 2 of this one person \(@image3\) — identity and wardrobe\. Note: the host, red coat$/);
  assert.match(lines[4], /^Image 4 = CHARACTER 1 "Maya", view 2 of 2 of this one person \(@image4\) — identity and wardrobe\.$/);   // the note rides on view 1 only
  assert.match(lines[5], /^Image 5 = CHARACTER 2 "Dan" \(@image5\) — /);
  assert.match(lines[6], /^Image 6 = PROP 1 "Trophy" \(@image6\) — its exact design, materials and color\.$/);
  assert.ok(!/@(look|showroom|maya|dan|trophy)\b/.test(c.text), 'no name tags anywhere — only @image numbers');
  assert.ok(c.text.includes('BRIEF MODE: CREATIVE — break the scene into shots yourself.\nMODEL: Seedance 2.5 · LENGTH: 12s · ASPECT RATIO: 9:16'));
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
  const c = composeBrief(b, { model: 'kling-3.0' });
  assert.equal(c.mode, 'director');
  assert.equal(c.length, 12);
  assert.ok(c.text.includes('BRIEF MODE: DIRECTOR / DOP — keep my shot list exactly.\nMODEL: Kling 3.0 · LENGTH: 12s'));
  assert.ok(!c.text.includes('ASPECT RATIO'));   // none chosen → none stated (validation stops it before sending)
  assert.ok(c.text.includes('SCENE: Night showroom.'));
  assert.ok(c.text.includes([
    'SHOT LIST — 3 shots, 12s:',
    'Shot 1 · 0–3s · Wide · 24mm · Slow push-in — Maya walks in.',
    'Shot 2 · 3–7s · Close-up · 85mm — Dan reacts. He smiles.',
    'Shot 3 · 7–12s · Rack focus',
  ].join('\n')));
});

test('Start & End brief: the two frames, then the journey between them', () => {
  const b = framesBrief();
  b.motion = 'She walks to the window as the light turns gold.';
  b.move = 'Slow push-in';
  b.length = 40;
  const c = composeBrief(b, { model: 'kling-3.0' });
  assert.equal(c.gen, 'frames');
  assert.equal(c.length, 15, 'cut to Kling 3.0\'s 15s');
  assert.deepEqual(c.images.map(i => i.role), ['start', 'end']);
  assert.ok(c.text.startsWith('START & END FRAMES — upload in this exact order:\nImage 1 = START FRAME (@image1) — the clip opens exactly on this frame'));
  assert.ok(c.text.includes('\nImage 2 = END FRAME (@image2) — the clip ends exactly on this frame.'));
  assert.ok(c.text.includes('BRIEF MODE: START & END FRAMES — one continuous take from the first frame to the last.\nMODEL: Kling 3.0 · LENGTH: 15s · ASPECT RATIO: 16:9'));
  assert.ok(c.text.includes('WHAT HAPPENS BETWEEN THEM:\nShe walks to the window as the light turns gold.'));
  assert.ok(c.text.endsWith('CAMERA: Slow push-in'));
  b.motion = ''; b.move = '';
  assert.ok(composeBrief(b).text.endsWith('WHAT HAPPENS BETWEEN THEM: read it from the two frames.'));
});

test('a named block without an image is still in the scene, in words; empty blocks are not', () => {
  const b = newBrief();
  const extra = newBlock('character');
  extra.name = 'Guard'; extra.note = 'in the background';
  b.blocks.push(extra);
  b.creative = 'x';
  const c = composeBrief(b);
  assert.ok(c.text.includes('ALSO IN THE SCENE, WITHOUT A REFERENCE IMAGE:\nCHARACTER 2 "Guard" — in the background'));
  assert.ok(!c.text.includes('CHARACTER 1'));
  assert.ok(!c.text.includes('ATTACHED REFERENCE FILES'));
  assert.equal(c.images.length, 0);
});

test('a creative length past the model maximum is cut to it', () => {
  const b = newBrief();
  b.creative = 'x';
  b.length = 30;
  assert.equal(composeBrief(b, { version: '2.0' }).length, 15);   // the old version strings still work
  assert.equal(composeBrief(b, { model: 'seedance-2.5' }).length, 30);
  assert.equal(composeBrief(b, { model: 'kling-3.0' }).length, 15);
});

test('each model: its length, images, shot floor and frame shapes', () => {
  assert.deepEqual(MODEL_IDS, ['seedance-2.0', 'seedance-2.5', 'kling-3.0']);
  assert.deepEqual([modelOf('seedance-2.0').maxLen, modelOf('seedance-2.0').maxImages], [15, 9]);
  assert.deepEqual([modelOf('seedance-2.5').maxLen, modelOf('seedance-2.5').maxImages], [30, 30]);
  const k = modelOf('kling-3.0');
  assert.deepEqual([k.minLen, k.maxLen, k.maxImages, k.minShot, k.maxShots], [3, 15, 4, 3, 6]);
  assert.deepEqual(k.aspects, KLING_ASPECTS);
  assert.equal(normModel('2.0'), 'seedance-2.0');
  assert.equal(normModel('nonsense'), 'seedance-2.5');
  assert.equal(limitsFor('2.0').maxLen, 15);
  // the server knows the same models
  for (const id of MODEL_IDS) assert.equal(SERVER_MODELS[id].maxLen, VIDEO_MODELS[id].maxLen, id);
  assert.equal(cleanVideoModel('kling-3.0'), 'kling-3.0');
  assert.equal(cleanVideoModel('kling'), '');
  assert.equal(cleanVideoModel('__proto__'), '');
});

test('a start frame sets the nearest shape the model renders', () => {
  assert.equal(nearestAspect(1920, 1080), '16:9');
  assert.equal(nearestAspect(1080, 1920), '9:16');
  assert.equal(nearestAspect(2560, 1080), '21:9');
  assert.equal(nearestAspect(2560, 1080, KLING_ASPECTS), '16:9', 'Kling has no 21:9');
  assert.equal(nearestAspect(1000, 1010, SD_ASPECTS), '1:1');
  assert.equal(nearestAspect(0, 100), '');
});

test('shot times run end to end', () => {
  const shots = [newShot(2.5), newShot(3), newShot(1.5)];
  assert.deepEqual(shotTimes(shots), [{ start: 0, end: 2.5 }, { start: 2.5, end: 5.5 }, { start: 5.5, end: 7 }]);
  assert.equal(sumShots(shots), 7);
});

test('rescaling keeps proportions, lands exactly on the total, and never goes under the floor', () => {
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
  assert.deepEqual(rescaleShots([1, 1, 8], 12, { min: 3 }), [3, 3, 6], 'Kling\'s 3s floor');
});

test("one shot's slider keeps the clip within the model's minimum and maximum", () => {
  const max = limitsFor('2.0').maxLen;   // 15
  assert.equal(clampShotLen([3, 4, 5], 0, 10, { maxTotal: max }), 6);    // 4 + 5 already used
  assert.equal(clampShotLen([3, 4, 5], 1, 0.2, { maxTotal: max }), 1);   // floor of a second
  assert.equal(clampShotLen([2], 0, 1, { maxTotal: max }), 4);           // a lone shot is the whole clip
  assert.equal(clampShotLen([3, 4], 0, 2.74, { maxTotal: 30 }), 2.5);    // snaps to the 0.5s grid
  assert.equal(clampShotLen([3, 4], 0, 1, { maxTotal: 15, minTotal: 3, min: 3 }), 3, 'Kling: never under 3s');
});

test('validation: what to fix before the brief can go', () => {
  const b = newBrief();
  assert.equal(validateBrief(b), 'Add the look first — ✦ Use project gem, or a look frame. It\'s always @image1.');
  blockOf(b, 'look').images.push(img('look'));
  assert.equal(validateBrief(b), 'Choose an aspect ratio first.');
  b.aspect = '4:5';
  assert.equal(validateBrief(b), 'Choose an aspect ratio first.');   // only the model's own ratios count
  b.aspect = '16:9';
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
  assert.match(validateBrief(b, '2.0'), /run 20s — Seedance 2\.0 takes up to 15s/);
  b.shots = [{ ...newShot(1), action: 'x' }, newShot(1)];
  assert.match(validateBrief(b), /needs at least 4s/);

  const many = newBrief();
  many.creative = 'x';
  many.aspect = '9:16';
  blockOf(many, 'look').images.push(img('look'));
  for (let i = 0; i < 9; i++) blockOf(many, 'prop').images.push(img(`p${i}`));
  assert.equal(validateBrief(many, 'seedance-2.0'), 'Seedance 2.0 takes up to 9 reference images — this brief has 10. Remove 1, or switch to Seedance 2.5.');
  assert.equal(validateBrief(many, 'seedance-2.5'), '');
});

test('validation on Kling 3.0: four images, 16:9 / 9:16 / 1:1, shots of 3s or more', () => {
  const b = fullBrief();   // six images
  b.creative = 'x';
  b.aspect = '21:9';
  assert.equal(validateBrief(b, 'kling-3.0'), 'Kling 3.0 takes up to 4 reference images — this brief has 6. Remove 2, or switch to Seedance 2.5.');
  blockOf(b, 'character').images.pop();
  b.blocks = b.blocks.filter(x => x.name !== 'Dan');   // now look, showroom, maya, trophy
  assert.equal(validateBrief(b, 'kling-3.0'), 'Kling 3.0 renders 16:9, 9:16, 1:1 — pick one of those.');
  b.aspect = '9:16';
  assert.equal(validateBrief(b, 'kling-3.0'), '');
  b.mode = 'director';
  b.shots = [{ ...newShot(2), action: 'x' }, newShot(4)];
  assert.equal(validateBrief(b, 'kling-3.0'), 'Kling 3.0 needs every shot to run at least 3s.');
  b.shots = Array.from({ length: 7 }, () => ({ ...newShot(3), action: 'x' }));
  assert.equal(validateBrief(b, 'kling-3.0'), 'Kling 3.0 fits at most 6 shots in one clip — remove 1.');
  b.shots = Array.from({ length: 6 }, () => ({ ...newShot(3), action: 'x' }));
  assert.equal(validateBrief(b, 'kling-3.0'), 'The shots run 18s — Kling 3.0 takes up to 15s. Remove a shot.');
});

test('validation in Start & End: both frames, then a shape', () => {
  const b = newBrief();
  b.gen = 'frames';
  assert.equal(validateBrief(b), 'Add the start frame first — it\'s @image1.');
  b.frames.start.images.push(img('a'));
  assert.equal(validateBrief(b), 'Add the end frame — it\'s @image2.');
  b.frames.end.images.push(img('b'));
  assert.equal(validateBrief(b), 'Choose an aspect ratio first.');
  b.aspect = '16:9';
  assert.equal(validateBrief(b, 'kling-3.0'), '', 'no look, no scene text needed');
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

test('server: Seedance start & end frames — one take between @image1 and @image2, either upload route', () => {
  const s = seedanceBriefDirection({ mode: 'director', gen: 'frames', length: 8, aspect: '9:16', version: '2.0' });
  assert.ok(s.includes('--- ACTIVE GENERATION MODE: START & END FRAMES'));
  assert.ok(s.includes('@image1 is the START frame and @image2 is the END frame'));
  assert.ok(s.includes('one continuous take with no cuts'));
  assert.ok(s.includes('"Upload order: 1. Start frame → @image1 · 2. End frame → @image2"'));
  assert.ok(s.includes("OpenArt's Start / End frame slots"));
  assert.ok(!s.includes('ACTIVE BRIEF MODE: DIRECTOR'), 'the frames mode replaces the shot-list mode');
  assert.ok(s.includes('TARGET LENGTH: 8s'));
});

test('server: Kling 3.0 from the brief — @image tags, the upload order, one result, never the three variations', () => {
  const d = klingBriefDirection({ mode: 'director', length: 12, aspect: '16:9' });
  assert.ok(d.startsWith("\n\n--- THE APP'S VIDEO BRIEF — KLING 3.0"));
  assert.ok(d.includes('@image1 is always the LOOK & CINEMATOGRAPHY frame'));
  assert.ok(d.includes('"Upload order: 1. <name> → @image1 · 2. <name> → @image2 · …"'));
  assert.ok(d.includes('keep EXACTLY those shots'));
  assert.ok(d.includes('every block at most 512 characters including the mandatory suffix'));
  assert.ok(d.includes('Never the three archetype variations, never a negative prompt'));
  assert.ok(d.includes('"Kling settings: Kling 3.0 · <length>s · <aspect>"'));
  assert.ok(d.includes('TARGET LENGTH: 12s'));
  assert.ok(d.includes('ASPECT RATIO: 16:9'));
  const c = klingBriefDirection({ mode: 'creative', length: 40, aspect: '21:9' });
  assert.ok(c.includes('CREATIVE (you design the coverage)'));
  assert.ok(c.includes('at most 6 shots of at least 3s each'));
  assert.ok(c.includes('TARGET LENGTH: 15s'), 'clamped to Kling\'s 15s');
  assert.ok(!c.includes('ASPECT RATIO'), 'Kling has no 21:9');
  const f = klingBriefDirection({ gen: 'frames', length: 2, aspect: '1:1' });
  assert.ok(f.includes('KLING 3.0, START & END FRAMES'));
  assert.ok(f.includes("Kling can't combine multi-shot with start and end frames"));
  assert.ok(f.includes('TARGET LENGTH: 3s'), 'never under 3s');
  assert.ok(!f.includes('Upload order: 1. <name>'));
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

test('names keep letters in any script; Hebrew assets saved with the old generic tag get their name back', () => {
  assert.equal(tagSlug('Maya Cole!'), 'maya_cole');
  assert.equal(tagSlug('מאיה כהן'), 'מאיה_כהן');
  assert.equal(tagSlug('  דן - Dan  '), 'דן_dan');
  assert.equal(assetTag({ tag: 'asset', name: 'מאיה' }), 'מאיה');
  assert.equal(assetTag({ tag: 'maya_v2', name: 'Maya' }), 'maya_v2');
  assert.equal(assetTag({ tag: '', name: 'Hero Car' }), 'hero_car');
  assert.equal(assetTag({ tag: 'asset', name: '' }), 'asset');
});

test('the @ menu opens on an @ at the start of a word, and reads what follows it', () => {
  assert.deepEqual(mentionAt('@', 1), { start: 0, query: '' });
  assert.deepEqual(mentionAt('Shot one, @ma', 13), { start: 10, query: 'ma' });
  assert.deepEqual(mentionAt('ומאיה נכנסת עם @גב', 18), { start: 15, query: 'גב' });
  assert.deepEqual(mentionAt('(@dan', 5), { start: 1, query: 'dan' });
  assert.equal(mentionAt('mail me at a@b.com', 18), null);   // not a mention: glued to a word
  assert.equal(mentionAt('@maya walks', 11), null);           // the caret has left the word
  assert.equal(mentionAt('', 0), null);
});

test('the @ menu lists every reference by its @image tag (a name if it has no image), best matches first', () => {
  const b = fullBrief();
  const ghost = newBlock('prop');
  ghost.name = 'גביע';   // named, no image yet — still listed, by name
  b.blocks.push(ghost);
  const all = mentionCandidates(b);
  assert.deepEqual(all.map(c => c.insert), ['@image1', '@image2', '@image3', '@image5', '@image6', 'גביע']);
  assert.deepEqual(all.map(c => c.range), ['@image1', '@image2', '@image3–4', '@image5', '@image6', '']);
  assert.equal(all[2].thumb, 'blob:maya-front');
  assert.equal(all[2].label, 'Maya');
  const ins = (q) => mentionCandidates(b, q).map(c => c.insert);
  assert.deepEqual(ins('ma'), ['@image3']);                      // Maya — not "cine·ma·tography"
  assert.deepEqual(ins('char'), ['@image3', '@image5']);         // by section
  assert.deepEqual(ins('4'), ['@image3'], 'a number finds the image — Maya\'s second view');
  assert.deepEqual(ins('image6'), ['@image6']);
  assert.equal(ins('image').length, 5, '@image lists every image');
  assert.deepEqual(ins('cine'), ['@image1']);                    // a word of its section
  assert.deepEqual(ins('room'), ['@image2']);                    // inside a word, from 3 letters
  assert.deepEqual(ins('ro'), []);                               // …but not from 2
  assert.deepEqual(ins('גב'), ['גביע']);
  assert.deepEqual(mentionCandidates(b, 'zzz'), []);
  assert.deepEqual(mentionCandidates(newBrief()), []);           // empty blocks aren't references
  assert.deepEqual(mentionCandidates(framesBrief()).map(c => c.insert), ['@image1', '@image2']);
});
