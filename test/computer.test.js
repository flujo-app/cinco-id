import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Library } from '../src/server/projects.js';
import { Computer, spellHex } from '../src/server/computer.js';
import { hexFromSpeech } from '../src/server/text.js';
import { findEffect, improviseEffect, showVariation } from '../src/server/effects.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'projects');

async function boot(options = {}) {
  const library = await new Library(options.root ?? root).reload();
  let clock = 1_000_000;
  // pace.beta 0: no waiting at the "Loading BETA, please wait..." bar in tests.
  const computer = new Computer({ library, config: { operator: 'Paul', pace: { beta: 0 }, ...(options.config ?? {}) }, now: () => clock, ...options.extra });
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
  assert.equal(findEffect('flarhgunnstow'), 'flarhgunnstow', 'the number from the sketch is a known one');
  assert.equal(findEffect('Flargunstow'), 'flarhgunnstow', 'however the microphone spells it');
  assert.equal(findEffect('blorptangle'), null);
  const first = improviseEffect('Blorptangle');
  const second = improviseEffect('blorptangle');
  assert.deepEqual(first.recipe, second.recipe);
  assert.ok(first.recipe.length >= 2);
  // A word the computer once learned must not hide a real effect of the same name.
  assert.equal(findEffect('flarhgunnstow', { flarhgunnstow: first }), 'flarhgunnstow');
  assert.equal(findEffect('wobble', { wobble: first }), 'wobble');
});

test('a big show mixes whole dancers on white with close-ups on pink', () => {
  const shots = Array.from({ length: 60 }, (_, i) => showVariation(i, 'demo', ['tumble']));
  assert.ok(shots.some(shot => shot.shot === 'closeup' && shot.backdrop === 'pink'));
  assert.ok(shots.filter(shot => shot.shot === 'full' && shot.backdrop === 'white').length > 20);
  assert.ok(shots.every(shot => ['full', 'closeup'].includes(shot.shot) && ['white', 'pink', 'pastel', 'blue'].includes(shot.backdrop)));
  assert.deepEqual(showVariation(7, 'demo', ['tumble']), showVariation(7, 'demo', ['tumble']), 'the same every time');
});

