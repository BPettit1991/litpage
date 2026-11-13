// Exercises the bundled server through the same module the Electron shell uses. Needs `npm run bundle` first.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { DEFAULT_PORT, ensureSession, readUserEnv, startServer } from '../src/server.mjs';

const serverEntry = resolve(import.meta.dirname, '../build/server/apps/server/dist/main.mjs');
const account = { email: 'me@litpage.local', password: 'test-password-123', name: 'Tester' };
const dir = mkdtempSync(join(tmpdir(), 'litpage-desktop-'));
const base = { nodePath: process.execPath, serverEntry, account };
let server;

before(async () => {
  assert.ok(existsSync(serverEntry), 'run `npm run bundle` before the tests');
  server = await startServer({ ...base, dataDir: join(dir, 'a') });
});
after(async () => {
  await server?.stop();
  rmSync(dir, { recursive: true, force: true });
});

const alive = (child) => child.exitCode === null && child.signalCode === null;

test('serves the web app and the API on the preferred loopback port', async () => {
  assert.equal(server.port, DEFAULT_PORT);
  const page = await fetch(server.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<div id="lit-app">/);
  // an endpoint from api/modules: the bundle replaced the folder scan with static imports
  const res = await fetch(`${server.url}/api/rpc/getAccounts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 401);
  assert.ok(existsSync(join(dir, 'a', 'litpage.db')));
});

test('signs the local account in and keeps a session that is still valid', async () => {
  const token = await ensureSession(server.url, account);
  assert.ok(token);
  const res = await fetch(`${server.url}/api/rpc/getAccounts`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: `lit_session=${token}` }, body: '{}',
  });
  assert.equal(res.status, 200);
  const { accounts } = await res.json();
  assert.equal(accounts[0].email, account.email);
  assert.equal(accounts[0].spaces.length, 1);
  assert.equal(await ensureSession(server.url, account, token), token);
  assert.notEqual(await ensureSession(server.url, account, 'stale-token'), 'stale-token');
});

test('a wrong password yields no session', async () => {
  assert.equal(await ensureSession(server.url, { ...account, password: 'nope' }), null);
});

test('falls back to a free port when the preferred one is taken', async () => {
  const second = await startServer({ ...base, dataDir: join(dir, 'b') });
  try {
    assert.notEqual(second.port, DEFAULT_PORT);
    assert.equal((await fetch(second.url)).status, 200);
  } finally {
    await second.stop();
  }
  assert.ok(!alive(second.child));
});

test('the server exits when the shell goes away (stdin closes)', async () => {
  const blocker = createServer().listen(0, '127.0.0.1');
  await new Promise((r) => blocker.once('listening', r));
  const third = await startServer({ ...base, dataDir: join(dir, 'c'), port: blocker.address().port });
  blocker.close();
  const exited = new Promise((r) => third.child.once('exit', r));
  third.child.stdin.destroy();
  await exited;
  assert.ok(!alive(third.child));
});

test('reads litpage.env and ignores a missing file', () => {
  const file = join(dir, 'litpage.env');
  assert.deepEqual(readUserEnv(file), {});
  writeFileSync(file, '# AI\nOPENAI_API_KEY=sk-test\nNC_AI_MODEL="gpt-x"\n');
  assert.deepEqual({ ...readUserEnv(file) }, { OPENAI_API_KEY: 'sk-test', NC_AI_MODEL: 'gpt-x' });
});
