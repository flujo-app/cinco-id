# Beta Sequence

A talking computer with a Windows 95 screen. You tell it what to load, it opens far too many windows of
dancing figures, answers in a deadpan robot voice, and can do real work through an AI brain and outside tools.

It started as a tribute to a certain sketch about a man, his office computer and some dancing sequences. Say the
same lines and you get a similar evening. Say anything else and it still does something sensible.

![The Win95 desktop full of dancing sequences](docs/screenshot.png)

## Start it

```powershell
npm install
npm start          # its own window with a Win95 desktop
npm run overlay    # see-through: the windows and dancers sit on top of your real desktop
```

Keys that work everywhere while it runs:

| Keys | What happens |
|---|---|
| Ctrl+Alt+Space | start or stop talking to it |
| Ctrl+Alt+O | switch between its own window and the see-through mode |
| Ctrl+Alt+Q | quit |

In the window you can also hold the space bar to talk, or type into the "Computer" console.

## Things to say

| Say | It does |
|---|---|
| "Computer, load up Celery Man please." | opens that sequence in a window |
| "Could you kick up the 4d3d3d3?" | starts project 4d3d3d3: the screen fills with copies |
| "Add sequence: Oyster." | adds another dancer |
| "Give me a printout of Oyster smiling." | makes a printout and sends it to the PDF printer |
| "Do we have any new sequences?" | offers a held-back "beta sequence"; say "alright" to see it |
| "Can I get a hat wobble?" | wobbles everything above the hat line |
| "And a Flarhgunnstow?" | any made-up word becomes its own effect, and is remembered |
| "Nude Tayne." | asks you to repeat, then "This is not suitable for work. Are you sure?" |
| "Free" | takes the dancers out of their windows (best in see-through mode) |
| "Rainbow on Oyster", "tumble", "trails", "conga" ... | more effects; "normal" removes them |
| "Close Oyster", "clear the desktop" | tidies up |
| "Music off", "quiet" | stops the lounge music or the voice |
| "What voices do you have?", "use the Zira voice", "talk like the robot" | lists and switches the computer's voice |
| "Test call from my wife" | shows what an incoming call looks like |
| "New project", "kick up the beef" | makes a new, empty project with a hex name |
| anything else | goes to the brain, if one is connected |

"List everything" shows all projects, sequences, effects and learned words.

## Projects and sequences

Everything it can load lives in `projects/`. Each project is a folder with a hexadecimal name, and each dancer
("sequence") is a folder inside it. `projects/4d3d3d3` is the demo project. See [docs/PROJECTS.md](docs/PROJECTS.md).

Every sequence has a simple drawn puppet, so it always works, even offline. When a generated video clip exists for
a sequence, the clip is used instead. The clip generator and its costs are described in `docs/MEDIA.md` (once it has
been added).

## Settings

Copy `harness.config.example.json` to `harness.config.json` and change what you need. That file stays on your PC
and is not put into git. Without it, the fixed phrases, puppets, effects and the test call all still work.

- **Your name**: `operator`. The computer addresses you by it.
- **Voice out**: uses the Voder robot voice if the `voder` project sits next to this folder. Otherwise the
  voices built into Windows are used. It can also speak with any voice installed in Windows: set
  `"engine": "windows", "voice": "Microsoft Zira Desktop"`, or just say "use the Zira voice". Microsoft Sam is not
  part of Windows 10 or 11. If you install it yourself as a Windows voice, it shows up in the list and can be chosen
  like any other.
- **Voice in**: needs a Python that has `faster-whisper` and a speech model already on disk
  (`voice.stt`). Nothing is downloaded by this app.
- **Brain**: either `"engine": "claude-cli"` (uses the Claude sign-in on this PC, no paid key) or `"engine": "api"`
  with a `baseUrl`, `model` and the name of the environment variable that holds the key.
- **Outside tools**: list MCP servers under `mcpServers`. The brain may use them. Any tool that is not marked
  read-only by its server asks you "Shall I?" in a dialog box first, every time.
- **Printing**: every printout is saved as a picture in `printouts/` and also sent through the Windows print system to the PDF printer, which asks where to save the file. `"printouts": { "print": "dialog" }` shows the normal Windows print window instead, `"print": "off"` only saves the picture, and `"printer": "<name>"` picks another printer.

## Incoming WhatsApp calls

When someone calls you on WhatsApp, a window pops up with their saved name, WhatsApp name and number, the phone
rings, and the computer says who is calling. A missed call leaves a note.

This needs `mcp-whatsapp-web` version 1.4.0 or newer, which reports calls. To link the two:

```powershell
npm run whatsapp:link
```

It makes a private secret and prints three settings to give to the WhatsApp connector. After the connector has been
restarted, calls show up here. Only the caller's details are shown. Message text from outside is never handed to
the brain, so nobody can give the computer orders by writing to you.

## Letting other AI agents use the screen

While it runs, the computer offers a local door for AI agents at `http://127.0.0.1:19773/mcp` (MCP over HTTP).
Anything that can use MCP tools, such as FLUJO, Claude Code, Codex or a swarm, can then load sequences, apply
effects, open note windows, make it speak, or simply send it a sentence as if you had said it.

The door only opens with the access token in `.local/mcp-token` (sent as `Authorization: Bearer <token>`), and only
from this PC.

## Safety

- It listens on this PC only. Web pages open in your browser cannot give it orders.
- Outside events must be signed with the shared secret.
- The brain cannot read files or run programs. It only gets the screen tools and the outside tools you list.
- The cast is invented people. No real people's faces or likenesses, and nothing explicit: the "nude" variant is a skin-tone stage bodysuit with a hat (the drawn stand-in is a shop mannequin).

## Tests

```powershell
npm test                                   # fast checks of the logic, the local server and the security rules
npm run test:ui                            # starts the real app silently and plays the whole routine
node test/ui/overlay-check.mjs             # checks the see-through mode on the real desktop (Windows)
node test/ui/print-check.mjs               # checks that a printout reaches the Windows print system
node test/ui/clip-check.mjs "Celery Head"  # checks that a generated clip plays see-through
```
