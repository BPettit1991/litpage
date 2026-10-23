import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

process.env.NC_DATA_DIR = mkdtempSync(join(tmpdir(), 'nc-demo-data-'));
process.env.NC_DEMO_MODE = '1';
process.env.NC_BOOTSTRAP_EMAIL = 'demo@example.test';

let H: Record<string, (ctx: any, body: any) => any>;
let app: typeof import('../src/app.ts').app;
let db: typeof import('../src/db.ts');
let seed: typeof import('../src/seed.ts');
let auth: typeof import('../src/auth.ts');
let demo: typeof import('../src/demo.ts');
let newId: () => string;
const ids = {} as Record<string, string>;
const ctx = (userId: string | null, ip = '198.51.100.1') => ({ userId, ip, setCookie: () => {} });
const call = async (user: string | null, name: string, body: any = {}) => H[name](ctx(user), body);
const status = async (fn: () => unknown) => {
  try { await fn(); return 200; } catch (e: any) { return e?.status ?? 500; }
};
const tx = (user: string, operations: any[], spaceId = ids.space) => H.applyChanges(ctx(user), { transactions: [{ id: newId(), spaceId, operations }] });

beforeAll(async () => {
  ({ newId } = await import('@nc/shared/ids.ts'));
  ({ app } = await import('../src/app.ts'));
  H = (await import('../src/api/handlers.ts')).handlers as any;
  db = await import('../src/db.ts');
  seed = await import('../src/seed.ts');
  auth = await import('../src/auth.ts');
  demo = await import('../src/demo.ts');
  ids.user = newId();
  seed.createUser(ids.user, process.env.NC_BOOTSTRAP_EMAIL!, 'Demo');
  const w = seed.createWorkspace(ids.user, 'Demo workspace');
  ids.space = w.space.id;
  auth.setPassword(ids.user, 'DemoPassword123!');
  ids.page = w.spaceView.private_pages[0];
});

describe('demo RPC refusals', () => {
  it('refuses identity, workspace, sharing, public, outbound, and session lockout actions', async () => {
    const names = [
      'changePassword', 'startTotpEnrollment', 'registerPasskey', 'addSecondaryEmail', 'deleteAccount', 'logoutOtherSessions',
      'inviteMembers', 'setSpaceDomain', 'deleteWorkspace', 'setMemberRole', 'resetInviteLink', 'requestMembers',
      'invitePagePermissions', 'getPublishedPage', 'getPublicForm', 'setSiteSettings', 'saveAutomation', 'runButtonServerSteps',
      'devCreateConnection', 'mcpCreateToken', 'restoreAgent', 'permanentlyDeleteAgent', 'setAgentPermissions', 'runAgent', 'stopAgentRun',
      'stopAllAgentRuns', 'agentRunFeedback', 'resolveAgentReview', 'resumeAgent', 'setAgentFavorite', 'setAgentCreditLimit', 'transferAgentOwnership',
      'adminJoinAgent', 'aiChat', 'aiFormula', 'aiGenerateImage', 'meetingSummarize', 'meetingUploadAudio',
    ];
    for (const name of names) expect(await status(() => call(ids.user, name))).toBe(403);
  });

  it('allows ordinary RPCs when demo mode is disabled', async () => {
    delete process.env.NC_DEMO_MODE;
    expect(await status(() => call(ids.user, 'checkSignInMethods', { email: process.env.NC_BOOTSTRAP_EMAIL }))).toBe(200);
    expect(await status(() => call(ids.user, 'changePassword', { password: 'DemoPassword456!', currentPassword: 'DemoPassword123!' }))).toBe(200);
    expect(await status(() => tx(ids.user, [{ pointer: { table: 'block', id: ids.page }, path: ['properties', 'title'], command: 'set', args: [['Normal mode']] }]))).toBe(200);
    process.env.NC_DEMO_MODE = '1';
  });

  it('refuses REST and MCP entry points', async () => {
    const rest = await app.request(new Request('http://localhost/v1/users/me', { headers: { authorization: 'Bearer lp_pat_test' } }));
    expect(rest.status).toBe(403);
    const mcp = await import('../src/ai/litMcp.ts');
    expect((await mcp.handleMcpHttp('Bearer lp_pat_test', { jsonrpc: '2.0', id: 1, method: 'initialize' })).status).toBe(403);
  });

  it('caps demo uploads at 5 MB', async () => {
    const token = auth.createSession(ids.user);
    const body = new Uint8Array(5 * 1024 * 1024 + 1);
    const res = await app.request(new Request('http://localhost/api/upload?name=large.bin', { method: 'POST', headers: { cookie: `lit_session=${token}`, 'content-type': 'application/octet-stream' }, body }));
    expect(res.status).toBe(413);
  });

  it('does not serve uploaded capability URLs anonymously', async () => {
    const res = await app.request(new Request('http://localhost/files/00000000-0000-4000-8000-000000000000/file.txt'));
    expect(res.status).toBe(403);
  });
});

