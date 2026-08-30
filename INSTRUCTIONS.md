# Using Mobinux — A Walkthrough

This is a tutorial for using the **app itself**, once it's installed
and your server is already set up. If you haven't deployed the
backend yet, start with [`docs/SETUP.md`](docs/SETUP.md) instead —
nothing in this app works without a server for it to talk to.

A video walkthrough is planned for later; for now, this covers
everything screen by screen.

---

## First launch — connecting to your server

The very first time you open the app, it asks for two things:

- **Server URL** — the HTTPS address of your backend, e.g.
  `https://your-domain.example` (no trailing slash)
- **API Key** — the secret from your server's `.env` file

Once saved, you land on the **Home** screen — everything else in the
app branches out from here.

## Home screen

The top of Home shows **Connected: [server name] · Switch** — tap it
any time to jump to the Servers screen and connect to a different
box. Below that:

- **Open Terminal** — jumps straight to the interactive terminal
  (covered below).
- **Service cards** — one per tracked/created service, each showing
  whether its last run succeeded, whether its schedule is armed, and
  four buttons: **Run Now**, **Restart**, **Pause**, **Resume**.
  - Tap a service's name to see its options; **long-press** it to
    remove it from the app.
- **Add a service** — see the next section.
- **Scripts** — your saved custom command sequences, each as its own
  card with a **Run** chip. Tap the card itself to edit it; long-press
  to delete it.
- **+ New Script** — create a new saved command sequence.

## Adding a service

Tap the toggle at the top of the "Add a service" card:

- **Track existing** — use this if you already set up a systemd
  service on the server yourself (following `docs/SETUP.md`). Just
  give it a display name and the exact unit name.
- **Create new** — use this to have the app actually build and start
  a brand new service for you, with no SSH needed at all. Fill in:
  - **Display name** and **unit name** (the unit name can only contain
    letters, numbers, `.`, `-`, `_`)
  - **Description** (optional)
  - **Working directory** (optional — defaults to wherever the app's
    shared "current directory" currently points; see the Files section
    below)
  - **Command to run** — the actual command, e.g.
    `/usr/bin/python3 app.py`
  - **Run on a schedule instead of continuously** — leave this off for
    a service that should just stay running; turn it on and enter
    24-hour times (e.g. `09:30,13:30,15:00`) for a job that should run
    at specific times each day instead.

Services you create this way can be fully removed later (long-press →
they're actually uninstalled, not just hidden). Services you only
*tracked* are just untracked when removed — the app never touches
something it didn't create.

## Running a service

- **Run Now** — triggers an immediate run, without waiting for its
  schedule.
- **Restart** — stops and starts it fresh.
- **Pause** / **Resume** — stops or re-arms its *schedule* specifically
  (for a scheduled job, this is "should it fire again later," not "is
  it running right now").
- **View logs** — the most recent output from that service.

## Scripts — saved command sequences

A script is a named list of shell commands that run in order with one
tap — for example, "activate a virtual environment → install
dependencies → start the app."

- **+ New Script** opens the editor: give it a name, then add as many
  command lines as you need (**+ Add Line** for another). Each line
  has its own small **Run** button to test it by itself before saving
  the whole script.
- Tap a saved script's **Run** chip to execute every line in order —
  it stops at the first one that fails, and shows you exactly which
  line and why.
- If a script finishes **completely successfully**, the app's shared
  "current directory" (see Files, below) automatically resets back to
  your home directory afterward — so one script's internal navigation
  (e.g. a `cd` into a subfolder) never carries over into a *different*
  script you run later. If a script fails partway through, its
  directory is left wherever it stopped, on purpose, so you can look
  around and see what happened.

## The Terminal

Tap **Open Terminal** on the Home screen for a real, live shell
session — this is a genuine terminal connection (not just a
command-and-response box), so command history, Tab-completion, and
Ctrl+C all work normally.

- Type into the box at the bottom and hit **Send** (or your keyboard's
  Enter) the same as any terminal.
- The key row above the input gives you the special keys a phone
  keyboard doesn't have: **Esc**, **Tab**, the four **arrow keys**,
  **Ctrl+C** (interrupt whatever's currently running), **Ctrl+D**
  (end of input / log out of the shell), and **Ctrl+L** (clear the
  screen).
- If the terminal detects a plain yes/no prompt, **Yes**/**No**
  buttons appear automatically above the input.
- See the README's Limitations section for what this terminal
  deliberately doesn't attempt (mainly: tools with fancy full-screen
  interactive menus won't *display* correctly, even though your
  keypresses do reach them).

## Files — browsing and editing the server

Tap the **≡** icon (top-left of Home) to open the file browser.

- Tap a **folder** to open it; tap **Up** to go to its parent.
- Tap a **file** to open it in the built-in editor — syntax-highlighted,
  VS-Code-dark-styled viewing, with an **Edit** button to make changes
  and a **Save** button to write them back to the server.
  - While editing, use **Find & Replace** to search within the file,
    jump between matches, and replace one or all occurrences.
- **Long-press** a file instead to send it to another app on your
  phone via Android's "Open With" sheet (useful for file types this
  app's editor doesn't handle well, like images).
- Type a path directly and hit **Go** to jump anywhere, instead of
  tapping through folders one at a time.

This screen shares the same "current directory" concept as custom
commands and scripts — navigating here changes where your next script
or terminal `cd` starts from, and vice versa.

## Switching servers

Tap **Connected: [name] · Switch** from Home, or the header's
**Settings** button, to reach the **Servers** screen:

- Tap a saved server to make it the active one — everything else in
  the app (services, scripts, the terminal, the file browser)
  immediately follows whichever server is active.
- **+ Add Server** to save a new connection.
- **Long-press** a server to edit or remove it.

Scripts are saved on your *phone*, not tied to any one server — a
script runs against whichever server is currently active when you tap
Run, which is worth double-checking if you manage more than one box.

---

Questions or something not covered here? Open an issue in this repo,
or check `docs/SETUP.md` for anything related to the *backend* rather
than the app itself.
