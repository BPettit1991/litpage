# Litpage for Windows

A desktop app for Windows 10 and 11 (64-bit). It shows the same Litpage web app in its own window and can run in two
ways, chosen on the first start and changeable later under **File > Change where Litpage runs**:

- **On this computer.** The app starts the Litpage server that ships inside it. Pages, databases and files stay on
  the PC, it works offline, and you are signed in automatically.
- **Connect to a Litpage server.** The app is a client for a server you or your team already host. You sign in with
  your account there.

## How it is put together

| Part | What it is |
|---|---|
| `src/main.mjs` | Electron shell: window, menu, first-run setup, link and permission rules. |
| `src/server.mjs` | Starts and stops the bundled server and signs the local account in. |
| `src/server-entry.ts` | Entry of the bundled server. It exits when the shell goes away. |
| `src/setup.html`, `src/preload.cjs` | The "Where should Litpage run?" page and its bridge to the shell. |
| `scripts/bundle.mjs` | Builds `apps/web`, bundles `apps/server` into one file and fetches Node.js. |

The server needs Node.js 26; Electron ships an older Node. So the installer carries its own `node.exe` (version and
checksum pinned in `node-runtime.json`) and the shell runs the server with it as a child process on `127.0.0.1`.
Nothing in `apps/` or `packages/` is changed for the desktop build.

The local account's password is random, generated on the first start and kept in `config.json`. The server listens
on the loopback address only (port 47821, or a free port when that one is taken).

## Where things are stored

Everything is in `%APPDATA%\Litpage` (**File > Open data folder**):

| Path | Contents |
|---|---|
| `data\` | The SQLite database and uploaded files. Back this folder up. |
| `litpage.env` | Server settings as `KEY=VALUE` lines, for example an AI provider key. Restart the app after editing. |
| `config.json` | The chosen mode, the server address or local account, window size. |
| `logs\server.log` | Output of the bundled server. |

## Building

Requirements: Node.js 26 or later and pnpm 10, as for the rest of the repository.

```bash
pnpm install          # repository root
cd desktop
npm install
npm run bundle        # web app + server into desktop/build
npm test              # starts the bundled server and checks it
npm start             # run the shell from source, with the node on PATH as the server runtime
npm run dist          # Windows installer in desktop/release
```

`npm run dist` works on Windows as is. On Linux it needs Wine with 32-bit support (`wine` and `wine32:i386`) for the
installer step. The workflow in `.github/workflows/desktop-windows.yml` builds the installer on a Windows runner and
attaches it to the run.

If `npm install` skips install scripts, fetch the Electron binary for `npm start` with
`node node_modules/electron/install.js`.

## Limits

- The installer is not code signed, so Windows SmartScreen warns on the first run ("More info", then "Run anyway").
  Signing needs a certificate configured for electron-builder.
- There is no automatic update. Install a newer version over the old one; the data folder is kept.
- x64 only. It runs on Windows on ARM through emulation.
