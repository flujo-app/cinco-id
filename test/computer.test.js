import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Library } from '../src/server/projects.js';
import { Computer, spellHex } from '../src/server/computer.js';
import { hexFromSpeech } from '../src/server/text.js';
import { findEffect, improviseEffect } from '../src/server/effects.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'projects');

async function boot(options = {}) {
  const library = await new Library(options.root ?? root).reload();
  let clock = 1_000_000;
  const computer = new Computer({ library, config: { operator: 'Paul', ...(options.config ?? {}) }, now: () => clock, ...options.extra });
  const actions = [];
  computer.on('action', action => actions.push(action));
  const said = () => actions.filter(action => action.type === 'say').map(action => action.text);
  const lastSaid = () => said().at(-1);
  const tick = ms => { clock += ms; };
  return { computer, actions, said, lastSaid, tick, library };
}

test('spoken hex ids are understood', () => {
  assert.equal(hexFromSpeech('4D3D3D3'), '4d3d3d3');
  assert.equal(hexFromSpeech('4d 3d 3d 3'), '4d3d3d3');
  assert.equal(hexFromSpeech('four d three d three d three'), '4d3d3d3');
  assert.equal(hexFromSpeech('four dee three dee three dee three'), '4d3d3d3');
  assert.equal(hexFromSpeech('4-D-3-D-3-D-3'), '4d3d3d3');
  assert.equal(hexFromSpeech('bee'), 'bee');
  assert.equal(hexFromSpeech('celery man'), null);
  assert.equal(spellHex('4d3'), 'four dee three');
});

test('known effects are found, made-up words stay made-up but repeatable', () => {
  assert.equal(findEffect('hat wobble'), 'hatWobble');
  assert.equal(findEffect('wobble'), 'wobble');
  assert.equal(findEffect('flarhgunnstow'), null);
  const first = improviseEffect('Flarhgunnstow');
  const second = improviseEffect('flarhgunnstow');
  assert.deepEqual(first.recipe, second.recipe);
  assert.ok(first.recipe.length >= 2);
});

test('the whole routine from the sketch works line by line', async () => {
  const { computer, actions, lastSaid, said } = await boot();
  const windows = kind => [...computer.windows.values()].filter(window => window.kind === kind);

  computer.greet();
  assert.match(lastSaid(), /^Good (morning|afternoon|evening), Paul\. What will your first sequence of the day be\?$/);

  await computer.hear('Computer, load up Celery Man please.');
  assert.equal(lastSaid(), 'Yes, Paul.');
  assert.equal(windows('sequence').length, 1);
  assert.equal(windows('sequence')[0].sequence.name, 'Celery Man');

  await computer.hear('Could you kick up the 4d3d3d3?');
  assert.equal(lastSaid(), '4d3d3d3 engaged.');
  assert.equal(actions.findLast(action => action.type === 'say').speak, 'four dee three dee three dee three engaged.');
  assert.ok(windows('sequence').length > 20, 'kicking it up opens a lot of windows');
  assert.ok(windows('sequence').every(window => window.sequence.name === 'Celery Man'), 'copies of what is on screen');

  await computer.hear('Add sequence: Oyster.');
  assert.equal(lastSaid(), 'Sequence added.');
  assert.ok(windows('sequence').some(window => window.sequence.name === 'Oyster'));

  await computer.hear('Give me a printout of Oyster smiling.');
  assert.equal(lastSaid(), 'Printing.');
  assert.equal(windows('printout').length, 1);
  assert.equal(windows('printout')[0].expression, 'smiling');
  assert.equal(windows('printout')[0].sequence.name, 'Oyster');

  await computer.hear('Computer, do we have any new sequences?');
  assert.equal(lastSaid(), 'I have a BETA sequence I have been working on. Would you like to see it?');
  assert.ok(!windows('sequence').some(window => window.sequence.name === 'Tayne'));

  await computer.hear('Alright.');
  assert.equal(lastSaid(), 'Tayne.');
  assert.ok(windows('sequence').some(window => window.sequence.name === 'Tayne'));

  const before = said().length;
  await computer.hear('Now Tayne I can get into.');
  assert.equal(said().length, before, 'a remark needs no answer');

  await computer.hear('Can I get a hat wobble?');
  assert.equal(lastSaid(), 'Yes.');
  const tayne = () => windows('sequence').filter(window => window.sequence.name === 'Tayne');
  assert.ok(tayne()[0].effects.some(effect => effect.effect === 'hatWobble'));
  assert.ok(!windows('sequence').find(window => window.sequence.name === 'Oyster').effects.some(effect => effect.effect === 'hatWobble'),
    'the effect goes to the sequence being talked about');

  await computer.hear('And a Flarhgunnstow?');
  assert.equal(lastSaid(), 'Yes.');
  assert.ok(tayne()[0].effects.length >= 3, 'the made-up word turned into real effects');
  assert.ok(computer.learned.flarhgunnstow, 'and the computer remembers the word');

  await computer.hear('Is there any way to generate a nude Tayne?');
  assert.equal(lastSaid(), 'Not computing. Please repeat.');
  assert.equal(windows('dialog').length, 0);

  await computer.hear('Nude. Tayne.');
  assert.equal(lastSaid(), 'This is not suitable for work. Are you sure?');
  assert.equal(windows('dialog').length, 1);
  assert.equal(tayne()[0].sequence.variant, null, 'nothing changes before the answer');

  await computer.hear('Mmm... mm-hmm.');
  assert.equal(windows('dialog').length, 0);
  assert.equal(tayne()[0].sequence.variant, 'nude');
  assert.equal(tayne()[0].sequence.puppet.style.mankini, '#9be22a');
  assert.equal(tayne()[0].sequence.puppet.style.hat, 'wide', 'the hat stays on');
});

