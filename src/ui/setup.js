// The Setup window: a wizard (Back / Next / Finish) that sets the computer up without
// editing a text file. It only talks to this computer's own local server; keys typed here go to
// the server once and are never shown again.

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function api(url, body) {
  const response = await fetch(url, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (response.status === 204) return { response, data: null };
  const type = response.headers.get('content-type') ?? '';
  const data = type.includes('json') ? await response.json() : await response.blob();
  if (!response.ok) throw Object.assign(new Error(data?.error ?? `The computer answered ${response.status}.`), { field: data?.field ?? null });
  return { response, data };
}

const STEPS = ['Welcome', 'Voice', 'Listening', 'Brain', 'WhatsApp', 'New dancers', 'Finish'];
const PAGE_STEP = { whatsapp: 4 };
const FIELD_STEP = {
  operator: 0, voice: 1, ears: 2, earsPython: 2, earsModel: 2,
  brain: 3, brainUrl: 3, brainModel: 3, brainKeyEnv: 3, brainKey: 3, mediaPython: 5, openrouterKey: 5,
};

/**
 * Fills a window record with the wizard.
 *   context.shell     the desktop shell bridge (or null in a plain browser)
 *   context.sound     the sound module (for "Say something")
 *   context.firstRun  true when it opened by itself on the first start
 *   context.page      a page to open on (for example "whatsapp"), or nothing for the first one
 *   context.onFinished(saved) called once when the window goes away
 * record.goTo(page) jumps to a page later (saying "link whatsapp" while Setup is open).
 */
export function buildSetup(record, context) {
  const { shell, sound } = context;
  let settings = null;
  let status = null;
  let prepare = null;
  let step = PAGE_STEP[context.page] ?? 0;
  let whatsapp = null; // what the WhatsApp page last heard from the computer
  let waPoller = null;
  let waUpdate = null;
  let saved = false;
  let busy = false;
  let result = null;
  let confirming = false;
  let draft = null;
  let poller = null;

  const root = el('div', 'setup');
  const main = el('div', 'setup-main');
  const side = el('div', 'setup-side');
  const art = el('div', 'setup-art');
  const stepList = el('ol', 'setup-steps');
  side.append(art, stepList);
  const page = el('div', 'setup-page');
  main.append(side, page);
  const buttons = el('div', 'setup-buttons');
  const back = el('button', 'w95', '< Back');
  const next = el('button', 'w95', 'Next >');
  const cancel = el('button', 'w95', 'Cancel');
  back.dataset.role = 'back';
  next.dataset.role = 'next';
  cancel.dataset.role = 'cancel';
  buttons.append(back, next, el('span', 'setup-gap'), cancel);
  root.append(main, buttons);
  record.body.append(root);

  record.cleanup = () => {
    clearInterval(poller);
    clearTimeout(waPoller);
    waPoller = null;
    waUpdate = null;
    context.onFinished?.(saved);
  };
  record.goTo = name => {
    if (!(name in PAGE_STEP) || busy || result) return;
    confirming = false;
    step = PAGE_STEP[name];
    render();
  };
  // The computer tells every screen when the WhatsApp link changes.
  record.whatsappChanged = view => {
    if (!whatsapp?.program) return; // the page asks for the whole picture itself
    whatsapp = { ...whatsapp, ...view, qr: view.linked || !view.running ? null : whatsapp.qr };
    waUpdate?.(whatsapp);
  };

  // ---------- small building blocks ----------

  const title = text => page.append(el('h2', 'setup-title', text));
  const para = (text, className = 'setup-text') => { const p = el('p', className, text); page.append(p); return p; };
  const group = label => { const box = el('fieldset', 'setup-group'); box.append(el('legend', '', label)); page.append(box); return box; };
  const field = (parent, label, input, hint) => {
    const row = el('label', 'setup-field');
    row.append(el('span', 'setup-label', label), input);
    parent.append(row);
    if (hint) parent.append(el('div', 'setup-hint', hint));
    return row;
  };
  const textInput = (value, onChange, { type = 'text', placeholder = '', name = '', max = 300 } = {}) => {
    const input = el('input', 'setup-input');
    input.type = type;
    input.value = value ?? '';
    input.placeholder = placeholder;
    input.maxLength = max;
    input.spellcheck = false;
    input.autocomplete = 'off';
    if (name) input.name = name;
    input.addEventListener('input', () => onChange(input.value));
    return input;
  };
  const select = (options, value, onChange, name = '') => {
    const box = el('select', 'setup-select');
    if (name) box.name = name;
    for (const [optionValue, label] of options) {
      const option = el('option', '', label);
      option.value = optionValue;
      box.append(option);
    }
    box.value = value;
    box.addEventListener('change', () => onChange(box.value));
    return box;
  };
  const radio = (parent, groupName, value, label, checked, onPick, { disabled = false, note = '' } = {}) => {
    const row = el('label', `setup-radio${disabled ? ' disabled' : ''}`);
    const input = el('input');
    input.type = 'radio';
    input.name = groupName;
    input.value = value;
    input.checked = checked;
    input.disabled = disabled;
    input.addEventListener('change', () => { if (input.checked) onPick(value); });
    row.append(input, el('span', '', label));
    if (note) row.append(el('span', 'setup-note', note));
    parent.append(row);
    return input;
  };
  const button = (parent, label, onClick, role = '') => {
    const b = el('button', 'w95', label);
    if (role) b.dataset.role = role;
    b.addEventListener('click', event => { event.preventDefault(); onClick(b); });
    parent.append(b);
    return b;
  };
  const statusLine = parent => { const line = el('div', 'setup-status'); parent.append(line); return line; };
  const error = text => { const line = el('div', 'setup-error', text); page.append(line); return line; };

  // ---------- what the screen knows ----------

  function presetFor(baseUrl) {
    for (const [name, preset] of Object.entries(settings.presets)) if (preset.baseUrl === baseUrl) return name;
    return baseUrl ? 'other' : 'openai';
  }

  function makeDraft() {
    const tts = settings.voice.tts;
    const brain = settings.brain;
    return {
      operator: settings.operator,
      voice: tts.engine === 'windows' ? `windows:${tts.voice ?? ''}` : tts.engine,
      ears: { ...settings.voice.stt, python: settings.voice.stt.engine === 'whisper' ? settings.voice.stt.python : '' },
      brain: {
        engine: brain.engine,
        preset: presetFor(brain.baseUrl),
        baseUrl: brain.baseUrl || settings.presets.openai.baseUrl,
        model: brain.engine === 'claude-cli' ? '' : brain.model,
        claudeModel: brain.engine === 'claude-cli' ? brain.model : 'haiku',
        apiKeyEnv: brain.apiKeyEnv,
        key: '',
        removeKey: false,
      },
      media: { python: settings.media.python },
      openrouterKey: '',
      removeOpenrouterKey: false,
    };
  }

  /** The settings to save, in the shape the server checks. */
  function collect() {
    const body = { operator: draft.operator };
    const [engine, ...rest] = draft.voice.split(':');
    body.voice = { tts: { engine, voice: engine === 'windows' ? rest.join(':') : null } };
    body.voice.stt = draft.ears.engine === 'whisper'
      ? { engine: 'whisper', python: draft.ears.python, model: draft.ears.model, device: draft.ears.device }
      : { engine: 'off' };
    const brain = draft.brain;
    if (brain.engine === 'api') {
      const preset = settings.presets[brain.preset];
      body.brain = { engine: 'api', baseUrl: preset?.baseUrl ?? brain.baseUrl, model: brain.model, apiKeyEnv: preset ? preset.apiKeyEnv : null };
    } else if (brain.engine === 'claude-cli') {
      body.brain = { engine: 'claude-cli', model: brain.claudeModel };
    } else {
      body.brain = { engine: 'none' };
    }
    body.media = { python: draft.media.python };
    body.secrets = {};
    if (brain.engine === 'api' && brain.key.trim()) body.secrets.brain = brain.key.trim();
    else if (brain.removeKey) body.secrets.brain = null;
    if (draft.openrouterKey.trim()) body.secrets.openrouter = draft.openrouterKey.trim();
    else if (draft.removeOpenrouterKey) body.secrets.openrouter = null;
    return body;
  }

  // ---------- the pages ----------

  const pages = [
    function welcome() {
      title('Welcome to CINCO ID Setup');
      para('This gets the computer ready in a few steps. Nothing here is required: press Next to skip anything you do not need. '
        + 'You can open Setup again any time from the Menu button, or by saying "setup".');
      const box = group('Your name');
      field(box, 'What should the computer call you?', textInput(draft.operator, value => { draft.operator = value; }, { name: 'operator', max: 40 }));
      if (settings.operatorFromEnv) box.append(el('div', 'setup-hint', 'Right now the name comes from CINCO_ID_OPERATOR, which wins over this setting.'));
      para(`Your settings, printouts and projects are kept in: ${settings.dataDir}`, 'setup-hint');
    },

    function voice() {
      title('Voice');
      para('How should the computer sound?');
      const box = group('Voices on this PC');
      const list = el('div', 'setup-list sunken');
      box.append(list);
      if (!status) {
        list.append(el('div', 'setup-hint', 'Looking for voices...'));
      } else {
        const options = [];
        if (status.voder.available) options.push(['voder', 'Robot voice']);
        for (const one of status.voices.filter(v => v.engine === 'windows')) {
          options.push([`windows:${one.name}`, `${one.name}${one.language ? `  (${one.language})` : ''}`]);
        }
        options.push(['browser', 'The screen\'s own voice']);
        if (!options.some(([value]) => value === draft.voice)) draft.voice = options[0][0];
        for (const [value, label] of options) radio(list, 'voice', value, label, draft.voice === value, picked => { draft.voice = picked; });
        if (!status.voder.available) {
          box.append(el('div', 'setup-hint', 'The robot voice is not installed yet. Install it once with this command, then restart CINCO ID:'));
          const command = el('input', 'setup-input setup-command');
          command.readOnly = true;
          command.value = status.voder.install;
          command.name = 'voderInstall';
          command.addEventListener('focus', () => command.select());
          box.append(command);
        }
      }
      const row = el('div', 'setup-row');
      page.append(row);
      const line = statusLine(page);
      button(row, 'Say something', async b => {
        b.disabled = true;
        line.textContent = 'Speaking...';
        try {
          const [engine, ...rest] = draft.voice.split(':');
          const { data } = await api('/api/setup/test-voice', { engine, voice: engine === 'windows' ? rest.join(':') : null, operator: draft.operator });
          await sound.sample(data, `Hello, ${draft.operator}. This is how I sound.`);
          line.textContent = sound.isMuted() ? 'The voice works (the sound is switched off right now).' : '';
        } catch (problem) {
          line.textContent = problem.message;
        } finally { b.disabled = false; }
      }, 'say-something');
    },

    function listening() {
      title('Listening');
      para('Should the computer listen to you? You can always type to it instead.');
      const box = group('Ears');
      const ears = draft.ears;
      const fields = el('div', 'setup-sub');
      const refresh = () => fields.classList.toggle('off', ears.engine !== 'whisper');
      radio(box, 'ears', 'off', 'Off: I type to the computer', ears.engine !== 'whisper', () => { ears.engine = 'off'; refresh(); });
      radio(box, 'ears', 'whisper', 'Listen, with faster-whisper on this PC', ears.engine === 'whisper', () => { ears.engine = 'whisper'; refresh(); });
      box.append(fields);
      field(fields, 'Python that has faster-whisper:', textInput(ears.python, value => { ears.python = value; }, { name: 'earsPython', placeholder: 'C:\\path\\to\\python.exe' }));
      const models = settings.speechModels.includes(ears.model) ? settings.speechModels : [ears.model, ...settings.speechModels];
      field(fields, 'Speech model:', select(models.map(model => [model, model]), ears.model, value => { ears.model = value; }, 'earsModel'));
      field(fields, 'Run it on:', select([['cuda', 'the graphics card (NVIDIA)'], ['cpu', 'the processor (slower)']], ears.device === 'cpu' ? 'cpu' : 'cuda', value => { ears.device = value; }, 'earsDevice'));
      const row = el('div', 'setup-row');
      fields.append(row);
      const line = statusLine(fields);
      button(row, 'Test', async b => {
        b.disabled = true;
        line.textContent = 'Asking that Python...';
        try {
          const { data } = await api('/api/setup/test-ears', { python: ears.python, model: ears.model });
          line.textContent = data.message;
        } catch (problem) { line.textContent = problem.message; } finally { b.disabled = false; }
      }, 'test-ears');
      refresh();
      para('Needed: a Python with the faster-whisper package, the speech model downloaded once beforehand, and ffmpeg. '
        + 'This app never downloads anything for it. A change here takes effect after a restart.', 'setup-hint');
    },

    function brain() {
      title('Brain');
      para('Anything the fixed phrases do not cover can go to a brain (an AI model). Without one, the fixed phrases, dancers and effects all still work.');
      const box = group('Brain');
      const b = draft.brain;
      const claude = el('div', 'setup-sub');
      const api = el('div', 'setup-sub');
      const refresh = () => { claude.classList.toggle('off', b.engine !== 'claude-cli'); api.classList.toggle('off', b.engine !== 'api'); };
      radio(box, 'brain', 'none', 'None', b.engine === 'none', () => { b.engine = 'none'; refresh(); });
      const claudeFound = status?.claude.found;
      radio(box, 'brain', 'claude-cli', 'The Claude sign-in on this PC (no key needed)', b.engine === 'claude-cli', () => { b.engine = 'claude-cli'; refresh(); }, {
        disabled: !claudeFound, note: !status ? 'checking...' : claudeFound ? '' : 'the claude command is not on this PC',
      });
      box.append(claude);
      field(claude, 'Model:', textInput(b.claudeModel, value => { b.claudeModel = value; }, { name: 'claudeModel', max: 120 }));
      radio(box, 'brain', 'api', 'A service with a key', b.engine === 'api', () => { b.engine = 'api'; refresh(); });
      box.append(api);
      const address = textInput(b.baseUrl, value => { b.baseUrl = value; }, { name: 'brainUrl', placeholder: 'https://...' });
      const presets = Object.entries(settings.presets).map(([name, preset]) => [name, preset.label]);
      field(api, 'Service:', select([...presets, ['other', 'Another service (its address)']], b.preset, value => {
        b.preset = value;
        if (settings.presets[value]) { b.baseUrl = settings.presets[value].baseUrl; b.apiKeyEnv = settings.presets[value].apiKeyEnv; }
        address.value = b.baseUrl;
        address.disabled = value !== 'other';
        keyHint.textContent = keyText();
      }, 'brainPreset'));
      field(api, 'Address:', address);
      address.disabled = b.preset !== 'other';
      field(api, 'Model:', textInput(b.model, value => { b.model = value; }, { name: 'brainModel', max: 120, placeholder: 'the model name your service lists' }));
      const key = textInput('', value => { b.key = value; }, { type: 'password', name: 'brainKey', max: 400, placeholder: settings.secrets.brain.source === 'stored' ? '(a key is stored; type to replace it)' : '' });
      key.disabled = !settings.canStoreSecrets;
      field(api, 'Key:', key);
      const keyText = () => {
        const envName = settings.presets[b.preset]?.apiKeyEnv ?? null;
        const info = settings.secrets.brain;
        if (!settings.canStoreSecrets) return `Keys can only be stored by the desktop app. Set the environment variable ${envName ?? 'for your service'} before starting it instead.`;
        if (info.source === 'stored') return 'A key is stored, encrypted with your Windows sign-in. It is never shown again.';
        if (envName) return `The key is kept encrypted on this PC. Without one, the environment variable ${envName} is used.`;
        return 'The key is kept encrypted on this PC. Leave it empty for a service that needs none.';
      };
      const keyHint = el('div', 'setup-hint', keyText());
      api.append(keyHint);
      if (settings.secrets.brain.source === 'stored') {
        const remove = el('label', 'setup-check');
        const box2 = el('input');
        box2.type = 'checkbox';
        box2.name = 'removeBrainKey';
        box2.checked = b.removeKey;
        box2.addEventListener('change', () => { b.removeKey = box2.checked; });
        remove.append(box2, el('span', '', 'Remove the stored key'));
        api.append(remove);
      }
      refresh();
    },

    function whatsappPage() {
      title('WhatsApp');
      para('Linking makes CINCO ID one more linked device on your WhatsApp, like WhatsApp on a computer. '
        + 'It then shows who is calling and can decline a call. It cannot answer calls, and it never hands your messages to the brain.');

      const pc = group('This PC');
      const facts = el('div', 'setup-facts');
      pc.append(facts);
      const fact = label => { const row = el('div'); const value = el('b', '', 'checking...'); row.append(el('span', 'setup-label', label), value); facts.append(row); return value; };
      const programFact = fact('WhatsApp connector:');
      const nodeFact = fact('Node.js:');
      const pcRow = el('div', 'setup-row');
      pc.append(pcRow);
      const install = button(pcRow, 'Install', () => act('install'), 'whatsapp-install');
      const check = button(pcRow, 'Check again', () => act('check'), 'whatsapp-check');
      const installLine = statusLine(pc);
      installLine.dataset.role = 'whatsapp-install-status';
      const needs = el('div', 'setup-hint', 'The link runs a small helper program, the WhatsApp connector (mcp-whatsapp-web). It needs Node.js 22 or newer on this PC, '
        + 'and Git to install it. Install downloads it from its author\'s page on GitHub into your data folder; nothing else is changed.');
      pc.append(needs);

      const box = group('Link');
      const line = statusLine(box);
      line.dataset.role = 'whatsapp-status';
      const qrWrap = el('div', 'whatsapp-qr-wrap');
      const qr = el('img', 'whatsapp-qr');
      qr.alt = 'WhatsApp QR code';
      const qrHint = el('div', 'setup-hint', 'On your phone, open WhatsApp, then Settings, Linked devices, Link a device, and point the phone at this code. It changes every little while; that is normal.');
      qrWrap.append(qr, qrHint);
      box.append(qrWrap);
      // The first time the code appears, bring all of it into view.
      let scrollWhenLoaded = false;
      qr.addEventListener('load', () => {
        if (!scrollWhenLoaded) return;
        scrollWhenLoaded = false;
        qrWrap.scrollIntoView({ block: 'nearest' });
      });
      const row = el('div', 'setup-row');
      box.append(row);
      const link = button(row, 'Link WhatsApp', () => act('link'), 'whatsapp-link');
      const stop = button(row, 'Stop linking', () => act('stop'), 'whatsapp-stop');
      const test = button(row, 'Test call window', async b => {
        b.disabled = true;
        try { await api('/api/command', { text: 'test call' }); } catch (problem) { error(problem.message); } finally { b.disabled = false; }
      }, 'whatsapp-test-call');
      const unlink = button(row, 'Unlink...', () => { asking.hidden = false; unlink.disabled = true; }, 'whatsapp-unlink');
      const asking = el('div', 'setup-confirm');
      asking.hidden = true;
      asking.append(el('div', 'setup-text', 'Unlink WhatsApp? CINCO ID is removed from the linked devices on your WhatsApp, and calls no longer show up here.'));
      const askRow = el('div', 'setup-row');
      asking.append(askRow);
      button(askRow, 'Yes, unlink', () => { asking.hidden = true; act('unlink', { confirm: true }); }, 'whatsapp-unlink-yes');
      button(askRow, 'No', () => { asking.hidden = true; unlink.disabled = false; }, 'whatsapp-unlink-no');
      box.append(asking);

      const pairing = el('div', 'setup-sub whatsapp-pairing');
      pairing.append(el('div', 'setup-hint', 'Or link with your phone number instead of the code: type it with the country code, then press Get a code.'));
      const pairRow = el('div', 'setup-row');
      const phone = textInput('', () => {}, { name: 'whatsappPhone', placeholder: 'for example 4915112345678', max: 20 });
      pairRow.append(phone);
      button(pairRow, 'Get a code', async b => {
        b.disabled = true;
        pairLine.textContent = 'Asking WhatsApp for a code...';
        try {
          const { data } = await api('/api/setup/whatsapp', { action: 'pair', phone: phone.value });
          pairLine.textContent = data.message;
          pairCode.textContent = data.code ?? '';
        } catch (problem) { pairLine.textContent = problem.message; pairCode.textContent = ''; } finally { b.disabled = false; }
      }, 'whatsapp-pair');
      pairing.append(pairRow);
      const pairCode = el('div', 'whatsapp-code');
      pairCode.dataset.role = 'whatsapp-code';
      const pairLine = statusLine(pairing);
      pairing.append(pairCode);
      box.append(pairing);

      let shown = null; // a problem from the last button, kept on screen until the next one
      async function act(action, extra = {}) {
        shown = null;
        for (const b of [install, check, link, stop, unlink]) b.disabled = true;
        if (action === 'link') line.textContent = 'Starting the WhatsApp helper...';
        if (action === 'install') { installLine.textContent = 'Starting...'; installLine.hidden = false; }
        try {
          await api('/api/setup/whatsapp', { action, ...extra });
        } catch (problem) {
          shown = { where: action === 'install' || action === 'check' ? installLine : line, text: problem.message };
        }
        await poll();
      }

      const update = waUpdate = data => {
        const program = data.program ?? {};
        const node = data.node ?? {};
        const task = data.install ?? {};
        programFact.textContent = program.ok ? `version ${program.version} (${program.source === 'installed' ? 'installed by CINCO ID' : program.source === 'settings' ? 'the folder in the settings' : 'the folder next to CINCO ID'})`
          : program.tooOld ? `version ${program.version}, too old` : program.found ? 'not usable' : 'not installed';
        nodeFact.textContent = node.ok ? `version ${node.version}` : node.found ? `version ${node.version ?? '?'}, too old` : 'not found';
        install.hidden = Boolean(program.ok) && !task.running;
        install.disabled = Boolean(task.running) || !node.ok;
        check.hidden = Boolean(program.ok && node.ok);
        check.disabled = Boolean(task.running);
        const progress = task.running || task.ok === false ? [task.message, ...(task.lines ?? []).slice(-2)] : [task.message];
        installLine.textContent = task.message ? progress.filter(Boolean).join('\n')
          : !node.ok ? node.message ?? '' : !program.ok ? program.message ?? '' : '';
        const ready = program.ok && node.ok;
        // Once everything is there, the long explanation gives way to the link itself.
        needs.textContent = ready && !task.running
          ? 'The link runs the WhatsApp connector with the Node.js on this PC.'
          : 'The link runs a small helper program, the WhatsApp connector (mcp-whatsapp-web). It needs Node.js 22 or newer on this PC, '
            + 'and Git to install it. Install downloads it from its author\'s page on GitHub into your data folder; nothing else is changed.';
        installLine.hidden = !installLine.textContent;
        line.textContent = data.text ?? '';
        link.hidden = data.running;
        link.disabled = !ready || Boolean(task.running);
        stop.hidden = !data.running || data.linked;
        stop.disabled = false;
        test.hidden = !data.linked;
        unlink.hidden = !data.linked;
        if (!data.linked) asking.hidden = true;
        unlink.disabled = !asking.hidden;
        pairing.classList.toggle('off', !data.running || data.linked);
        const showQr = Boolean(data.running && !data.linked && data.qr);
        const appearing = showQr && qrWrap.classList.contains('off');
        if (showQr && qr.getAttribute('src') !== data.qr) qr.src = data.qr;
        if (!showQr) qr.removeAttribute('src');
        qrWrap.classList.toggle('off', !showQr);
        if (appearing) scrollWhenLoaded = true;
        if (showQr && !['waiting_for_link', 'reconnecting'].includes(data.state)) line.textContent = 'Waiting for your phone to scan the code.';
        if (data.linked) pairCode.textContent = '';
        if (shown) { shown.where.textContent = shown.text; shown.where.hidden = false; }
      };

      // Keeps asking while this page is open: the QR code changes, and it switches to "Linked" by itself.
      let round = 0;
      async function poll() {
        clearTimeout(waPoller);
        const mine = ++round;
        try {
          const wantQr = whatsapp === null || (whatsapp.running && !whatsapp.linked);
          const { data } = await api(`/api/setup/whatsapp${wantQr ? '?qr=1' : ''}`);
          whatsapp = data;
          if (waUpdate === update) update(data);
        } catch { /* the next round tries again */ }
        if (waUpdate === update && mine === round) waPoller = setTimeout(poll, 2000);
      }
      if (whatsapp) update(whatsapp);
      poll();
    },

    function dancers() {
      title('New dancers');
      para('Saying "generate a new sequence of ..." makes a brand-new dancer in the cloud, on your own Modal account '
        + '(about 6 minutes and about 35 cents per dancer). The demo dancers work without any of this. '
        + 'docs/MEDIA.md explains the first time on your own account, including the free Hugging Face sign-in the better dance model needs.');
      const box = group('Modal');
      const lines = el('div', 'setup-facts');
      box.append(lines);
      const fact = (label, value) => { const row = el('div'); row.append(el('span', 'setup-label', label), el('b', '', value)); lines.append(row); };
      if (!status) fact('This PC:', 'checking...');
      else {
        fact('Modal tools:', status.modal.command ? 'found' : 'not found (install them with: pip install modal)');
        fact('Signed in to Modal:', status.modal.signedIn ? 'yes' : 'not yet');
      }
      field(box, 'Python for the dancer tools:', textInput(draft.media.python, value => { draft.media.python = value; }, { name: 'mediaPython', placeholder: 'python' }));
      const row = el('div', 'setup-row');
      box.append(row);
      const line = statusLine(box);
      const showTask = task => {
        if (!task) return;
        const progress = typeof task.progress === 'number' ? ` (${Math.round(task.progress * 100)}%)` : '';
        line.textContent = [task.message + (task.running ? progress : ''), ...(task.lines ?? []).slice(-3)].filter(Boolean).join('\n');
      };
      const watch = name => {
        clearInterval(poller);
        poller = setInterval(async () => {
          try {
            const { data } = await api(`/api/setup/task?name=${name}`);
            showTask(data);
            if (!data.running) {
              clearInterval(poller);
              if (name === 'modal-login') refreshStatus();
            }
          } catch { clearInterval(poller); }
        }, 1000);
      };
      const run = async (name, extra = {}) => {
        try {
          // The tools use the Python named above, so it is saved first.
          await api('/api/settings', { media: { python: draft.media.python }, announce: false });
          const { data } = await api('/api/setup/task', { task: name, ...extra });
          showTask(data);
          watch(name);
        } catch (problem) { line.textContent = problem.message; }
      };
      button(row, 'Sign in to Modal', () => run('modal-login'), 'modal-login');
      button(row, 'Prepare...', () => askToPrepare(), 'prepare');

      const or = group('OpenRouter (optional)');
      or.append(el('div', 'setup-hint', 'Only needed for the hosted dance models (MiniMax, Seedance). The key is kept encrypted on this PC and handed only to the dancer tools.'));
      const key = textInput('', value => { draft.openrouterKey = value; }, { type: 'password', name: 'openrouterKey', max: 400, placeholder: settings.secrets.openrouter.source === 'stored' ? '(a key is stored; type to replace it)' : '' });
      key.disabled = !settings.canStoreSecrets;
      field(or, 'OpenRouter key:', key);
      const info = settings.secrets.openrouter;
      or.append(el('div', 'setup-hint', !settings.canStoreSecrets ? 'Keys can only be stored by the desktop app. Set OPENROUTER_API_KEY instead.'
        : info.source === 'stored' ? 'A key is stored.' : info.source === 'environment' ? 'Right now OPENROUTER_API_KEY from the environment is used.' : 'No key yet.'));
      if (info.source === 'stored') {
        const remove = el('label', 'setup-check');
        const check = el('input');
        check.type = 'checkbox';
        check.name = 'removeOpenrouterKey';
        check.checked = draft.removeOpenrouterKey;
        check.addEventListener('change', () => { draft.removeOpenrouterKey = check.checked; });
        remove.append(check, el('span', '', 'Remove the stored key'));
        or.append(remove);
      }
      api('/api/setup/task?name=prepare').then(({ data }) => { if (data.running || data.ok !== null) { showTask(data); if (data.running) watch('prepare'); } }).catch(() => {});
    },

    function finish() {
      if (result) {
        title(result.restart.length ? 'Almost done' : 'Done');
        para(`Saved. The computer will call you ${result.operator}.`);
        if (result.operatorFromEnv) para('The name you typed is saved, but CINCO_ID_OPERATOR is set, so that name is used while it is.', 'setup-hint');
        if (result.restart.includes('listening')) {
          para('The listening settings take effect after a restart.');
          if (shell?.restart) {
            const row = el('div', 'setup-row');
            page.append(row);
            button(row, 'Restart now', () => shell.restart(), 'restart');
          } else {
            para('Stop CINCO ID and start it again to use them.', 'setup-hint');
          }
        }
        return;
      }
      title('Ready to save');
      para('This is what will be saved:');
      const body = collect();
      const [engine, ...rest] = draft.voice.split(':');
      const voiceName = engine === 'voder' ? 'Robot voice' : engine === 'browser' ? 'The screen\'s own voice' : rest.join(':');
      const brainText = body.brain.engine === 'none' ? 'none'
        : body.brain.engine === 'claude-cli' ? `the Claude sign-in on this PC (${body.brain.model || 'haiku'})`
          : `${settings.presets[draft.brain.preset]?.label ?? body.brain.baseUrl}, model ${body.brain.model || '(none given)'}`;
      const keyNote = (name, info) => body.secrets[name] ? 'a new key will be stored' : body.secrets[name] === null ? 'the stored key will be removed' : info.set ? `kept (${info.source === 'stored' ? 'stored' : 'from the environment'})` : 'none';
      const summary = el('div', 'setup-facts sunken setup-summary');
      const fact = (label, value) => { const row = el('div'); row.append(el('span', 'setup-label', label), el('b', '', value)); summary.append(row); };
      fact('Your name:', draft.operator);
      fact('Voice:', voiceName);
      fact('Listening:', body.voice.stt.engine === 'whisper' ? `faster-whisper, ${body.voice.stt.model}` : 'off');
      fact('Brain:', brainText);
      if (body.brain.engine === 'api') fact('Brain key:', keyNote('brain', settings.secrets.brain));
      fact('WhatsApp:', whatsapp?.linked ? 'linked' : whatsapp?.running ? 'waiting to be linked' : 'not linked');
      fact('New dancers:', status?.modal.signedIn ? 'signed in to Modal' : 'not set up');
      fact('OpenRouter key:', keyNote('openrouter', settings.secrets.openrouter));
      page.append(summary);
      para('Press Finish to save.', 'setup-hint');
    },
  ];

  function renderConfirm() {
    title('Prepare the dancer tools?');
    const info = prepare;
    if (!info) {
      para('Asking the dancer tools what your Modal account still needs (this spends nothing)...');
    } else if (info.found) {
      if (info.summary) para(`The plan: ${info.summary}.`);
      para(`This sets up the tools for new dancers in your Modal account. It downloads ${info.size ? `about ${info.size} of models into your Modal cloud storage (not onto this PC)` : 'the models into your Modal cloud storage'}, `
        + `takes about ${info.time ?? 'a while'} and costs about ${info.cost ?? 'a few cents'}, charged to your Modal account. Anything your account already has is skipped.`);
      if (info.danceModelNow) para(`New dancers would use ${info.danceModelNow} right now.${info.why ? ` ${info.why}` : ''}`, 'setup-hint');
      if (info.ltxSignIn) para(info.ltxSignIn, 'setup-hint');
      para(`(From ${info.source}.${info.fromTools ? '' : ' The dancer tools could not be asked directly, so these are the guide\'s numbers for an account that has nothing yet.'})`, 'setup-hint');
    } else {
      para('This sets up the tools for new dancers in your Modal account and is charged to it. How much it costs could not be found out, so read docs/MEDIA.md first.'
        + (info.reason ? ` (${info.reason})` : ''));
    }
    para('Do you want to start it now?');
    const row = el('div', 'setup-row');
    page.append(row);
    const yes = button(row, 'Yes, prepare', async () => {
      confirming = false;
      render();
      const line = page.querySelector('.setup-status');
      try {
        await api('/api/settings', { media: { python: draft.media.python }, announce: false });
        const { data } = await api('/api/setup/task', { task: 'prepare', confirm: true });
        if (line) line.textContent = data.message;
        render();
      } catch (problem) { if (line) line.textContent = problem.message; }
    }, 'prepare-yes');
    yes.disabled = !info;
    button(row, 'No', () => { confirming = false; render(); }, 'prepare-no');
  }

  /** "Prepare...": first find out what it would cost on this account, then ask. */
  async function askToPrepare() {
    confirming = true;
    prepare = null;
    render();
    try {
      await api('/api/settings', { media: { python: draft.media.python }, announce: false });
      prepare = (await api('/api/setup/prepare-info')).data;
    } catch (problem) {
      prepare = { found: false, reason: problem.message };
    }
    if (confirming) render();
  }

  function render(problem = null) {
    page.replaceChildren();
    // Only the WhatsApp page keeps asking the computer; any other page stops that.
    clearTimeout(waPoller);
    waPoller = null;
    waUpdate = null;
    stepList.replaceChildren(...STEPS.map((name, index) => el('li', index === step ? 'current' : index < step ? 'done' : '', name)));
    if (!settings) {
      title('Setup');
      para(problem ?? 'Reading the settings...');
    } else if (confirming) {
      renderConfirm();
    } else {
      pages[step]();
      if (problem) error(problem);
    }
    const last = step === STEPS.length - 1;
    back.disabled = !settings || step === 0 || busy || Boolean(result) || confirming;
    next.disabled = !settings || busy || confirming;
    next.textContent = result ? 'Close' : last ? 'Finish' : 'Next >';
    next.dataset.role = result ? 'close' : last ? 'finish' : 'next';
    cancel.disabled = busy;
    cancel.hidden = Boolean(result);
    const focus = page.querySelector('input:not([disabled]):not([type=radio]):not([type=checkbox])');
    if (focus && step === 0) focus.focus();
  }

  async function finish() {
    busy = true;
    render();
    try {
      const { data } = await api('/api/settings', collect());
      saved = true;
      result = data;
      settings = data.settings;
      draft.brain.key = '';
      draft.openrouterKey = '';
    } catch (problem) {
      busy = false;
      if (problem.field in FIELD_STEP) step = FIELD_STEP[problem.field];
      render(problem.message);
      return;
    }
    busy = false;
    render();
  }

  const close = () => context.close();
  back.addEventListener('click', () => { if (step > 0) { step--; render(); } });
  next.addEventListener('click', () => {
    if (result) return close();
    if (step === STEPS.length - 1) return finish();
    step++;
    render();
  });
  cancel.addEventListener('click', close);

  async function refreshStatus() {
    try {
      status = (await api('/api/setup/status')).data;
    } catch { status = { voices: [], voder: { available: false }, claude: { found: false }, modal: { command: false, signedIn: false }, openrouter: { set: false }, ears: { configured: false } }; }
    if (!whatsapp) {
      try { whatsapp = (await api('/api/setup/whatsapp')).data; } catch { /* the WhatsApp page asks again */ }
    }
    // The WhatsApp page keeps itself up to date; drawing it again would only lose what is typed there.
    if (settings && !busy && !confirming && !waUpdate) render();
  }

  (async () => {
    try {
      settings = (await api('/api/settings')).data;
      draft = makeDraft();
      render();
    } catch (problem) {
      render(`The settings could not be read: ${problem.message}`);
      return;
    }
    refreshStatus();
  })();
  render();
}
