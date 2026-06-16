// ── Project metadata seam ───────────────────────────────────────────────────
// Project records (name, chats, gem settings, image list) flow through this module
// so the metadata backend is swappable. Today: local JSON at
// projects-data/<pid>/project.json. Phase 1 can drop in a database (e.g. Postgres)
// behind the SAME interface — no route code changes.
//
// Interface:
//   getProject(pid)    -> project object
//   saveProject(p)     -> project object (persisted)
//   listProjects()     -> [{ id, name, createdAt, updatedAt, imageCount, chatCount }]
//   deleteProject(pid) -> void
import fsp from 'fs/promises';
import path from 'path';

function createLocalDataStore(dataDir) {
  const projDir = (pid) => path.join(dataDir, pid);
  const metaPath = (pid) => path.join(projDir(pid), 'project.json');
  return {
    backend: 'local',
    async getProject(pid) {
      return JSON.parse(await fsp.readFile(metaPath(pid), 'utf8'));
    },
    async saveProject(p) {
      await fsp.mkdir(projDir(p.id), { recursive: true });
      await fsp.writeFile(metaPath(p.id), JSON.stringify(p, null, 2));
      return p;
    },
    async listProjects() {
      const entries = await fsp.readdir(dataDir, { withFileTypes: true });
      const projects = [];
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        try {
          const p = JSON.parse(await fsp.readFile(metaPath(e.name), 'utf8'));
          const imageCount = (p.images || []).length;
          const chatCount = Object.values(p.chats || {}).reduce((n, arr) => n + (arr?.length || 0), 0);
          projects.push({ id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt, imageCount, chatCount });
        } catch { /* skip dirs that aren't projects */ }
      }
      projects.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      return projects;
    },
    async deleteProject(pid) {
      await fsp.rm(projDir(pid), { recursive: true, force: true });
    },
  };
}

export function createDataStore(dataDir, { backend = process.env.DATA_BACKEND || 'local' } = {}) {
  if (backend === 'local') return createLocalDataStore(dataDir);
  // Phase 1: if (backend === 'postgres') return createPostgresDataStore(...);
  throw new Error(`Unknown DATA_BACKEND "${backend}" (expected "local")`);
}
