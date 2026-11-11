import { normalize } from './text.js';

/**
 * Fast understanding of the phrases the computer always knows, without asking any AI model.
 * Returns { intent, ...details }. Anything it cannot place comes back as { intent: 'unknown' }
 * so the brain (if one is connected) can have a go.
 *
 * `world` answers questions about what exists right now:
 *   findSequence(text) / findProject(text) / findEffect(text) -> something or null
 *   variantWords: { spokenWord: variantName }
 */

const FILLER = /^(?:(?:hey|hi|ok|okay|yo|um+|uh+|hm+|now|and|so|well|then|also|please|computer)\s+)+/;
const TRAILING = /\s+(?:please|thanks|thank you|for me|right now|now)$/;
const ASK = /^(?:could you|can you|would you|will you|can i get|could i get|can i have|could i have|can we get|can we have|may i have|give me|get me|i want|i need|i would like|i d like|let s have|let s get|let me get|let me have|how about|hit me with)\s+/;
const ARTICLE = /^(?:a|an|the|some|another|more|a little|a bit of|one more)\s+/;

const YES = /^(?:(?:m+|h+m+|well|oh|uh|um)\s+)*(?:yes|yeah|yep|yup|ja|sure|ok|okay|alright|all right|right|fine|m+ ?h+m+|mhm+|uh huh|do it|go ahead|go on|go for it|affirmative|please do|i am sure|i m sure|absolutely|definitely|of course|why not|let s see it|let s see|show me|i would|i do)(?:\s.*)?$/;
const NO = /^(?:no|nope|nah|nein|no thanks|cancel|never mind|nevermind|negative|don t|do not|forget it|not now)(?:\s.*)?$/;

function clean(text) {
  let t = normalize(text);
  let previous;
  do {
    previous = t;
    t = t.replace(FILLER, '').replace(TRAILING, '');
  } while (t !== previous);
  return t;
}

/** Tries ever shorter beginnings of `words` as a name, returning [thing, restWords]. */
function leadingMatch(words, find) {
  for (let take = Math.min(words.length, 4); take >= 1; take--) {
    const found = find(words.slice(0, take).join(' '));
    if (found) return [found, words.slice(take)];
  }
  return [null, words];
}

/** Looks for a known thing anywhere in the sentence (up to three words long). */
function anywhereMatch(words, find) {
  for (let size = Math.min(3, words.length); size >= 1; size--) {
    for (let start = 0; start + size <= words.length; start++) {
      const found = find(words.slice(start, start + size).join(' '));
      if (found) return found;
    }
  }
  return null;
}

/** A short name for a new sequence from its description: "a grandmother in a gold tracksuit ..." -> "grandmother". */
export function nameFromDescription(description) {
  const stop = new Set(['in', 'with', 'doing', 'dancing', 'wearing', 'who', 'that', 'on', 'at', 'of', 'and', 'while', 'holding', 'dressed', 'from', 'is', 'as']);
  const words = normalize(description).split(' ').filter(Boolean);
  while (words.length > 1 && ['a', 'an', 'the', 'some', 'one', 'my', 'our'].includes(words[0])) words.shift();
  const taken = [];
  for (const word of words) {
    if (stop.has(word) || taken.length === 3) break;
    taken.push(word);
  }
  return (taken.length ? taken : words.slice(0, 3)).join(' ');
}

export function isYes(text) { return YES.test(clean(text)); }
export function isNo(text) { return NO.test(clean(text)); }

