// The app's sound: beeps, the phone ring, the printer and a small disco band are made on the
// spot; your own music files are played instead of the band if there are any; and the queue for
// the computer's voice.

let context = null;
let master = null;
let musicGain = null;
const MASTER_LEVEL = 0.5;

function audio() {
  if (!context) {
    context = new AudioContext();
    master = context.createGain();
    master.gain.value = muted ? 0 : MASTER_LEVEL; // muted means everything, whatever is started
    master.connect(context.destination);
    musicGain = context.createGain();
    musicGain.gain.value = 0;
    musicGain.connect(master);
  }
  if (context.state === 'suspended') context.resume().catch(() => {});
  return context;
}

function tone(frequency, start, length, { type = 'square', volume = 0.12, to = master, slideTo = null } = {}) {
  const ctx = audio();
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  if (slideTo) oscillator.frequency.exponentialRampToValueAtTime(slideTo, start + length);
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(volume, start + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0008, start + length);
  oscillator.connect(gain).connect(to);
  oscillator.start(start);
  oscillator.stop(start + length + 0.02);
}

function noise(start, length, { volume = 0.08, frequency = 3000, q = 1, to = master } = {}) {
  const ctx = audio();
  const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * length), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = frequency;
  filter.Q.value = q;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(volume, start);
  gain.gain.exponentialRampToValueAtTime(0.0008, start + length);
  source.connect(filter).connect(gain).connect(to);
  source.start(start);
}

let ringTimer = null;

const SOUNDS = {
  ding() { const t = audio().currentTime; tone(1318, t, 0.25, { type: 'sine', volume: 0.2 }); tone(1760, t + 0.09, 0.4, { type: 'sine', volume: 0.16 }); },
  chord() { const t = audio().currentTime; for (const f of [392, 494, 587, 740]) tone(f, t, 0.9, { type: 'triangle', volume: 0.1 }); },
  engage() { const t = audio().currentTime; [262, 330, 392, 523, 659, 784, 1047].forEach((f, i) => tone(f, t + i * 0.055, 0.16, { volume: 0.07 })); },
  reveal() { const t = audio().currentTime; [523, 659, 784, 1047].forEach((f, i) => tone(f, t + i * 0.12, i === 3 ? 0.7 : 0.14, { type: 'triangle', volume: 0.14 })); },
  printer() {
    const t = audio().currentTime;
    for (let i = 0; i < 22; i++) {
      noise(t + i * 0.12, 0.1, { volume: 0.07, frequency: 2200 + (i % 2) * 1400, q: 4 });
      tone(i % 2 ? 180 : 140, t + i * 0.12, 0.1, { type: 'sawtooth', volume: 0.025 });
    }
  },
  ring() {
    if (ringTimer) return;
    const burst = () => {
      const t = audio().currentTime;
      for (const offset of [0, 0.5]) {
        tone(440, t + offset, 0.38, { type: 'sine', volume: 0.12 });
        tone(480, t + offset, 0.38, { type: 'sine', volume: 0.12 });
      }
    };
    burst();
    ringTimer = setInterval(burst, 3000);
  },
  'ring-stop'() { clearInterval(ringTimer); ringTimer = null; },
};

export function play(name) {
  if (muted && name !== 'ring-stop') return; // muted means everything: voice, music and effects
  try { SOUNDS[name]?.(); } catch { /* sound is a nicety */ }
}

// ---------- disco music ----------
// Your own music first: sound files in the music folder (Menu, "Music folder") are played as the
// three disco levels, and "more disco" blends into the next one. With no files there, the small
// band below plays, made on the spot.

const TRACK_LEVEL = 1; // the loops carry their own loudness steps per level
const SWITCH_SECONDS = 1; // the blend from one level to the next
let tracks = null; // { buffers: Map(level -> AudioBuffer), seconds } once loaded
let trackLoad = null; // the loading, started once
let trackError = null; // why the loops could not be used (then the band plays)
let trackPlayer = null; // { source, gain, level } of the loop playing now
let trackClock = 0; // the context time at which the loops were at their start
let bandStop = null;

