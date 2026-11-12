import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { bestMatch, hexFromSpeech, normalize, squash, editDistance } from './text.js';

const HEX_ID = /^[0-9a-f]{1,16}$/;
const GENERATING = '.generating'; // marker: this dancer is still being made

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`${file} could not be read: ${error.message}`);
  }
}

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

function mergePuppet(base, override) {
  if (!base && !override) return null;
  return {
    ...(base ?? {}),
    ...(override ?? {}),
    style: { ...(base?.style ?? {}), ...(override?.style ?? {}) },
  };
}

/** Reads generated media for one folder. Missing or broken media simply means "use the puppet". */
async function loadMedia(dir, urlBase) {
  const media = await readJson(path.join(dir, 'media.json')).catch(() => null);
  if (!media?.clip || !(await exists(path.join(dir, media.clip)))) return null;
  const stills = {};
  for (const [name, file] of Object.entries(media.stills ?? {})) {
    if (await exists(path.join(dir, file))) stills[name] = { file: path.join(dir, file), url: `${urlBase}/${file}` };
  }
  return {
    clip: { file: path.join(dir, media.clip), url: `${urlBase}/${media.clip}` },
    width: media.width ?? null,
    height: media.height ?? null,
    fps: media.fps ?? null,
    hatLine: typeof media.hatLine === 'number' ? media.hatLine : null,
    stills,
  };
}

async function loadSequence(projectId, dir, id) {
  const spec = await readJson(path.join(dir, 'sequence.json'));
  if (!spec?.name) return null;
  const urlBase = `/projects/${projectId}/sequences/${id}`;
  const media = await loadMedia(dir, urlBase);
  const variants = {};
  for (const [name, variant] of Object.entries(spec.variants ?? {})) {
    const variantMedia = await loadMedia(path.join(dir, name), `${urlBase}/${name}`);
    variants[name] = {
      name,
      gated: variant.gated === true,
      puppet: mergePuppet(spec.puppet, variant.puppet),
      media: variantMedia,
      hatLine: variantMedia?.hatLine ?? variant.hatLine ?? null,
    };
  }
  return {
    key: `${projectId}/${id}`,
    id,
    projectId,
    dir,
    name: spec.name,
    aliases: spec.aliases ?? [],
    beta: spec.beta === true,
    hatLine: media?.hatLine ?? spec.hatLine ?? 0.25,
    expressions: spec.expressions ?? [],
    puppet: spec.puppet ?? null,
    media,
    variants,
    description: spec.description ?? '',
    music: typeof spec.music === 'string' ? spec.music : null, // which of the band's tunes plays for this dancer
  };
}

/** Everything the computer can load, read fresh from the projects folder. */
export class Library {
  constructor(root) {
    this.root = root;
    this.projects = new Map();
  }