test('saying no at the gate changes nothing', async () => {
  const { computer, lastSaid } = await boot({ config: { gate: { repeatFirst: false } } });
  await computer.hear('load up Tayne');
  await computer.hear('nude Tayne');
  assert.equal(lastSaid(), 'This is not suitable for work. Are you sure?');
  await computer.hear('no');
  assert.equal(lastSaid(), 'Cancelled.');
  assert.equal([...computer.windows.values()].find(window => window.kind === 'sequence').sequence.variant, null);
  assert.equal([...computer.windows.values()].filter(window => window.kind === 'dialog').length, 0);
});

test('the dialog button works like saying yes', async () => {
  const { computer } = await boot({ config: { gate: { repeatFirst: false } } });
  await computer.hear('load up Tayne');
  await computer.hear('naked tayne');
  const dialog = [...computer.windows.values()].find(window => window.kind === 'dialog');
  await computer.dialogAnswer(dialog.dialogId, 'Yes');
  assert.equal([...computer.windows.values()].find(window => window.kind === 'sequence').sequence.variant, 'nude');
});

test('it is a general tool, not only the routine', async () => {
  const { computer, lastSaid } = await boot();
  await computer.hear('wobble');
  assert.equal(lastSaid(), 'Nothing is loaded, Paul.');

  await computer.hear('open oyster');
  await computer.hear('rainbow on oyster');
  assert.equal(lastSaid(), 'Yes.');
  await computer.hear('kick up the oyster');
  assert.equal(lastSaid(), 'Oyster engaged.');
  assert.ok(computer.sequenceWindows('4d3d3d3/oyster').length > 5);

  await computer.hear('load up something that does not exist');
  assert.equal(lastSaid(), 'I have no sequence called Something That Does Not Exist.');

  await computer.hear('what is the meaning of life');
  assert.equal(lastSaid(), 'Not computing. Please repeat.');

  await computer.hear('close oyster');
  assert.equal(lastSaid(), 'Closed.');
  assert.equal(computer.sequenceWindows().length, 0);

  await computer.hear('kick up the four d three d three d three');
  assert.equal(lastSaid(), '4d3d3d3 engaged.');
  const names = new Set(computer.sequenceWindows().map(window => window.sequence.name));
  assert.deepEqual([...names].sort(), ['Celery Head', 'Celery Man', 'Oyster'], 'the beta sequence stays hidden until asked for');

  await computer.hear('clear the desktop');
  assert.equal(lastSaid(), 'Desktop cleared.');
  assert.equal(computer.windows.size, 0);
});