describe('demo transaction refusals', () => {
  it('rejects profile, workspace settings, public permissions, and display preference writes', async () => {
    expect(await status(() => tx(ids.user, [{ pointer: { table: 'lit_user', id: ids.user }, path: ['name'], command: 'set', args: 'Changed' }]))).toBe(403);
    expect(await status(() => tx(ids.user, [{ pointer: { table: 'space', id: ids.space }, path: ['settings'], command: 'update', args: { allow_guests: false } }]))).toBe(403);
    expect(await status(() => tx(ids.user, [{ pointer: { table: 'block', id: ids.page }, path: ['permissions'], command: 'set', args: [{ type: 'public_permission', role: 'reader' }] }]))).toBe(403);
    const publicId = newId();
    expect(await status(() => tx(ids.user, [{ pointer: { table: 'block', id: publicId }, path: [], command: 'set', args: { id: publicId, type: 'page', parent_id: ids.space, parent_table: 'space', space_id: ids.space, alive: true, properties: { title: [['Public']] }, permissions: [{ type: 'public_permission', role: 'reader' }] } }]))).toBe(403);
    expect(await status(() => tx(ids.user, [{ pointer: { table: 'user_settings', id: ids.user }, path: ['settings'], command: 'update', args: { locale: 'ko-KR' } }]))).toBe(403);
    const newPageId = newId();
    expect(await status(() => tx(ids.user, [
      { pointer: { table: 'block', id: newPageId }, path: [], command: 'set', args: { id: newPageId, type: 'page', parent_id: ids.space, parent_table: 'space', space_id: ids.space, alive: true, properties: { title: [['New']] } } },
      { pointer: { table: 'block', id: newPageId }, path: ['permissions'], command: 'set', args: [{ type: 'public_permission', role: 'reader' }] },
    ]))).toBe(403);
    const formId = newId();
    expect(await status(() => tx(ids.user, [{ pointer: { table: 'collection_view', id: formId }, path: [], command: 'set', args: {
      id: formId, type: 'form', parent_id: ids.page, parent_table: 'block', space_id: ids.space, alive: true,
      format: { form_config: { permission: 'public' } },
    } }]))).toBe(403);
    const buttonId = newId();
    expect(await status(() => tx(ids.user, [{ pointer: { table: 'block', id: buttonId }, path: [], command: 'set', args: {
      id: buttonId, type: 'button', parent_id: ids.page, parent_table: 'block', space_id: ids.space, alive: true,
      format: { action: { webhook: 'https://example.test/hook' } },
    } }]))).toBe(403);
  });

  it('still permits ordinary page edits', async () => {
    expect(await status(() => tx(ids.user, [{ pointer: { table: 'block', id: ids.page }, path: ['properties', 'title'], command: 'set', args: [['Demo page']] }]))).toBe(200);
  });
});

describe('demo content and reset safety', () => {
  it('seeds the four requested templates once', () => {
    seed.seedDemoContent(ids.space, ids.user);
    const pages = db.recordsInSpace<any>('block', ids.space).filter((b) => b.parent_table === 'space' && b.alive !== false);
    const content = [...pages, ...db.recordsInSpace<any>('collection', ids.space)];
    for (const title of ['Roadmap', 'Projects', 'Meeting notes', 'Team wiki']) expect(content.some((p) => JSON.stringify(p).includes(title))).toBe(true);
    const count = pages.length;
    seed.seedDemoContent(ids.space, ids.user);
    expect(db.recordsInSpace<any>('block', ids.space).filter((b) => b.parent_table === 'space' && b.alive !== false).length).toBe(count);
    const roadmap = content.find((p) => JSON.stringify(p).includes('Roadmap'));
    expect(roadmap).toBeTruthy();
  });

  it('refuses an unset or suspicious reset directory and wipes a named data directory', () => {
    expect(demo.isSafeDemoDataDir(undefined)).toBe(false);
    expect(demo.isSafeDemoDataDir('/tmp')).toBe(false);
    const dir = mkdtempSync(join(tmpdir(), 'nc-demo-data-guard-'));
    writeFileSync(join(dir, 'stale.txt'), 'stale');
    expect(demo.wipeDemoDataDir(dir)).toBe(true);
    expect(existsSync(join(dir, 'stale.txt'))).toBe(false);
  });
});

describe('demo login rate limits', () => {
  it('does not apply the per-email failure bucket to the shared account', async () => {
    process.env.NC_DEMO_MODE = '1';
    for (let i = 0; i < 12; i++) expect(await status(() => call(null, 'signInWithEmail', { email: process.env.NC_BOOTSTRAP_EMAIL, password: 'wrong' }))).toBe(401);
    expect(await status(() => call(null, 'signInWithEmail', { email: process.env.NC_BOOTSTRAP_EMAIL, password: 'DemoPassword456!' }))).toBe(200);
  });

  it('keeps the normal per-email bucket outside demo mode', async () => {
    delete process.env.NC_DEMO_MODE;
    const email = 'normal-lock@example.test';
    const id = newId();
    seed.createUser(id, email, 'Normal');
    auth.setPassword(id, 'NormalPassword123!');
    for (let i = 0; i < 10; i++) expect(await status(() => call(null, 'signInWithEmail', { email, password: 'wrong' }))).toBe(401);
    expect(await status(() => call(null, 'signInWithEmail', { email, password: 'wrong' }))).toBe(429);
    process.env.NC_DEMO_MODE = '1';
  });
});
