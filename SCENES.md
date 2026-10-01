# Scenes inside a project

_Built 2026-10-01. The spec this follows was written the same day; this file is what shipped._

## What a scene is

A project splits into scenes so its work stays in order. **Tools and settings stay with the
project; content and conversations live with a scene.**

| Project level | Scene level |
|---|---|
| Gems and their ⚙ Tune (one definition, every scene) | Each gem's chat |
| Assets | Name + brief |
| Kept references | Images (`sceneId`) |
| One Library (filtered by scene) | The Video tab's brief and NB Frames' reference board (browser memory) |

**General** is always first. It can't be renamed or deleted and has no brief. Everything made
before scenes existed lives there, and so does work that isn't in any scene: look development,
tests, a storyboard of the whole script.

## In the app

- **The strip under the tabs** shows General, then the scenes in order (`1 · Opening`), then
  `＋ Scene`. The number is the scene's place in the strip. The strip scrolls sideways when there
  are many scenes. The last scene opened is remembered per project. The strip is hidden in Assets,
  which belong to the whole project.
- **Gem tabs** show the open scene's chat with that gem. Switching scene keeps the tab. *Clear*
  empties only this scene's chat.
- **Nano Banana, Swap / Edit and Library uploads** tag what they make with the open scene.
  Nano Banana's results show that scene's images.
- **Library** shows the open scene's images. *All scenes* shows the whole project, with each card
  naming its scene. All / Liked / Approved filter on top of either view.
- **Managing scenes:**
  - `＋ Scene` creates one, with a name and an optional brief.
  - `✎` on a chip edits or deletes it.
  - Drag chips to reorder them. General stays first.
- **Moving an image:** drop it on a scene's chip, or use the scene label on its card. Assets can't
  be moved; they belong to the project.
- **Deleting a scene** deletes its chats. Its images move to General. No image is ever deleted.
- **Unsent work is kept per scene:** composer text and images, the Nano Banana prompt with its
  references, the Video brief and the NB Frames board. Switching scenes never carries one scene's
  half-written brief into another.

## Chat context

A message in a scene gets, in order:

1. The project gem (base + Tune), unchanged.
2. The scene's brief, if it has one. It is a separate block after the gem (`sceneBriefBlock` in
   `server/scenes.js`), names the scene's number and name, and is marked as background.
3. History from that gem's chat in that scene only.

The usual rule still applies: a turn with new images starts fresh. General behaves exactly as before.

## Data

Firestore, under `projects/{pid}` (the local `project.json` mirrors it):

- `scenes/{sceneId}` holds `{ id, title, brief, order, createdAt, updatedAt }`. `order` is numeric,
  so a reorder writes only the scene that moved (a halfway value); scenes are renumbered only when
  a gap gets too thin.
- Chats:
  - General's chat with a gem keeps the id `{gemId}`.
  - A scene's chat is `{sceneId}~{gemId}`.
  - Scene and gem are read from the id and never stored as fields, because `saveProject` rewrites
    chat docs with `messages` only.
- Images get `sceneId`.
  - No field means General.
  - A `sceneId` whose scene no longer exists also counts as General (e.g. an image that finished
    while its scene was being deleted).
- Scene ids are `sc` + 16 hex characters. Anything else a request sends means General
  (`cleanSceneId`).
- Media paths don't change, and no migration is needed.

## Server

- `GET /api/projects/:pid` also returns `scenes`.
- Scene routes:
  - `POST /api/projects/:pid/scenes` with `{ title, brief? }` adds a scene at the end of the strip.
  - `PATCH …/scenes/:sceneId` with `{ title?, brief?, order? }` edits one.
  - `DELETE …/scenes/:sceneId` deletes the scene and its chats and moves its images to General
    (`data.deleteScene`, one queued job).
- Chat routes:
  - `POST /chat` and `POST /chat/clear` take an optional `sceneId`.
  - `/chat` refuses a deleted scene.
- Image routes:
  - `POST /generate`, `POST /swap` and `POST /images/upload` take `sceneId` and store it.
  - `PATCH /images/:imgId` with `{ sceneId }` moves an image (`''` means General).
- Expenses (`server/usage.js`) reads the gem from the part of a chat id after `~`, so totals are
  the same before and after scenes.

## Acceptance checks (tested 2026-10-01)

- An existing project opens as before: General is active, with all its chats and images.
- A message in scene 1 is not in the history sent from scene 2, even with the same gem.
- An image made in scene 2 shows in scene 2's Library and not in scene 1's.
- Deleting a scene deletes no image.
- A Tune change applies to every scene.
- A scene chat costs the same in Expenses as the same chat in General.

## Later

- "Create scenes" from a script storyboard's `FRAME k — title` list.
- A thumbnail on each chip from the scene's last ✓-approved image.
- A Video brief that persists per scene. Pasted images would need uploading first.
- Moving several images at once.
- Tagging videos with scenes.
