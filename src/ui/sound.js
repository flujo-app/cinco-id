// All sound is made on the spot: beeps, the phone ring, the printer, the lounge music and
// the queue for the computer's voice. No sound files needed.

let context = null;
let master = null;
let musicGain = null;

function audio() {
  if (!context) {
    context = new AudioContext();
    master = context.createGain();
    master.gain.value = 0.5;
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

// ---------- lounge music: a small looping band ----------

const CHORDS = [
  [261.63, 329.63, 392.0, 493.88], // C major 7
  [220.0, 261.63, 329.63, 392.0], // A minor 7
  [293.66, 349.23, 440.0, 523.25], // D minor 7
  [196.0, 246.94, 293.66, 349.23], // G 7
];
const LEAD = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5];
let musicTimer = null;
let musicStep = 0;
let nextStepTime = 0;
let musicOn = false;

function scheduleStep(step, time) {
  const beat = 60 / 108 / 2; // eighth notes
  const chord = CHORDS[Math.floor(step / 8) % CHORDS.length];
  const inBar = step % 8;
  if (inBar === 0 || inBar === 3 || inBar === 6) tone(chord[0] / 2, time, beat * 1.6, { type: 'triangle', volume: 0.2, to: musicGain });
  if (inBar === 2 || inBar === 5 || inBar === 7) for (const f of chord.slice(1)) tone(f, time, beat * 0.7, { type: 'sawtooth', volume: 0.028, to: musicGain });
  noise(time, 0.04, { volume: inBar % 2 ? 0.05 : 0.025, frequency: 8000, q: 0.7, to: musicGain });
  if (inBar === 2 || inBar === 6) noise(time, 0.12, { volume: 0.06, frequency: 1800, q: 0.8, to: musicGain });
  // a wandering lead line that repeats every 32 steps, so it feels composed rather than random
  const pick = (Math.imul(step % 32, 2654435761) >>> 0) % 11;
  if (pick < LEAD.length && inBar !== 0) tone(LEAD[pick], time, beat * 1.4, { type: 'square', volume: 0.035, to: musicGain });
}

export function music(on) {
  const ctx = audio();
  if (on === musicOn) return;
  musicOn = on;
  musicGain.gain.cancelScheduledValues(ctx.currentTime);
  musicGain.gain.linearRampToValueAtTime(on ? 0.55 : 0, ctx.currentTime + 0.6);
  if (on && !musicTimer) {
    nextStepTime = ctx.currentTime + 0.1;
    musicTimer = setInterval(() => {
      const beat = 60 / 108 / 2;
      while (nextStepTime < audio().currentTime + 0.25) {
        scheduleStep(musicStep++, nextStepTime);
        nextStepTime += beat;
      }
    }, 80);
  } else if (!on && musicTimer) {
    setTimeout(() => { if (!musicOn) { clearInterval(musicTimer); musicTimer = null; } }, 700);
  }
}

export function isMusicOn() { return musicOn; }

function duck(down) {
  if (!musicGain || !musicOn) return;
  const ctx = audio();
  musicGain.gain.cancelScheduledValues(ctx.currentTime);
  musicGain.gain.linearRampToValueAtTime(down ? 0.16 : 0.55, ctx.currentTime + 0.25);
}

// ---------- the voice ----------

const queue = [];
let speaking = false;
let current = null;
let mode = 'server';
let muted = false;

const spoken = []; // what was said aloud and how it went, for the voice check

export function setVoiceMode(next) { mode = next; }
export function setMuted(value) { muted = value; if (value) { quiet(); play('ring-stop'); } }
export function voiceLog() { return spoken.slice(-40); }

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
export function unlock() { audio(); }