export function parseCommand(text, world) {
  const said = clean(text);
  if (!said) return { intent: 'empty' };
  let m;

  // Calls
  if (/^(?:decline|reject|hang up|ignore)(?: (?:the|that|this) call| it| them)?$/.test(said)) return { intent: 'call.decline' };
  if (/^who (?:is|s) (?:calling|it|that|on the phone)$/.test(said)) return { intent: 'call.who' };
  if (/^(?:answer|accept|pick up)(?: (?:the|that|this) (?:call|phone)| it| the phone)?$/.test(said)
    || /^(?:take|get) (?:the|that|this) (?:call|phone)$/.test(said)) return { intent: 'call.accept' };
  if ((m = said.match(/^(?:simulate|test|fake|pretend) (?:a |an )?(?:incoming )?(video )?call(?: from (.+))?$/))) {
    return { intent: 'call.test', video: Boolean(m[1]), name: m[2] ?? null };
  }

  // What is there
  if (/(?:any|some|got|have|are there) (?:new|more|other|fresh) sequences?/.test(said)
    || /^(?:new sequences?|anything new|what s new|what is new)$/.test(said)) return { intent: 'beta.offer' };
  if ((m = said.match(/^(?:list|show|show me|what are|which|tell me) (?:all )?(?:the |our |my )?(projects|sequences|effects)/))) {
    return { intent: 'list', what: m[1] };
  }
  if (/^what (?:do we|have we|can you|do you) (?:have|got|do|load)/.test(said) || said === 'help') return { intent: 'list', what: 'everything' };

  // Quiet, clearing up
  if (/^(?:quiet|be quiet|shut up|silence|mute|stop talking)$/.test(said)) return { intent: 'mute' };
  // Which voice the computer speaks with
  const plain = said.replace(ASK, '');
  if (/^(?:list|show|show me|what|which)(?: are| is)? (?:the |your |all |all the )?voices?(?: do you have| are there| can you do| have you got)?$/.test(plain)) return { intent: 'voice.list' };
  if (/voice/.test(plain) && (m = plain.match(/^(?:use|switch to|change to|take) (?:the |a )?(?:voice (?:of |called |named )?)?(.+?)(?: as (?:your |the |my )?voice| voice)?$/))) {
    return { intent: 'voice.use', name: m[1] };
  }
  if ((m = plain.match(/^(?:change|switch|set) (?:your |the )?voice to (?:the )?(.+?)(?: voice)?$/))) return { intent: 'voice.use', name: m[1] };
  if ((m = plain.match(/^(?:talk|speak|sound) like (?:the |a )?(.+)$/))) return { intent: 'voice.use', name: m[1] };

  if (/^(?:(?:stop|kill|cut|no|turn off) (?:the )?music|music off)$/.test(said)) return { intent: 'music', on: false };
  if (/^(?:(?:play|start|put on|turn on|some|give me some|hit the) (?:the |some )?music|music|music on)$/.test(said)) return { intent: 'music', on: true };
  if (/^(?:clear|clear (?:the )?(?:desktop|screen)|shut it down|shut down|close everything|close all|close all windows|stop everything|kill everything|reset|clean up)$/.test(said)) {
    return { intent: 'close.all' };
  }

  // A different look of a sequence ("nude Tayne"). The words come from the sequences themselves.
  const variantWords = world.variantWords ?? {};
  const words = said.split(' ');
  const variantWord = words.find(word => variantWords[word]);
  if (variantWord) {
    const rest = words.filter(word => word !== variantWord);
    return {
      intent: 'variant',
      variant: variantWords[variantWord],
      sequence: anywhereMatch(rest, world.findSequence),
    };
  }

  const asked = said.replace(ASK, '');
  const wasAsked = asked !== said;

  // Printouts: "a printout of Oyster smiling"
  if ((m = asked.match(/^(?:(?:a|an|the|another) )?(?:printout|print out|print|hard ?copy|picture|photo)(?: of)? (?:the )?(.+)$/))) {
    const [sequence, rest] = leadingMatch(m[1].split(' '), world.findSequence);
    return { intent: 'printout', sequence, name: m[1], expression: sequence ? rest.join(' ') || null : null };
  }

  // Making new things
  if ((m = asked.match(/^(?:generate|make|create|build|render|draw|work on) (?:me |us )?(?:a |an )?(?:new |beta |brand new )?sequence(?: (?:of|called|named|with|for|about|showing))? (.+)$/))) {
    // "... sequence called Disco Grandma of a grandmother ..." or "... of a grandmother ... called Disco Grandma"
    let prompt = m[1];
    let name = null;
    let named;
    if (/ sequence (?:called|named) /.test(asked) && (named = prompt.match(/^(.+?) (?:of|with|showing|about|who is|that is) (.+)$/))) {
      [, name, prompt] = named;
    } else if ((named = prompt.match(/^(.+) (?:called|named) (.+)$/))) {
      [, prompt, name] = named;
    }
    return { intent: 'generate', prompt, name: name ?? nameFromDescription(prompt) };
  }
  if ((m = asked.match(/^(?:new|create|make|start) (?:a |an )?(?:new |empty )?project(?: (?:called|named))?(?: (.+))?$/))) {
    return { intent: 'project.create', name: m[1] ?? null };
  }

  // Loading and adding
  if ((m = asked.match(/^(?:load up|load|open up|open|bring up|pull up|boot up|run|play|start up|put on) (?:the )?(?:sequence |project |dancer )?(.+)$/))) {
    return { intent: 'load', name: m[1], sequence: world.findSequence(m[1]), project: world.findProject(m[1]) };
  }
  if ((m = asked.match(/^add (?:a |an |another |the )?(?:sequence |dancer |project )?(.+)$/))) {
    return { intent: 'add', name: m[1], sequence: world.findSequence(m[1]), project: world.findProject(m[1]) };
  }

  // Kicking it up
  if (/^(?:kick it up|kick things up|crank it up|turn it up|pump it up|more|more windows|more of them|go harder|again|once more|keep going)(?: (?:a notch|again|more|please))?$/.test(asked)) {
    return { intent: 'kick', name: null, project: null, sequence: null };
  }
  if ((m = asked.match(/^(?:kick up|kick|crank up|crank|fire up|engage|start|boot|turn up|pump up|rev up|activate|launch) (?:up )?(?:the )?(?:project )?(.+)$/))) {
    return { intent: 'kick', name: m[1], project: world.findProject(m[1]), sequence: world.findSequence(m[1]) };
  }
  // Speech recognition likes to hear "pick up" or "kick out" for "kick up": accept it when a project or sequence follows.
  if ((m = asked.match(/^(?:pick up|pick|kick out|kick off|keep up|quick up|check up) (?:up )?(?:the )?(?:project )?(.+)$/))
    && (world.findProject(m[1]) || world.findSequence(m[1]))) {
    return { intent: 'kick', name: m[1], project: world.findProject(m[1]), sequence: world.findSequence(m[1]) };
  }

  // Closing
  if ((m = asked.match(/^(?:close|remove|kill|get rid of|unload|hide|lose|drop) (?:the |all the |all of the |all )?(.+)$/))) {
    if (/^(?:everything|all|it all|windows|them|them all|desktop|screen)$/.test(m[1])) return { intent: 'close.all' };
    return { intent: 'close', name: m[1], sequence: world.findSequence(m[1]) };
  }

  // Effects. Known ones work bare ("hat wobble"); made-up ones need to be asked for
  // ("can I get a Flarhgunnstow", "and a Flarhgunnstow").
  if (world.isClearEffects?.(asked)) return { intent: 'effects.clear' };
  const withoutArticle = asked.replace(ARTICLE, '');
  const hadArticle = withoutArticle !== asked;
  let effectText = withoutArticle;
  let target = null;
  if ((m = withoutArticle.match(/^(.+?) (?:on|for|to|onto) (?:the )?(.+)$/)) && world.findSequence(m[2])) {
    effectText = m[1];
    target = world.findSequence(m[2]);
  }
  const known = world.findEffect(effectText);
  if (known) return { intent: 'effect', effect: known, label: effectText, sequence: target };
  if ((wasAsked || hadArticle) && effectText.split(' ').length <= 3 && !world.findSequence(effectText)) {
    return { intent: 'effect', effect: null, label: effectText, sequence: target };
  }

  // Just mentioning a sequence puts the attention on it ("now Tayne I can get into").
  const mentioned = anywhereMatch(asked.split(' '), world.findSequence);
  if (mentioned && asked.split(' ').length <= 8) return { intent: 'focus', sequence: mentioned };

  return { intent: 'unknown', text: said };
}
