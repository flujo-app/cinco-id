// Small text helpers shared by the command understanding and the project lookup.

const NUMBER_WORDS = {
  zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9',
};
// How speech recognisers tend to spell the letters a to f when they are said aloud.
const LETTER_WORDS = {
  a: 'a', ay: 'a', eh: 'a', b: 'b', be: 'b', bee: 'b', c: 'c', see: 'c', sea: 'c',
  d: 'd', dee: 'd', de: 'd', e: 'e', ee: 'e', f: 'f', ef: 'f', eff: 'f',
};

/** Lower case, no punctuation, single spaces. Keeps letters, digits and spaces. */
export function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Same as normalize but with every space removed, for forgiving comparisons. */
export function squash(text) {
  return normalize(text).replace(/\s/g, '');
}

/**
 * Turns something a person said into a hexadecimal project id, or null.
 * "4D3D3D3", "4d 3d 3d 3", "four d three d three d three" and "4-D-3-D-3-D-3" all become "4d3d3d3".
 */
export function hexFromSpeech(text) {
  const tokens = normalize(text).split(' ').filter(Boolean);
  if (!tokens.length) return null;
  // Typed exactly: keep it as it is ("bee" stays "bee").
  if (tokens.length === 1 && /^[0-9a-f]{1,16}$/.test(tokens[0])) return tokens[0];
  let out = '';
  for (const token of tokens) {
    // Spoken: letter names win ("dee" means "d").
    if (NUMBER_WORDS[token]) out += NUMBER_WORDS[token];
    else if (LETTER_WORDS[token]) out += LETTER_WORDS[token];
    else if (/^[0-9a-f]+$/.test(token)) out += token;
    else return null;
  }
  return /^[0-9a-f]{1,16}$/.test(out) ? out : null;
}

/** Classic edit distance, small and good enough for names. */
export function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * Picks the best match for `query` among `candidates` ({ key, labels[] }).
 * Exact matches win, then close spellings. Returns the candidate or null.
 */
export function bestMatch(query, candidates, { maxRatio = 0.34 } = {}) {
  const wanted = squash(query);
  if (!wanted) return null;
  let best = null;
  let bestScore = Infinity;
  for (const candidate of candidates) {
    for (const label of candidate.labels) {
      const have = squash(label);
      if (!have) continue;
      if (have === wanted) return candidate;
      const distance = editDistance(wanted, have);
      const ratio = distance / Math.max(wanted.length, have.length);
      if (ratio <= maxRatio && ratio < bestScore) {
        best = candidate;
        bestScore = ratio;
      }
    }
  }
  return best;
}

/** Stable small hash of a string, used to turn made-up words into repeatable choices. */
export function hashString(text) {
  let h = 2166136261;
  for (const ch of String(text)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Repeatable random numbers from a seed (mulberry32). */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function titleCase(text) {
  return String(text).replace(/\b[a-z]/g, ch => ch.toUpperCase());
}