test('the whole routine from the sketch works line by line', async () => {
  const { computer, actions, lastSaid, said } = await boot();
  const windows = kind => [...computer.windows.values()].filter(window => window.kind === kind);

  computer.greet();
  assert.match(lastSaid(), /^Good (morning|afternoon|evening), Paul\. What will your first sequence of the day be\?$/);

  await computer.hear('Computer, load up Celery Man please.');
  assert.equal(lastSaid(), 'Yes, Paul.');
  assert.deepEqual(windows('sequence').map(window => [window.sequence.name, window.title, window.shot, window.backdrop]),
    [['Celery Man', 'Celery Man', 'full', 'white'], ['Celery Man', 'Celery Man', 'closeup', 'pink']],
    'as in the sketch: the whole dancer on white and a close-up on pink');

  await computer.hear('Could you kick up the 4d3d3d3?');
  assert.equal(lastSaid(), '4d3d3d3 Engaged.');
  assert.equal(actions.findLast(action => action.type === 'say').speak, 'four dee three dee three dee three Engaged.');
  assert.ok(windows('sequence').length > 20, 'kicking it up opens a lot of windows');
  assert.ok(windows('sequence').every(window => window.sequence.name === 'Celery Man'), 'copies of what is on screen');

  await computer.hear('Add sequence: Oyster.');
  assert.equal(lastSaid(), 'Sequence added.');
  assert.deepEqual(windows('sequence').filter(window => window.sequence.name === 'Oyster').map(window => [window.shot, window.size, window.backdrop]),
    [['full', 'wide', 'pastel'], ['closeup', 'medium', 'pink']], 'the added sequence gets the wide pastel window');

  await computer.hear('Give me a printout of Oyster smiling.');
  assert.equal(lastSaid(), 'Printing.');
  assert.equal(windows('printout').length, 1);
  assert.equal(windows('printout')[0].expression, 'smiling');
  assert.equal(windows('printout')[0].sequence.name, 'Oyster');

  await computer.hear('Computer, do we have any new sequences?');
  assert.equal(lastSaid(), 'I have a BETA sequence I have been working on. Would you like to see it?');
  assert.equal(actions.findLast(action => action.type === 'say').key, 'betaOffer', 'the screen is told this is the beta offer (it gets the big window)');
  assert.ok(!windows('sequence').some(window => window.sequence.name === 'Tayne'));

  await computer.hear('Alright.');
  assert.equal(lastSaid(), 'Tayne.');
  assert.deepEqual(windows('sequence').filter(window => window.sequence.name === 'Tayne').map(window => window.shot), ['face', 'title'],
    'the face in one window, the name in big letters in another');
  assert.equal(windows('progress').length, 0, 'the "Loading BETA" bar is gone again');

  const before = said().length;
  await computer.hear('Now Tayne I can get into.');
  assert.equal(said().length, before, 'a remark needs no answer');

  await computer.hear('Can I get a hat wobble?');
  assert.equal(lastSaid(), 'Yes.');
  const tayne = () => windows('sequence').filter(window => window.sequence.name === 'Tayne');
  assert.ok(tayne()[0].effects.some(effect => effect.effect === 'hatWobble'));
  assert.ok(!windows('sequence').find(window => window.sequence.name === 'Oyster').effects.some(effect => effect.effect === 'hatWobble'),
    'the effect goes to the sequence being talked about');
  const pile = tayne().filter(window => window.stack);
  assert.equal(pile.length, 6, 'a neat pile of Tayne windows, as in the sketch');
  assert.deepEqual(pile.map(window => window.stack.index), [0, 1, 2, 3, 4, 5]);
  assert.ok(pile.every(window => window.effects.some(effect => effect.effect === 'hatWobble')));
  const withHat = tayne().length;
  await computer.hear('hat wobble');
  assert.equal(tayne().length, withHat, 'asking again wobbles harder but opens nothing new');

  await computer.hear('And a Flarhgunnstow?');
  assert.equal(lastSaid(), 'Yes.');
  assert.deepEqual(tayne().map(window => [window.shot, window.effects.map(effect => effect.effect).join()]),
    [['full', 'free'], ['closeup', ''], ['closeup', ''], ['closeup', '']],
    'the dancer steps out of the window, with three close-ups beside it');
  assert.equal(computer.learned.flarhgunnstow, undefined, 'a known number is not a made-up word');
  assert.ok(windows('sequence').some(window => window.sequence.name === 'Oyster'), 'the others stay');

  await computer.hear('And a Blorptangle?');
  assert.equal(lastSaid(), 'Yes.');
  assert.ok(tayne()[0].effects.length >= 3, 'a made-up word turns into real effects');
  assert.ok(computer.learned.blorptangle, 'and the computer remembers the word');

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

test('the beta sequence loads behind a "please wait" bar', async () => {
  const { computer, lastSaid } = await boot({ config: { pace: { beta: 40 } } });
  const kinds = () => [...computer.windows.values()].map(window => window.kind);
  await computer.hear('any new sequences?');
  const answered = computer.hear('yes');
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(kinds(), ['progress']);
  assert.equal([...computer.windows.values()][0].text, 'Loading BETA, please wait...');
  await answered;
  assert.deepEqual(kinds(), ['sequence', 'sequence']);
  assert.equal(lastSaid(), 'Tayne.');
});

test('"choose a sequence" shows every dancer, the beta one only once it was revealed', async () => {
  const { computer } = await boot();
  const chooser = () => [...computer.windows.values()].filter(window => window.kind === 'chooser');
  await computer.hear('choose a sequence');
  assert.equal(chooser().length, 1);
  const demo = chooser()[0].projects.find(project => project.id === '4d3d3d3');
  assert.deepEqual(demo.sequences.map(entry => entry.name).sort(), ['BETA', 'Celery Head', 'Celery Man', 'Oyster']);
  assert.ok(demo.sequences.find(entry => entry.name === 'Oyster').sequence.stills.default, 'with a picture');
  assert.match(chooser()[0].footnote, /^Effects: wobble, hat wobble/);

  await computer.hear('load up Tayne');
  await computer.hear('show me the sequences');
  assert.equal(chooser().length, 1, 'only one such window at a time');
  const names = chooser()[0].projects.find(project => project.id === '4d3d3d3').sequences.map(entry => entry.name);
  assert.ok(names.includes('Tayne') && !names.includes('BETA'));
  await computer.hear('list the effects');
  assert.match([...computer.windows.values()].find(window => window.kind === 'note').text, /^Effects: wobble/);
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
  assert.equal(lastSaid(), 'Oyster Engaged.');
  assert.ok(computer.sequenceWindows('4d3d3d3/oyster').length > 5);

  await computer.hear('load up something that does not exist');
  assert.equal(lastSaid(), 'I have no sequence called Something That Does Not Exist.');

  await computer.hear('what is the meaning of life');
  assert.equal(lastSaid(), 'Not computing. Please repeat.');

  await computer.hear('close oyster');
  assert.equal(lastSaid(), 'Closed.');
  assert.equal(computer.sequenceWindows().length, 0);

  await computer.hear('kick up the four d three d three d three');
  assert.equal(lastSaid(), '4d3d3d3 Engaged.');
  const names = new Set(computer.sequenceWindows().map(window => window.sequence.name));
  assert.deepEqual([...names].sort(), ['Celery Head', 'Celery Man', 'Oyster'], 'the beta sequence stays hidden until asked for');

  await computer.hear('clear the desktop');
  assert.equal(lastSaid(), 'Desktop cleared.');
  assert.equal(computer.windows.size, 0);
});

test('more disco means more disco, however it is spelled', async () => {
  const { computer, actions, lastSaid } = await boot();
  const music = () => actions.filter(action => action.type === 'music').at(-1);
  await computer.hear('disco');
  assert.deepEqual(music(), { type: 'music', on: true, more: false });
  await computer.hear('Computer, mooooore discooooo please!');
  assert.deepEqual(music(), { type: 'music', on: true, more: true });
  assert.equal(lastSaid(), 'Yes.');
  await computer.hear('give me more disco music');
  assert.equal(music().more, true);
  await computer.hear('stop the disco');
  assert.deepEqual(music(), { type: 'music', on: false, more: false });
});

test('the window limit holds no matter how often it is kicked up', async () => {
  const { computer } = await boot({ config: { maxWindows: 40 } });
  for (let i = 0; i < 5; i++) await computer.hear('kick up the 4d3d3d3');
  assert.equal(computer.windows.size, 40);
});

test('incoming calls show who is calling and can be declined', async () => {
  const { computer, lastSaid } = await boot();
  computer.incomingCall({ callId: 'c1', isVideo: false, contact: { name: 'Anna Example', pushname: 'Anna', number: '15550100123', isMyContact: true } });
  assert.equal(lastSaid(), 'Paul, Anna Example is calling.');
  const call = [...computer.windows.values()].find(window => window.kind === 'call');
  assert.equal(call.call.caller, 'Anna Example');
  assert.equal(call.call.contact.number, '15550100123');

  await computer.hear('who is calling');
  assert.equal(lastSaid(), 'Paul, Anna Example is calling.');

  computer.callEnded({ callId: 'c1', reason: 'missed' });
  assert.equal(lastSaid(), 'Missed call from Anna Example.');
  assert.ok(![...computer.windows.values()].some(window => window.kind === 'call'));

  computer.incomingCall({ callId: 'c2', isVideo: true, contact: { name: null, pushname: '', number: '15550100456' } });
  assert.equal(lastSaid(), 'Paul, +15550100456 is video calling.');
  await computer.hear('test call from my wife');
  assert.equal(lastSaid(), 'Paul, My Wife is calling.');
  // The computer cannot pick up. It says so, and the call keeps ringing.
  await computer.hear('Computer, answer the call.');
  assert.equal(lastSaid(), "I'm afraid I can't do that, Paul.");
  assert.equal([...computer.windows.values()].filter(window => window.kind === 'call').length, 2);
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
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cinco-id-'));
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

test('each dancer of the demo brings its own tune', async () => {
  const { computer } = await boot();
  await computer.hear('load up oyster');
  assert.equal(computer.sequenceWindows()[0].sequence.music, 'house');
  await computer.hear('load up celery man');
  assert.equal(computer.sequenceWindows('4d3d3d3/celery-man')[0].sequence.music, 'funk');
  assert.equal(computer.view(computer.library.sequence('4d3d3d3/tayne')).music, 'drive');
  assert.equal(computer.view(computer.library.sequence('d15c0/grandmother')).music, null, 'others get one picked by the screen');
});
