import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Generator } from '../src/server/generator.js';
import { Library } from '../src/server/projects.js';
import { Computer } from '../src/server/computer.js';

const projects = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'projects');

// A stand-in for tools/media/generate.py: it speaks the same line-by-line language, but makes
// nothing and costs nothing. FAKE_MODE decides how it ends.
const FAKE = `
const args = process.argv.slice(2);
const out = args[args.indexOf('--out') + 1];
console.log(JSON.stringify({ stage: 'image', progress: 0.2, message: 'Drawing the character' }));
console.log('this line is not JSON and must be ignored');
console.log(JSON.stringify({ stage: 'dance', progress: 0.7, message: 'Teaching the dance' }));
if (process.env.FAKE_MODE === 'fail') { console.log(JSON.stringify({ error: 'The cloud said no.' })); process.exit(3); }
if (process.env.FAKE_MODE === 'crash') { console.error('boom'); process.exit(1); }
console.log(JSON.stringify({ done: true, media: out + '/media.json', costUsdEstimate: 0.35 }));
`;

async function setup() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cinco-id-gen-'));
  const script = path.join(temp, 'fake-generate.mjs');
  await fs.writeFile(script, FAKE);
  await fs.cp(projects, path.join(temp, 'projects'), { recursive: true });
  const generator = new Generator({ python: process.execPath, script });
  return { temp, generator, cleanup: () => fs.rm(temp, { recursive: true, force: true }) };
}

test('the generator reports progress, the result and failures in plain words', async () => {
  const { temp, generator, cleanup } = await setup();
  try {
    const updates = [];
    const result = await generator.run({ name: 'Disco Grandma', prompt: 'a grandmother in a gold tracksuit', out: path.join(temp, 'x') }, update => updates.push(update));
    assert.equal(result.done, true);
    assert.equal(result.costUsdEstimate, 0.35);
    assert.deepEqual(updates.map(update => update.message), ['Drawing the character', 'Teaching the dance']);

    process.env.FAKE_MODE = 'fail';
    await assert.rejects(generator.run({ name: 'X', prompt: 'x', out: temp }), /The cloud said no\./);
    process.env.FAKE_MODE = 'crash';
    await assert.rejects(generator.run({ name: 'X', prompt: 'x', out: temp }), /boom/);
  } finally {
    delete process.env.FAKE_MODE;
    await cleanup();
  }
});

test('asking for a new sequence makes it in the background and offers it as a beta sequence', async () => {
  const { temp, generator, cleanup } = await setup();
  try {
    const library = await new Library(path.join(temp, 'projects')).reload();
    const computer = new Computer({ library, config: { operator: 'Paul', defaultProject: '4d3d3d3' }, generator });
    const actions = [];
    computer.on('action', action => actions.push(action));
    const said = () => actions.filter(action => action.type === 'say').map(action => action.text);
    computer.revealed.add('4d3d3d3/tayne'); // so the new one is the only beta left

    await computer.hear('generate a new sequence of a grandmother in a gold tracksuit doing disco moves');
    assert.equal(said().at(-1), 'Working on it.');
    assert.ok([...computer.windows.values()].some(window => window.kind === 'progress'));
    await new Promise(resolve => { const wait = () => (computer.jobs.size ? setTimeout(wait, 20) : resolve()); wait(); });
    await new Promise(resolve => setTimeout(resolve, 50));

    assert.equal(said().at(-1), 'Paul, I have a new BETA sequence.');
    assert.ok(actions.some(action => action.type === 'progress' && action.text === 'Teaching the dance'));
    assert.ok(![...computer.windows.values()].some(window => window.kind === 'progress'), 'the progress window closes');
    const made = library.allSequences().find(sequence => sequence.name === 'A Grandmother In');
    assert.ok(made?.beta, 'the new sequence exists and is held back');

    await computer.hear('do we have any new sequences?');
    assert.equal(said().at(-1), 'I have a BETA sequence I have been working on. Would you like to see it?');
    await computer.hear('alright');
    assert.equal(said().at(-1), 'A Grandmother In.');

    // A failed attempt leaves nothing behind.
    process.env.FAKE_MODE = 'fail';
    await computer.hear('generate a sequence of a robot butler');
    await new Promise(resolve => { const wait = () => (computer.jobs.size ? setTimeout(wait, 20) : resolve()); wait(); });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(said().at(-1), 'The new sequence did not work out, Paul.');
    assert.ok(!library.allSequences().some(sequence => /robot/i.test(sequence.name)));
  } finally {
    delete process.env.FAKE_MODE;
    await cleanup();
  }
});