  async reload() {
    const projects = new Map();
    let entries = [];
    try { entries = await fs.readdir(this.root, { withFileTypes: true }); } catch { /* no projects yet */ }
    for (const entry of entries) {
      if (!entry.isDirectory() || !HEX_ID.test(entry.name)) continue;
      const dir = path.join(this.root, entry.name);
      const spec = (await readJson(path.join(dir, 'project.json'))) ?? {};
      const sequences = [];
      let folders = [];
      try { folders = await fs.readdir(path.join(dir, 'sequences'), { withFileTypes: true }); } catch { /* empty project */ }
      for (const folder of folders.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!folder.isDirectory()) continue;
        if (await exists(path.join(dir, 'sequences', folder.name, GENERATING))) continue; // still being made
        const sequence = await loadSequence(entry.name, path.join(dir, 'sequences', folder.name), folder.name);
        if (sequence) sequences.push(sequence);
      }
      projects.set(entry.name, {
        id: entry.name,
        dir,
        name: spec.name ?? entry.name,
        description: spec.description ?? '',
        show: { windows: 24, effects: ['tumble'], drift: true, ...(spec.show ?? {}) },
        sequences,
      });
    }
    this.projects = projects;
    return this;
  }

  allSequences() {
    return [...this.projects.values()].flatMap(project => project.sequences);
  }

  sequence(key) {
    return this.allSequences().find(sequence => sequence.key === key) ?? null;
  }

  /** Finds a sequence by what a person called it. Forgiving about spelling. */
  findSequence(query) {
    const candidates = this.allSequences().map(sequence => ({
      key: sequence.key, sequence, labels: [sequence.name, sequence.id, ...sequence.aliases],
    }));
    return bestMatch(query, candidates)?.sequence ?? null;
  }

  /** Finds a project by its hex id, however it was said, allowing a small slip for long ids. */
  findProject(query) {
    const spoken = hexFromSpeech(query) ?? squash(query);
    if (this.projects.has(spoken)) return this.projects.get(spoken);
    const byName = bestMatch(query, [...this.projects.values()].map(project => ({
      key: project.id, project, labels: [project.name],
    })), { maxRatio: 0.2 });
    if (byName) return byName.project;
    let best = null;
    let bestDistance = Infinity;
    for (const project of this.projects.values()) {
      if (project.id.length < 5 || !HEX_ID.test(spoken)) continue;
      const distance = editDistance(spoken, project.id);
      if (distance <= 2 && distance < bestDistance) { best = project; bestDistance = distance; }
    }
    return best;
  }

  /** Words worth telling the speech recogniser about. */
  vocabulary() {
    const words = new Set();
    for (const project of this.projects.values()) {
      words.add(project.id);
      for (const sequence of project.sequences) words.add(sequence.name);
    }
    return [...words];
  }

  /** Makes a new empty project with a fresh hex id. */
  async createProject(name, wantedId) {
    let id = wantedId && HEX_ID.test(wantedId) ? wantedId : null;
    while (!id || this.projects.has(id)) id = randomBytes(4).toString('hex').slice(0, 7);
    const dir = path.join(this.root, id);
    await fs.mkdir(path.join(dir, 'sequences'), { recursive: true });
    await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify({
      name: name?.trim() || `Project ${id}`,
      description: '',
      show: { windows: 20, effects: ['tumble'], drift: true },
    }, null, 2) + '\n');
    await this.reload();
    return this.projects.get(id);
  }

  /**
   * Folder for a new sequence inside a project, with a safe folder name. It carries a marker
   * file while the dancer is being made, so a half-made one is never offered and can be
   * cleared away if the app stopped in the middle.
   */
  async prepareSequence(projectId, name, spec = {}) {
    const project = this.projects.get(projectId);
    if (!project) throw new Error(`There is no project ${projectId}.`);
    const base = normalize(name).replace(/\s+/g, '-').slice(0, 40) || 'sequence';
    let id = base;
    const taken = async candidate => project.sequences.some(sequence => sequence.id === candidate) || await exists(path.join(project.dir, 'sequences', candidate));
    for (let n = 2; await taken(id); n++) id = `${base}-${n}`;
    const dir = path.join(project.dir, 'sequences', id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, GENERATING), JSON.stringify({ started: new Date().toISOString(), pid: process.pid }) + '\n');
    await fs.writeFile(path.join(dir, 'sequence.json'), JSON.stringify({
      name: name.trim(), aliases: [], beta: true, hatLine: 0.25, expressions: [], ...spec,
    }, null, 2) + '\n');
    return { id, dir, key: `${projectId}/${id}` };
  }

  /** The new dancer is complete: take the marker away so it can be offered. */
  async finishSequence(dir) {
    await fs.rm(path.join(dir, GENERATING), { force: true });
  }

  /** Removes dancers that were still being made when the app last stopped. Returns their folders. */
  async removeUnfinished() {
    const removed = [];
    let projects = [];
    try { projects = await fs.readdir(this.root, { withFileTypes: true }); } catch { return removed; }
    for (const project of projects) {
      if (!project.isDirectory() || !HEX_ID.test(project.name)) continue;
      let folders = [];
      try { folders = await fs.readdir(path.join(this.root, project.name, 'sequences'), { withFileTypes: true }); } catch { continue; }
      for (const folder of folders) {
        const dir = path.join(this.root, project.name, 'sequences', folder.name);
        if (folder.isDirectory() && await exists(path.join(dir, GENERATING))) {
          await fs.rm(dir, { recursive: true, force: true });
          removed.push(dir);
        }
      }
    }
    return removed;
  }
}