function loadTracks() {
  if (trackLoad) return trackLoad;
  trackLoad = (async () => {
    // Your own music: the first three sound files in the music folder, in name order, are the
    // three disco levels (with fewer files, the last one is used for the higher levels too).
    const response = await fetch('/api/music');
    if (!response.ok) throw new Error(`music list: HTTP ${response.status}`);
    const files = ((await response.json()).files ?? []).slice(0, 3);
    if (!files.length) throw new Error('no music files in the music folder');
    const decoded = await Promise.all(files.map(async url => {
      const file = await fetch(url);
      if (!file.ok) throw new Error(`${url}: HTTP ${file.status}`);
      const buffer = await audio().decodeAudioData(await file.arrayBuffer());
      if (!(buffer.duration > 1)) throw new Error(`${url} is empty`);
      return buffer;
    }));
    const buffers = new Map([1, 2, 3].map(level => [level, decoded[Math.min(level, decoded.length) - 1]]));
    tracks = { buffers, seconds: buffers.get(1).duration };
    return tracks;
  })().catch(error => {
    trackError = String(error?.message ?? error);
    tracks = null;
    return null;
  });
  return trackLoad;
}

/** Starts the loop for `level` in time with the loops' clock, blending over `fade` seconds. */
function playTrack(level, fade) {
  const ctx = audio();
  const buffer = tracks?.buffers.get(level);
  if (!buffer) return;
  const at = ctx.currentTime + 0.03;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  const gain = ctx.createGain();
  source.connect(gain).connect(musicGain);
  if (fade) {
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(1, at + fade);
  }
  const offset = (((at - trackClock) % buffer.duration) + buffer.duration) % buffer.duration;
  source.start(at, offset);
  const old = trackPlayer;
  trackPlayer = { source, gain, level };
  if (old) {
    old.gain.gain.cancelScheduledValues(at);
    old.gain.gain.setValueAtTime(old.gain.gain.value, at);
    old.gain.gain.linearRampToValueAtTime(0, at + fade);
    old.source.onended = () => old.source.disconnect();
    try { old.source.stop(at + fade + 0.05); } catch { /* already stopped */ }
  }
}

function stopTrack() {
  if (!trackPlayer) return;
  try { trackPlayer.source.stop(); } catch { /* already stopped */ }
  trackPlayer.source.disconnect();
  trackPlayer = null;
}

function startSynth() {
  if (musicTimer) return;
  const ctx = audio();
  nextStepTime = ctx.currentTime + 0.1;
  musicStep = 0; // always start at the top of the phrase
  musicTimer = setInterval(() => {
    while (nextStepTime < audio().currentTime + 0.25) {
      scheduleStep(musicStep++, nextStepTime);
      nextStepTime += STEP;
    }
  }, 60);
}

/** The music came on: the loops if they are (or become) ready, otherwise the band. */
function startBand() {
  clearTimeout(bandStop);
  if (trackPlayer || musicTimer) return; // still playing: it was switched off and on again quickly
  loadTracks().then(ready => {
    try {
      if (!musicOn || trackPlayer || musicTimer) return;
      if (ready) {
        trackClock = audio().currentTime + 0.03; // always start at the top of the loop
        playTrack(discoLevel, 0);
      } else {
        startSynth();
        rampMusic(musicLevel(), 0.3); // the band is set a little louder than the loops
      }
    } catch { /* sound is a nicety */ }
  });
}

function stopBandSoon() {
  clearTimeout(bandStop);
  bandStop = setTimeout(() => {
    if (musicOn) return;
    stopTrack();
    if (musicTimer) { clearInterval(musicTimer); musicTimer = null; }
  }, 700);
}

function rampMusic(value, seconds) {
  const ctx = audio();
  musicGain.gain.cancelScheduledValues(ctx.currentTime);
  musicGain.gain.linearRampToValueAtTime(value, ctx.currentTime + seconds);
}

/** For the music check in test/ui: what the music is doing, without changing anything. */
export function musicStatus() {
  return {
    on: musicOn,
    level: discoLevel,
    playing: trackPlayer ? 'loops' : musicTimer ? 'band' : 'nothing',
    loop: trackPlayer ? { level: trackPlayer.level, looping: trackPlayer.source.loop, seconds: trackPlayer.source.buffer?.duration ?? 0 } : null,
    loaded: tracks ? [...tracks.buffers].map(([level, buffer]) => ({ level, seconds: buffer.duration, sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels })).sort((a, b) => a.level - b.level) : [],
    error: trackError,
    context: context ? { state: context.state, time: context.currentTime, sampleRate: context.sampleRate } : null,
    muted,
    volume: master ? master.gain.value : null,
  };
}

// ---------- the fallback: a small looping band ----------
// An original eight-bar disco groove, played by the app itself: four-on-the-floor kick, claps on
// two and four, open hi-hats on the off-beats, an octave-jumping bass, choppy rhythm chords, a
// string pad with a rising run at the end of the phrase, a little hook and the odd "pew" drum.