test('the window limit holds no matter how often it is kicked up', async () => {
  const { computer } = await boot({ config: { maxWindows: 40 } });
  for (let i = 0; i < 5; i++) await computer.hear('kick up the 4d3d3d3');
  assert.equal(computer.windows.size, 40);
});

test('incoming calls show who is calling and can be declined', async () => {
  const { computer, lastSaid } = await boot();
  computer.incomingCall({ callId: 'c1', isVideo: false, contact: { name: 'Anna Example', pushname: 'Anna', number: '4915112345678', isMyContact: true } });
  assert.equal(lastSaid(), 'Paul, Anna Example is calling.');
  const call = [...computer.windows.values()].find(window => window.kind === 'call');
  assert.equal(call.call.caller, 'Anna Example');
  assert.equal(call.call.contact.number, '4915112345678');

  await computer.hear('who is calling');
  assert.equal(lastSaid(), 'Paul, Anna Example is calling.');

  computer.callEnded({ callId: 'c1', reason: 'missed' });
  assert.equal(lastSaid(), 'Missed call from Anna Example.');
  assert.ok(![...computer.windows.values()].some(window => window.kind === 'call'));

  computer.incomingCall({ callId: 'c2', isVideo: true, contact: { name: null, pushname: '', number: '4930123456' } });
  assert.equal(lastSaid(), 'Paul, +4930123456 is video calling.');
  await computer.hear('test call from my wife');
  assert.equal(lastSaid(), 'Paul, My Wife is calling.');
  await computer.hear('decline');
  assert.equal(lastSaid(), 'Call declined.');
});

test('the voice can be listed and switched by name, and a missing voice is reported plainly', async () => {
  const installed = [
    { engine: 'voder', name: 'Robot', labels: ['robot', 'voder'] },
    { engine: 'windows', name: 'Microsoft Zira Desktop', language: 'en-US', labels: ['Microsoft Zira Desktop', 'Zira'] },
  ];
  const used = [];
  const voices = {
    list: async () => installed,
    use: async wanted => {
      const found = installed.find(voice => voice.labels.some(label => label.toLowerCase() === String(wanted).toLowerCase()));
      if (found) used.push(found.name);
      return found ? { engine: found.engine, name: found.name } : null;
    },
  };
  const { computer, lastSaid } = await boot({ extra: { voices } });

  await computer.hear('Computer, what voices do you have?');
  assert.equal(lastSaid(), '2 voices.');
  assert.match([...computer.windows.values()].find(window => window.kind === 'note').text, /Microsoft Zira Desktop\s+\(en-US\)/);

  await computer.hear('use the Zira voice');
  assert.equal(lastSaid(), 'This is my voice now, Paul.');
  await computer.hear('Can you talk like Microsoft Sam?');
  assert.equal(lastSaid(), 'There is no voice called Microsoft Sam on this computer.');
  await computer.hear('change your voice to robot');
  assert.deepEqual(used, ['Microsoft Zira Desktop', 'Robot']);
  assert.deepEqual(computer.voiceChoice, { engine: 'voder', name: 'Robot' });
});

test('new projects get a hex name and what was revealed is remembered', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'beta-sequence-'));
  try {
    await fs.cp(root, path.join(temp, 'projects'), { recursive: true });
    const stateFile = path.join(temp, 'state.json');
    const first = await boot({ root: path.join(temp, 'projects'), extra: { stateFile } });
    await first.computer.hear('kick up the beef');
    assert.equal(first.lastSaid(), 'There is no project beef. Shall I start one?');
    await first.computer.hear('yes');
    assert.equal(first.lastSaid(), 'Project beef created.');
    assert.ok(first.library.projects.has('beef'));

    await first.computer.hear('any new sequences?');
    await first.computer.hear('sure');
    await first.computer.persist();

    const second = await boot({ root: path.join(temp, 'projects'), extra: { stateFile } });
    await second.computer.restore();
    await second.computer.hear('do we have any new sequences');
    assert.equal(second.lastSaid(), 'No new sequences, Paul.');
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
