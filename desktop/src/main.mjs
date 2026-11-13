// Litpage desktop shell. One window that shows the Litpage web app, served either by the server bundled with this
// app (data stays on this computer) or by a Litpage server the person already hosts. The choice is made on the
// first start (setup.html) and can be changed from the File menu.
import { app, BrowserWindow, ipcMain, Menu, session, shell } from 'electron';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureSession, readUserEnv, startServer } from './server.mjs';

// a separate profile, for development and for running a second copy side by side
if (process.env.LITPAGE_USER_DATA) app.setPath('userData', process.env.LITPAGE_USER_DATA);

const userData = app.getPath('userData');
const configFile = join(userData, 'config.json');
const dataDir = join(userData, 'data');
const envFile = join(userData, 'litpage.env');
const setupFile = join(import.meta.dirname, 'setup.html');
const setupUrl = pathToFileURL(setupFile).href;

const resources = app.isPackaged ? process.resourcesPath : join(import.meta.dirname, '..', 'build');
const serverEntry = join(resources, 'server', 'apps', 'server', 'dist', 'main.mjs');
const bundledNode = join(resources, 'runtime', 'node.exe');
// development, or a machine the bundled runtime is not built for: the Node.js on PATH (26 or later)
const nodePath = process.platform === 'win32' && existsSync(bundledNode) ? bundledNode : (process.env.LITPAGE_NODE ?? 'node');

const ENV_TEMPLATE = `# Settings for the Litpage server that runs inside the desktop app, one KEY=VALUE per line.
# Restart Litpage after changing this file. Lines starting with # are ignored.
#
# AI with your own key (pick one provider):
# OPENAI_API_KEY=
# OPENAI_BASE_URL=
# ANTHROPIC_API_KEY=
# NC_AI_MODEL=
#
# Outgoing mail:
# NC_SMTP_URL=smtps://user:password@mail.example.com
# NC_MAIL_FROM=Litpage <notify@example.com>
`;

/** @type {{ mode?: 'local' | 'remote', remoteUrl?: string, account?: { email: string, password: string, name?: string }, bounds?: Electron.Rectangle }} */
let config = {};
try {
  config = JSON.parse(readFileSync(configFile, 'utf8'));
} catch {
  /* first start */
}
function saveConfig() {
  mkdirSync(userData, { recursive: true });
  writeFileSync(configFile, JSON.stringify(config, null, 2));
}

/** @type {BrowserWindow | null} */
let win = null;
/** @type {Awaited<ReturnType<typeof startServer>> | null} */
let server = null;
/** origin of the Litpage app the window is showing; everything else opens in the default browser */
let appOrigin = null;
let lastError = '';
let quitting = false;

const originOf = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};
const isApp = (url) => !!appOrigin && originOf(url) === appOrigin;
const isSetup = (url) => typeof url === 'string' && url.split(/[?#]/)[0] === setupUrl;

function openExternal(url) {
  try {
    if (['http:', 'https:', 'mailto:'].includes(new URL(url).protocol)) void shell.openExternal(url);
  } catch {
    /* not a URL */
  }
}

// ---------------------------------------------------------------- window
function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 420, minHeight: 480,
    ...(config.bounds ?? {}),
    show: false,
    backgroundColor: '#ffffff',
    title: 'Litpage',
    icon: join(import.meta.dirname, '..', 'assets', 'icon.png'),
    webPreferences: { preload: join(import.meta.dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.once('ready-to-show', () => win?.show());
  win.on('close', () => {
    if (win && !win.isMinimized() && !win.isFullScreen()) {
      config.bounds = win.getBounds();
      saveConfig();
    }
  });
  win.on('closed', () => { win = null; });
  win.webContents.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    // -3 is an aborted load (a navigation replaced it), not a failure
    if (!isMainFrame || code === -3 || isSetup(url)) return;
    void showSetup(config.mode === 'remote'
      ? `Could not reach ${config.remoteUrl} (${description}).`
      : `Litpage could not be opened (${description}).`);
  });
}

// every window and frame: stay inside the Litpage app, hand other links to the default browser
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (isApp(url)) return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: { preload: undefined, sandbox: true } } };
    openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (e, url) => {
    if (isApp(url)) return;
    e.preventDefault();
    if (!isSetup(url)) openExternal(url);
  });
});

function setupPermissions() {
  // what the web app uses: microphone for meeting notes, clipboard, notifications, fullscreen media
  const allowed = new Set(['media', 'clipboard-read', 'clipboard-sanitized-write', 'notifications', 'fullscreen']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, done, details) => {
    done(allowed.has(permission) && isApp(details.requestingUrl ?? ''));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => allowed.has(permission) && !!appOrigin && origin === appOrigin);
}

// ---------------------------------------------------------------- where Litpage runs
async function stopServer() {
  const s = server;
  server = null;
  await s?.stop();
}

function serverLog() {
  const dir = join(userData, 'logs');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'server.log');
  const big = existsSync(file) && statSync(file).size > 5 * 1024 * 1024;
  const stream = createWriteStream(file, { flags: big ? 'w' : 'a' });
  stream.write(`\n--- ${new Date().toISOString()} ---\n`);
  return stream;
}