const TEMPO = 122;
const MUSIC_LEVEL = 1.25; // how loud the band is; it steps back while the computer speaks
const STEP = 60 / TEMPO / 4; // one sixteenth note, in seconds
const hz = note => 440 * 2 ** ((note - 69) / 12); // note numbers as on a piano keyboard, 69 = concert A
// One chord per bar: A minor 7, D minor 7, G 7, C major 7. `bass` is the root, `tones` the chord.
const BARS = [
  { bass: 45, tones: [57, 60, 64, 67] },
  { bass: 38, tones: [57, 60, 62, 65] },
  { bass: 43, tones: [55, 59, 62, 65] },
  { bass: 36, tones: [55, 59, 60, 64] },
];
const HOOK = { // bar of the eight-bar phrase -> { step in the bar: note }
  0: { 0: 76, 3: 79, 6: 81, 10: 79 },
  2: { 0: 74, 3: 77, 6: 79, 11: 74 },
  4: { 0: 76, 3: 79, 6: 81, 8: 84, 11: 81 },
  6: { 0: 74, 3: 77, 6: 79 },
};
const STRING_RUN = [69, 71, 72, 74, 76, 79, 81, 84]; // the rising run in the last half of bar eight
let musicTimer = null;
let musicStep = 0;
let nextStepTime = 0;
let musicOn = false;

/** One or more notes through a filter: the bass, the rhythm chords, the strings and the hook. */
function synth(notes, start, length, { type = 'sawtooth', volume = 0.05, filter = 'lowpass', cutoff = 1200, cutoffTo = null, q = 1, attack = 0.005, detune = 0 } = {}) {
  const ctx = audio();
  const biquad = ctx.createBiquadFilter();
  biquad.type = filter;
  biquad.Q.value = q;
  biquad.frequency.setValueAtTime(cutoff, start);
  if (cutoffTo) biquad.frequency.exponentialRampToValueAtTime(cutoffTo, start + length);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(volume, start + attack);
  gain.gain.setValueAtTime(volume, start + Math.max(attack, length * 0.6));
  gain.gain.exponentialRampToValueAtTime(0.0008, start + length);
  biquad.connect(gain).connect(musicGain);
  for (const note of [].concat(notes)) {
    for (const cents of detune ? [-detune, detune] : [0]) {
      const oscillator = ctx.createOscillator();
      oscillator.type = type;
      oscillator.frequency.setValueAtTime(hz(note), start);
      oscillator.detune.value = cents;
      oscillator.connect(biquad);
      oscillator.start(start);
      oscillator.stop(start + length + 0.03);
    }
  }
}

