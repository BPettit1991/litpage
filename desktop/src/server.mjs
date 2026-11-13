// Runs the bundled Litpage server as a child process and signs the local account in. No Electron imports here, so
// the tests can exercise it with plain Node (test/server.test.mjs).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

/** Loopback port the app prefers, so its origin (and with it the browser storage for theme and layout) is stable. */
export const DEFAULT_PORT = 47821;

const READY = /\[server\] listening on http:\/\/[^\s:]+:(\d+)/;

/**
 * Optional `litpage.env` in the user's data folder: KEY=VALUE lines passed to the server, for the settings that
 * are environment variables there (AI provider keys, SMTP). Never overrides what the shell sets itself.
 */
export function readUserEnv(file) {
  if (!existsSync(file)) return {};
  try {
    return parseEnv(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function launch({ nodePath, serverEntry, env, port, onLog }) {
  return new Promise((resolve, reject) => {
    const child = spawn(nodePath, [serverEntry], {
      env: { ...env, PORT: String(port) },
      // stdin stays an open pipe: the server exits when it closes (src/server-entry.ts)
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let settled = false;
    let tail = '';
    const read = (chunk) => {
      const text = chunk.toString();
      tail = (tail + text).slice(-4000);
      onLog?.(text);
      const m = !settled && READY.exec(tail);
      if (m) {
        settled = true;
        resolve({ child, port: Number(m[1]) });
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.stdin.on('error', () => {});
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(Object.assign(new Error(`Could not start the Litpage server: ${err.message}`), { code: err.code }));
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      reject(Object.assign(new Error(`The Litpage server stopped while starting (exit code ${code}).\n${tail.trim()}`), { addressInUse: /EADDRINUSE/.test(tail) }));
    });
  });
}

/**
 * Starts the server on 127.0.0.1 and resolves once it accepts requests.
 * `account` ({ email, password, name }) is created on the first start and is the one the shell signs in.
 */
export async function startServer({ nodePath, serverEntry, dataDir, account, port = DEFAULT_PORT, extraEnv = {}, onLog }) {
  mkdirSync(dataDir, { recursive: true });
  const env = (p) => ({
    ...process.env,
    ...extraEnv,
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    NC_DATA_DIR: dataDir,
    NC_PUBLIC_URL: `http://127.0.0.1:${p}`,
    NC_BOOTSTRAP_EMAIL: account.email,
    NC_BOOTSTRAP_PASSWORD: account.password,
    ...(account.name ? { NC_BOOTSTRAP_NAME: account.name } : {}),
    NC_BOOTSTRAP_WORKSPACE: account.workspace || 'My workspace',
  });
  let started;
  try {
    started = await launch({ nodePath, serverEntry, env: env(port), port, onLog });
  } catch (err) {
    if (!err.addressInUse) throw err;
    // something else holds the preferred port: let the system pick one
    started = await launch({ nodePath, serverEntry, env: env(0), port: 0, onLog });
  }
  const { child } = started;
  let exited = false;
  const done = new Promise((r) => child.once('exit', () => { exited = true; r(); }));
  return {
    url: `http://127.0.0.1:${started.port}`,
    port: started.port,
    child,
    /** Closes the pipe the server watches, then makes sure it is gone. */
    async stop() {
      if (exited) return;
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 3000);
      await done;
      clearTimeout(timer);
    },
  };
}

async function rpc(baseUrl, name, body, cookie) {
  const res = await fetch(`${baseUrl}/api/rpc/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie: `lit_session=${cookie}` } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  let json = {};
  try {
    json = await res.json();
  } catch {
    /* empty body */
  }
  return { res, json };
}

/**
 * Session token for the local account. `existing` (the token already in the window's cookie jar) is kept while the
 * server still accepts it, so a launch does not add a new session every time. Returns null when the account cannot
 * be signed in without the person (two-step verification is on): the app then shows its normal login page.
 */
export async function ensureSession(baseUrl, account, existing) {
  if (existing) {
    const { res } = await rpc(baseUrl, 'getAccounts', {}, existing);
    if (res.ok) return existing;
  }
  const { res, json } = await rpc(baseUrl, 'signInWithEmail', { email: account.email, password: account.password });
  if (!res.ok || json.mfaRequired) return null;
  for (const line of res.headers.getSetCookie()) {
    const m = /^lit_session=([^;]+)/.exec(line);
    if (m) return m[1];
  }
  return null;
}