async function openLocal() {
  if (!existsSync(serverEntry)) throw new Error('The bundled server is missing. Run "npm run bundle" in the desktop folder.');
  if (!existsSync(envFile)) writeFileSync(envFile, ENV_TEMPLATE);
  const log = serverLog();
  const started = await startServer({
    nodePath, serverEntry, dataDir, account: config.account,
    extraEnv: readUserEnv(envFile),
    onLog: (text) => log.write(text),
  });
  server = started;
  started.child.once('exit', () => {
    log.end();
    if (server !== started || quitting) return;
    server = null;
    void showSetup('The Litpage server stopped unexpectedly. The log is in the data folder under logs.');
  });
  appOrigin = started.url;
  const jar = session.defaultSession.cookies;
  const [existing] = await jar.get({ url: started.url, name: 'lit_session' });
  const token = await ensureSession(started.url, config.account, existing?.value);
  if (token && token !== existing?.value) {
    await jar.set({
      url: started.url, name: 'lit_session', value: token, httpOnly: true, sameSite: 'lax',
      expirationDate: Math.floor(Date.now() / 1000) + 365 * 86400,
    });
  }
  await win?.loadURL(started.url);
}

async function openRemote() {
  appOrigin = originOf(config.remoteUrl);
  await win?.loadURL(config.remoteUrl);
}

async function openConfigured() {
  if (!win) createWindow();
  buildMenu();
  if (!config.mode) return showSetup();
  try {
    await stopServer();
    lastError = '';
    await (config.mode === 'local' ? openLocal() : openRemote());
  } catch (err) {
    // a failed page load is reported by did-fail-load; this is for a server that did not start
    if (!lastError && !isSetup(win?.webContents.getURL())) await showSetup(String(err?.message ?? err));
  }
}

async function showSetup(error = '') {
  lastError = error;
  appOrigin = null;
  await stopServer();
  if (!win) createWindow();
  buildMenu();
  await win.loadFile(setupFile).catch(() => {});
}

/** A Litpage server answers this endpoint without a session. */
async function probeRemote(url) {
  try {
    const res = await fetch(new URL('/api/rpc/checkSignInMethods', url), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10_000),
    });
    const json = await res.json();
    return res.ok && typeof json.hasAccount === 'boolean';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- setup page
const fromSetup = (event) => isSetup(event.senderFrame?.url);

ipcMain.handle('setup:state', (event) => {
  if (!fromSetup(event)) return null;
  return {
    mode: config.mode ?? null,
    remoteUrl: config.remoteUrl ?? '',
    name: config.account?.name ?? '',
    email: config.account?.email ?? '',
    hasLocalData: !!config.account && existsSync(join(dataDir, 'litpage.db')),
    error: lastError,
    version: app.getVersion(),
  };
});

ipcMain.handle('setup:choose', async (event, choice) => {
  if (!fromSetup(event)) return { error: 'Not allowed.' };
  if (choice?.mode === 'remote') {
    let url;
    try {
      url = new URL(String(choice.remoteUrl ?? '').trim());
    } catch {
      return { error: 'Enter the full address of your Litpage server, for example https://litpage.example.com' };
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return { error: 'The address must start with https:// or http://' };
    if (!(await probeRemote(url.origin))) return { error: `No Litpage server answered at ${url.origin}. Check the address and your connection.` };
    config.mode = 'remote';
    config.remoteUrl = url.origin;
  } else if (choice?.mode === 'local') {
    // the account exists once the database does; after that its email stays what it was
    if (!config.account || !existsSync(join(dataDir, 'litpage.db'))) {
      const email = String(choice.email ?? '').trim().toLowerCase() || 'me@litpage.local';
      if (!/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 254) return { error: 'That email address does not look right.' };
      config.account = { email, name: String(choice.name ?? '').trim().slice(0, 100) || undefined, password: randomBytes(24).toString('base64url') };
    }
    config.mode = 'local';
  } else {
    return { error: 'Choose where Litpage should run.' };
  }
  saveConfig();
  setImmediate(() => void openConfigured());
  return { ok: true };
});

// ---------------------------------------------------------------- menu
function buildMenu() {
  const local = config.mode === 'local';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: '&File',
      submenu: [
        { label: 'Change where Litpage runs…', click: () => void showSetup() },
        { label: 'Open data folder', enabled: local, click: () => void shell.openPath(userData) },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: '&View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
        { role: 'togglefullscreen' }, { role: 'toggleDevTools' },
      ],
    },
    { role: 'windowMenu' },
  ]));
}

// ---------------------------------------------------------------- lifecycle
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (e) => {
    quitting = true;
    if (!server) return;
    // let the server close its database before the process goes away
    e.preventDefault();
    void stopServer().finally(() => app.quit());
  });
  // no top-level await here: Electron holds back "ready" until this module has finished loading
  void app.whenReady().then(() => {
    setupPermissions();
    return openConfigured();
  });
}