function scheduleStep(step, time) {
  const inBar = step % 16;
  const barInPhrase = Math.floor(step / 16) % 8;
  const bar = BARS[barInPhrase % BARS.length];

  // drums
  if (inBar % 4 === 0) { // the kick on every beat
    tone(150, time, 0.24, { type: 'sine', volume: 0.5, to: musicGain, slideTo: 46 });
    noise(time, 0.012, { volume: 0.1, frequency: 3500, q: 0.6, to: musicGain });
  }
  if (inBar === 4 || inBar === 12) { // the clap on two and four
    for (const late of [0, 0.011, 0.023]) noise(time + late, 0.05, { volume: 0.2, frequency: 1500, q: 0.9, to: musicGain });
    noise(time + 0.03, 0.14, { volume: 0.11, frequency: 1300, q: 0.7, to: musicGain });
  }
  noise(time, 0.03, { volume: inBar % 2 ? 0.07 : 0.1, frequency: 9500, q: 0.6, to: musicGain }); // ticking hi-hat
  if (inBar % 4 === 2) noise(time, 0.17, { volume: 0.2, frequency: 8500, q: 0.5, to: musicGain }); // open hi-hat off the beat
  if ((barInPhrase === 3 && inBar === 14) || (barInPhrase === 7 && inBar === 6)) {
    tone(900, time, 0.28, { type: 'sine', volume: 0.2, to: musicGain, slideTo: 170 }); // "pew"
  }

  // bass: root on the beat, an octave up between the beats, a little walk into the next bar
  if (inBar % 2 === 0) {
    const up = inBar % 4 === 2;
    synth(bar.bass + (up ? 12 : 0), time, STEP * (up ? 1.3 : 1.7), { volume: 0.24, cutoff: up ? 900 : 650, cutoffTo: 180, q: 3 });
  }
  if (inBar === 15) synth(bar.bass + 7, time, STEP * 0.9, { volume: 0.18, cutoff: 800, cutoffTo: 200, q: 3 });

  // choppy rhythm chords with a moving "wah"
  if ([3, 6, 7, 11, 14].includes(inBar)) {
    const wah = 1100 + 900 * Math.sin((step / 16) * Math.PI);
    synth(bar.tones, time, STEP * (inBar === 7 ? 0.5 : 0.75), { volume: 0.07, filter: 'bandpass', cutoff: Math.max(500, wah), q: 2.5 });
  }

  // strings: a pad through each bar, and the rising run that leads back to the start
  if (inBar === 0) synth(bar.tones.slice(1).map(note => note + 12), time, STEP * 15.5, { volume: 0.03, cutoff: 2400, attack: 0.09, detune: 7 });
  if (barInPhrase === 7 && inBar >= 8) synth(STRING_RUN[inBar - 8] + 12, time, STEP * 1.4, { volume: 0.09, cutoff: 3200, attack: 0.012, detune: 6 });

  // the hook
  const note = HOOK[barInPhrase]?.[inBar];
  if (note) synth(note, time, STEP * 2.2, { type: 'square', volume: 0.09, cutoff: 2600, cutoffTo: 900, q: 1.5 });

  // a string stab on the last off-beat of every bar
  if (inBar === 14) synth(bar.tones.map(tone => tone + 12), time, STEP * 1.2, { volume: 0.045, cutoff: 3000, attack: 0.008, detune: 8 });

  // "More disco" adds layers.
  if (discoLevel >= 2) {
    if ([0, 3, 6, 10, 12].includes(inBar)) { // cowbell
      tone(800, time, 0.09, { type: 'square', volume: 0.07, to: musicGain });
      tone(540, time, 0.09, { type: 'square', volume: 0.05, to: musicGain });
    }
    if (note) synth(note + 12, time, STEP * 1.6, { type: 'square', volume: 0.05, cutoff: 3600, cutoffTo: 1400, q: 1.2 }); // the hook, doubled higher
  }
  if (discoLevel >= 3) {
    // a busy clavinet-like line between the beats
    if (inBar % 2 === 1 || inBar === 8) synth(bar.tones[(inBar * 7) % 4] - 12, time, STEP * 0.55, { type: 'square', volume: 0.06, filter: 'bandpass', cutoff: 1500, q: 3 });
    // extra claps into every fourth bar, and a rising whoop back to the top of the phrase
    if (barInPhrase % 4 === 3 && (inBar === 13 || inBar === 15)) noise(time, 0.05, { volume: 0.18, frequency: 1500, q: 0.9, to: musicGain });
    if (barInPhrase === 7 && inBar === 12) tone(300, time, STEP * 4, { type: 'sine', volume: 0.16, to: musicGain, slideTo: 1800 });
  }
}

let discoLevel = 1; // 1 to 3; every "more disco" moves to the next loop (the band adds a layer)
// The loops carry their own loudness; the band gets a little louder per level.
const musicLevel = () => (trackError || musicTimer ? MUSIC_LEVEL * (1 + 0.12 * (discoLevel - 1)) : TRACK_LEVEL);

/** One more layer of disco, up to the maximum. Returns the level now playing. */
export function moreDisco() {
  const before = discoLevel;
  discoLevel = Math.min(3, discoLevel + 1);
  try {
    if (musicOn && musicGain) {
      if (trackPlayer) {
        if (discoLevel !== before) playTrack(discoLevel, SWITCH_SECONDS); // the loops get louder by themselves
      } else {
        rampMusic(musicLevel(), 0.3); // the band: a little louder per level, as before
      }
    }
  } catch { /* sound is a nicety */ }
  return discoLevel;
}

export function music(on) {
  const ctx = audio();
  if (on === musicOn) return;
  musicOn = on;
  musicGain.gain.cancelScheduledValues(ctx.currentTime);
  musicGain.gain.linearRampToValueAtTime(on ? musicLevel() : 0, ctx.currentTime + 0.6);
  try {
    if (on) startBand();
    else stopBandSoon();
  } catch { /* sound is a nicety */ }
}

export function isMusicOn() { return musicOn; }

function duck(down) {
  if (!musicGain || !musicOn) return;
  const ctx = audio();
  musicGain.gain.cancelScheduledValues(ctx.currentTime);
  musicGain.gain.linearRampToValueAtTime(down ? musicLevel() * 0.28 : musicLevel(), ctx.currentTime + 0.25);
}

// ---------- the voice ----------

const queue = [];
let speaking = false;
let current = null;
let mode = 'server';
let muted = false;

