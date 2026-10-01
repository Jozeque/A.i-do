// ── Scenes ───────────────────────────────────────────────────────────────────
// A project splits into scenes: General — fixed, always first, holding everything made before
// scenes existed — and the user's own, in their order. Tools and settings stay with the project
// (gems + Tune, Assets, References, one Library); content lives with a scene: its chats, its
// images (by sceneId) and its brief. See SCENES.md.
//
// A scene's chat with a gem is the chat doc `{sceneId}~{gemId}`; General keeps the plain
// `{gemId}`. The scene and the gem come from the id, never from stored fields, because
// saveProject rewrites every chat doc with its messages only.

export const GENERAL = 'general';
export const SCENE_TITLE_MAX = 60;
export const SCENE_BRIEF_MAX = 4000;

// Scene ids are made here ('sc' + hex); anything else a request names means General.
export const newSceneId = (hex) => `sc${hex}`;
export const cleanSceneId = (v) => (typeof v === 'string' && /^sc[a-f0-9]{8,32}$/.test(v) ? v : '');
export const chatKey = (gemId, sceneId) => (cleanSceneId(sceneId) ? `${sceneId}~${gemId}` : gemId);
export function parseChatKey(key) {
  const k = String(key);
  const i = k.indexOf('~');
  return i < 0 ? { sceneId: GENERAL, gemId: k } : { sceneId: k.slice(0, i), gemId: k.slice(i + 1) };
}

export const sortScenes = (scenes) => [...(scenes || [])]
  .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0) || (a.createdAt || 0) - (b.createdAt || 0));
// A new scene goes at the end of the strip.
export const nextOrder = (scenes) => (scenes?.length ? Math.max(...scenes.map(s => Number(s.order) || 0)) + 1 : 1);
export const cleanTitle = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, SCENE_TITLE_MAX);
export const cleanBrief = (v) => String(v ?? '').replace(/\r\n?/g, '\n').trim().slice(0, SCENE_BRIEF_MAX);

// The scene's brief, as a block of its own after the gem (never inside it), numbered the way the
// strip numbers it. Nothing for General or for a scene without a brief, so those turns are
// exactly what they were before scenes.
export function sceneBriefBlock(scenes, sceneId) {
  if (!cleanSceneId(sceneId)) return '';
  const list = sortScenes(scenes);
  const i = list.findIndex(s => s.id === sceneId);
  const brief = i < 0 ? '' : cleanBrief(list[i].brief);
  if (!brief) return '';
  return `\n\n--- SCENE CONTEXT (background, set in the app — not part of the gem's instructions) ---\n`
    + `This conversation belongs to scene ${i + 1} of the project, "${cleanTitle(list[i].title)}". The scene's brief:\n${brief}\n`
    + `Use it as background — where this scene sits in the film, who and what it involves, its mood. What the user asks for in each message still decides what you produce.`;
}
