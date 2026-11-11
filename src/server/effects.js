import { hashString, normalize, seededRandom, squash, editDistance } from './text.js';

/**
 * Everything the screen knows how to do to a dancer. The names here are the contract with the
 * screen (src/ui/effects.js draws them). `scope: "window"` effects move the window itself.
 */
export const EFFECTS = {
  wobble: { say: ['wobble', 'wiggle', 'jiggle', 'wobbling'], wild: true },
  hatWobble: { say: ['hat wobble', 'hat wiggle', 'hat wobbling', 'wobble the hat', 'hat jiggle'] },
  mirror: { say: ['mirror', 'mirrored', 'flip', 'reverse'], wild: true },
  trails: { say: ['trails', 'trail', 'smear', 'streaks', 'after image'], wild: true },
  rainbow: { say: ['rainbow', 'colour cycle', 'color cycle', 'colors', 'colours', 'hue', 'disco'], wild: true },
  tile: { say: ['tile', 'tiles', 'tiled', 'grid', 'multiply'], wild: true },
  tumble: { say: ['tumble', 'three d', '3d', 'tumbling', 'depth'], wild: true },
  pulse: { say: ['pulse', 'zoom pulse', 'throb', 'pump', 'zoom'], wild: true },
  spin: { say: ['spin', 'rotate', 'twirl', 'spinning'], wild: true },
  squash: { say: ['squash', 'stretch', 'squash and stretch', 'jelly', 'rubber'], wild: true },
  ghost: { say: ['ghost', 'ghosts', 'echo', 'echoes', 'double'], wild: true },
  pixel: { say: ['pixel', 'pixelate', 'pixelated', 'blocky', 'low res'], wild: true },
  invert: { say: ['invert', 'negative', 'inverted'], wild: true },
  slow: { say: ['slow', 'slow motion', 'slo mo', 'slower'] },
  fast: { say: ['fast', 'faster', 'speed up', 'turbo', 'double time'], wild: true },
  jitter: { say: ['jitter', 'shake', 'vibrate', 'shiver'], wild: true },
  giant: { say: ['giant', 'huge', 'big', 'bigger', 'enlarge'] },
  tiny: { say: ['tiny', 'small', 'smaller', 'shrink'] },
  drift: { say: ['drift', 'wander', 'float', 'roam'], scope: 'window', wild: true },
  conga: { say: ['conga', 'conga line', 'parade', 'orbit'], scope: 'window', wild: true },
  free: { say: ['free', 'set free', 'no window', 'no windows', 'no frame', 'frameless', 'loose', 'out of the window'], scope: 'window' },
  // A number from the sketch. It is staged by the computer (the dancer steps out of the window, with
  // close-ups beside it), so the screen draws nothing special for it.
  flarhgunnstow: { say: ['flarhgunnstow', 'flarhgunstow', 'flargunnstow', 'flargunstow', 'flar gun stow', 'flarhgunnstowe', 'flagunstow'], stage: 'solo' },
};

export const EFFECT_NAMES = Object.keys(EFFECTS);

const CLEAR_WORDS = ['normal', 'reset', 'clear effects', 'no effects', 'back to normal', 'stop that', 'calm down'];

/** True when the text asks to remove all effects. */
export function isClearEffects(text) {
  const wanted = normalize(text);
  return CLEAR_WORDS.includes(wanted);
}

/** Finds a known effect by what a person called it. Returns its name or null. */
export function findEffect(text, learned = {}) {
  const wanted = normalize(text);
  if (!wanted) return null;
  for (const [name, effect] of Object.entries(EFFECTS)) {
    if (name.toLowerCase() === wanted || effect.say.includes(wanted)) return name;
  }
  if (learned[squash(wanted)]) return squash(wanted);
  let best = null;
  let bestRatio = 0.21; // only very close spellings count; made-up words must stay made-up
  for (const [name, effect] of Object.entries(EFFECTS)) {
    for (const phrase of [name.toLowerCase(), ...effect.say]) {
      const ratio = editDistance(squash(wanted), squash(phrase)) / Math.max(wanted.length, phrase.length);
      if (ratio < bestRatio) { best = name; bestRatio = ratio; }
    }
  }
  return best;
}

/**
 * Turns a made-up word into a repeatable mix of real effects.
 * The same word always gives the same mix, so "a Flarhgunnstow" means something from then on.
 */
export function improviseEffect(word) {
  const key = squash(word);
  const random = seededRandom(hashString(key));
  const wild = Object.entries(EFFECTS).filter(([, effect]) => effect.wild).map(([name]) => name);
  const count = 2 + Math.floor(random() * 2);
  const recipe = [];
  while (recipe.length < count && wild.length) {
    const name = wild.splice(Math.floor(random() * wild.length), 1)[0];
    recipe.push({ effect: name, amount: Number((0.6 + random() * 0.9).toFixed(2)) });
  }
  return { key, label: word.trim(), recipe };
}

/** Expands an effect name (known or learned) into the list the screen should apply. */
export function expandEffect(name, learned = {}, amount = 1) {
  if (EFFECTS[name]) return EFFECTS[name].stage ? [] : [{ effect: name, amount }];
  const custom = learned[name];
  if (custom) return custom.recipe.map(step => ({ effect: step.effect, amount: step.amount * amount }));
  return [];
}

/** Small random differences for the copies in a big show, so they do not all look the same. */
export function showVariation(index, seed, baseEffects = []) {
  const random = seededRandom(hashString(`${seed}:${index}`));
  const effects = baseEffects.map(effect => ({ effect, amount: Number((0.5 + random()).toFixed(2)) }));
  if (random() < 0.5) effects.push({ effect: 'mirror', amount: 1 });
  if (random() < 0.3) effects.push({ effect: 'rainbow', amount: Number((0.3 + random() * 0.7).toFixed(2)) });
  if (random() < 0.18) effects.push({ effect: 'fast', amount: 1 });
  if (random() < 0.12) effects.push({ effect: 'ghost', amount: 1 });
  const size = ['small', 'small', 'medium', 'medium', 'large'][Math.floor(random() * 5)];
  const phase = Number(random().toFixed(3));
  // As in the sketch: most windows show the whole dancer on white, some are close-ups on pink.
  const pick = random();
  const shot = pick < 0.3 ? 'closeup' : 'full';
  const backdrop = shot === 'closeup' ? 'pink' : pick < 0.8 ? 'white' : pick < 0.93 ? 'pastel' : 'blue';
  return { effects, size, phase, shot, backdrop };
}