const spoken = []; // what was said aloud and how it went, for the voice check

export function setVoiceMode(next) { mode = next; }
export function setMuted(value) {
  muted = value;
  if (master) master.gain.value = value ? 0 : MASTER_LEVEL;
  if (value) { quiet(); play('ring-stop'); }
}
export function voiceLog() { return spoken.slice(-40); }
export function isMuted() { return muted; }

// ---------- recording the app's own sound (for demo videos) ----------
// While a recording runs, everything the app plays (voice, effects, music) also goes into a
// sound track. Nothing else on the PC is captured. In normal use none of this is active.

let tap = null;
let voiceBus = null;
let recorder = null;

/** Sends a voice sound file through the recording track too, when a recording is running. */
function wire(player) {
  if (!tap) return;
  try { audio().createMediaElementSource(player).connect(voiceBus); } catch { /* it still plays directly */ }
}

/** Starts recording the app's sound. Resolves with the clock time at which the track begins. */
export function startRecording() {
  const ctx = audio();
  tap = ctx.createMediaStreamDestination();
  master.connect(tap);
  voiceBus = ctx.createGain();
  voiceBus.connect(ctx.destination);
  voiceBus.connect(tap);
  recorder = new MediaRecorder(tap.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 160_000 });
  recorder.chunks = [];
  recorder.ondataavailable = event => { if (event.data.size) recorder.chunks.push(event.data); };
  return new Promise(resolve => {
    recorder.onstart = () => resolve(Date.now());
    recorder.start(1000);
  });
}

/** Stops the recording and returns the sound track (WebM/Opus) as base64 text. */
export function stopRecording() {
  return new Promise(resolve => {
    if (!recorder) return resolve(null);
    recorder.onstop = () => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] ?? null);
      reader.readAsDataURL(new Blob(recorder.chunks, { type: 'audio/webm' }));
      try { master.disconnect(tap); } catch { /* already gone */ }
      tap = null;
      recorder = null;
    };
    recorder.stop();
  });
}

/** Plays one sample of a voice for the Setup window: a sound file, or the browser voice saying `text`. */
export async function sample(blob, text) {
  if (muted) return;
  quiet();
  if (!(blob instanceof Blob)) return browserSpeak(text);
  const url = URL.createObjectURL(blob);
  try {
    await new Promise(resolve => {
      const player = new Audio(url);
      wire(player);
      player.onended = resolve;
      player.onerror = resolve;
      player.play().catch(resolve);
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function browserSpeak(text) {
  return new Promise(resolve => {
    if (!('speechSynthesis' in window)) return resolve();
    const utterance = new SpeechSynthesisUtterance(text);
    const voices = speechSynthesis.getVoices();
    utterance.voice = voices.find(voice => /david|mark|george/i.test(voice.name)) ?? voices.find(voice => voice.lang?.startsWith('en')) ?? null;
    utterance.pitch = 0.6;
    utterance.rate = 0.95;
    utterance.onend = resolve;
    utterance.onerror = resolve;
    current = { stop: () => speechSynthesis.cancel() };
    speechSynthesis.speak(utterance);
  });
}

async function serverSpeak(text) {
  const response = await fetch(`/api/tts?text=${encodeURIComponent(text)}`);
  if (response.status !== 200) {
    await browserSpeak(text);
    return 'the computer had no voice ready, so the browser voice was tried';
  }
  const url = URL.createObjectURL(await response.blob());
  const outcome = await new Promise(resolve => {
    const player = new Audio(url);
    wire(player);
    player.onended = () => resolve('played');
    player.onerror = () => resolve('could not be played');
    current = { stop: () => { player.pause(); resolve('stopped'); } };
    player.play().catch(() => resolve('was not allowed to play'));
  });
  URL.revokeObjectURL(url);
  return outcome;
}

async function drain() {
  if (speaking) return;
  speaking = true;
  while (queue.length) {
    const text = queue.shift();
    duck(true);
    let outcome;
    try { outcome = (await (mode === 'server' ? serverSpeak(text) : browserSpeak(text))) ?? 'browser voice'; }
    catch (error) { outcome = `failed: ${error.message}`; }
    spoken.push({ text, outcome });
    current = null;
  }
  duck(false);
  speaking = false;
}

export function say(text) {
  if (muted || !text) return;
  queue.push(text);
  drain();
}

export function quiet() {
  queue.length = 0;
  current?.stop();
}

/** Browsers only allow sound after the first click or key press. */
export function unlock() { audio(); loadTracks(); }
