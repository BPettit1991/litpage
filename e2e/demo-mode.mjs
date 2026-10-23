// Public demo mode (NC_DEMO_MODE=1) against a server started with the shared bootstrap account:
//   NC_DEMO_MODE=1 NC_BOOTSTRAP_EMAIL=demo@example.com NC_BOOTSTRAP_PASSWORD=litpage-demo … node apps/server/src/main.ts
//   NC_BASE=<web url> DEMO_EMAIL=demo@example.com DEMO_PASSWORD=litpage-demo node e2e/demo-mode.mjs
// Covers: password sign-in, the notice bar, sample pages, refusals for account / workspace / sharing / outbound /
// programmatic actions (RPC and transaction paths, REST and MCP), the message in the UI, browser-only language,
// ordinary editing, the 5 MB upload cap, no shared-account lockout after wrong passwords, no anonymous file downloads.
import { chromium } from 'playwright-core';
import { BASE, CHROME } from './lib.mjs';

const EMAIL = process.env.DEMO_EMAIL ?? 'demo@example.com';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'litpage-demo';
let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` | ${String(detail).slice(0, 200)}`}`);
};

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const newContext = () => browser.newContext({ viewport: { width: 1384, height: 853 }, locale: 'en-US' });

async function signIn(page, password = PASSWORD) {
  await page.goto(`${BASE}/`);
  await page.waitForURL(/\/login/);
  await page.fill('#email', EMAIL);
  await page.click('button[type=submit]');
  await page.getByText('Continue with a password').first().click();
  await page.fill('input[type=password]', password);
  await page.click('button[type=submit]');
}
const rpc = (page, name, body = {}) => page.evaluate(async ([n, b]) => {
  const r = await fetch(`/api/rpc/${n}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}, [name, body]);

// ---- wrong passwords must not lock the shared account
{
  const ctx = await newContext();
  const page = await ctx.newPage();
  let statuses = [];
  await page.goto(`${BASE}/`);
  for (let i = 0; i < 12; i++) {
    statuses.push((await rpc(page, 'signInWithEmail', { email: EMAIL, password: `wrong-${i}` })).status);
  }
  check('12 wrong passwords never answer 429 for the shared account', !statuses.includes(429), statuses.join(','));
  await ctx.close();
}

const ctx = await newContext();
const page = await ctx.newPage();
await signIn(page);
await page.waitForSelector('nav.lit-sidebar-container', { timeout: 30000 });
check('signs in with the published password', true);
const notice = await page.locator('.lp-demo-notice').innerText().catch(() => '');
check('notice bar warns about the shared account and personal information', /Public demo/.test(notice) && /personal information/.test(notice), notice);
const sidebar = await page.locator('nav.lit-sidebar-container').innerText();
check('sample pages are in the sidebar', ['Roadmap', 'Projects', 'Meeting notes', 'Team wiki'].every((t) => sidebar.includes(t)), sidebar.slice(0, 300));

// ---- refused RPCs (403 with the demo message)
const spaceId = await page.evaluate(() => window.__ncEditor.records.all('space')[0]?.id);
const userId = await page.evaluate(() => window.__ncEditor.records.all('lit_user')[0]?.id);
const REFUSED = [
  ['changePassword', { password: 'another-password-123', currentPassword: PASSWORD }],
  ['removePassword', {}],
  ['startTotpEnrollment', {}],
  ['passkeyRegistrationOptions', {}],
  ['addSecondaryEmail', { email: 'someone@example.com' }],
  ['deleteAccount', {}],
  ['logoutOtherSessions', {}],
  ['deleteWorkspace', { spaceId, confirmName: 'x' }],
  ['leaveSpace', { spaceId }],
  ['setSpaceDomain', { spaceId, domain: 'taken-over' }],
  ['setMemberRole', { spaceId, userId, role: 'reader' }],
  ['inviteMembers', { spaceId, emails: ['someone@example.com'] }],
  ['setInviteLinkEnabled', { spaceId, enabled: true }],
  ['setAllowedEmailDomains', { spaceId, domains: ['example.com'] }],
  ['mcpCreateToken', { spaceId, name: 'x' }],
  ['devCreateConnection', { spaceId, name: 'x' }],
  ['setSiteSettings', { spaceId }],
  ['createWorkspace', { name: 'Another' }],
];
for (const [name, body] of REFUSED) {
  const r = await rpc(page, name, body);
  check(`refuses ${name}`, r.status === 403 && /public demo/i.test(r.body?.message ?? ''), `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
}

// ---- transaction path: public sharing and account identity
const pageId = await page.evaluate(() => window.__ncEditor.records.all('block').find((b) => b.type === 'page' && b.alive !== false)?.id);
const tx = (operations) => rpc(page, 'applyChanges', { transactions: [{ id: crypto.randomUUID(), spaceId, operations }] });
const pub = await tx([{ pointer: { table: 'block', id: pageId, spaceId }, path: ['permissions'], command: 'set', args: [{ type: 'public_permission', role: 'reader' }] }]);
check('transaction cannot make a page public', pub.status >= 400, `${pub.status} ${JSON.stringify(pub.body).slice(0, 120)}`);
const rename = await tx([{ pointer: { table: 'lit_user', id: userId }, path: ['name'], command: 'set', args: 'Taken over' }]);
check('transaction cannot rename the shared account', rename.status >= 400, `${rename.status}`);
const edit = await tx([{ pointer: { table: 'block', id: pageId, spaceId }, path: ['properties', 'title'], command: 'set', args: [['Demo edit works']] }]);
check('ordinary page edits still save', edit.status === 200, `${edit.status} ${JSON.stringify(edit.body).slice(0, 120)}`);

// ---- the UI shows the refusal
await page.keyboard.press('Meta+Comma');
await page.waitForTimeout(1200);
const changeBtn = page.locator('.nc-set-row[data-setting="password"] .nc-set-btn', { hasText: 'Change password' }).first();
if (await changeBtn.count()) {
  await changeBtn.click();
  const sub = '.nc-set-subdialog';
  await page.waitForSelector(sub);
  const inputs = page.locator(`${sub} input[type=password]`);
  const n = await inputs.count();
  for (let i = 0; i < n; i++) await inputs.nth(i).fill(i === 0 && n > 2 ? PASSWORD : 'another-password-123');
  await page.click(`${sub} button[type=submit]`);
  await page.waitForTimeout(1200);
  const body = await page.locator('body').innerText();
  check('changing the password in Settings shows the demo message', /public demo/i.test(body), body.slice(0, 200));
} else check('Settings › Password › Change password is present', false, 'no Change password button');
await page.keyboard.press('Escape');
await page.keyboard.press('Escape');

// ---- language stays in this browser
await page.evaluate(() => localStorage.setItem('nc:demo-pref:locale', JSON.stringify('ko-KR')));
await page.reload();
await page.waitForSelector('nav.lit-sidebar-container', { timeout: 30000 });
const koHere = await page.locator('nav.lit-sidebar-container').innerText();
const other = await newContext();
const page2 = await other.newPage();
await signIn(page2);
await page2.waitForSelector('nav.lit-sidebar-container', { timeout: 30000 });
const enThere = await page2.locator('nav.lit-sidebar-container').innerText();
check('a visitor can switch to Korean in their browser', /홈|새 채팅|라이브러리/.test(koHere), koHere.slice(0, 120));
check('another visitor still sees English', /Home|New chat|Library/.test(enThere) && !/라이브러리/.test(enThere), enThere.slice(0, 120));

// ---- uploads: 1 MB ok, 6 MB refused; files are not served anonymously
const up = (bytes) => page.evaluate(async ([n, s]) => {
  const r = await fetch(`/api/upload?name=f.bin&type=application/octet-stream&spaceId=${s}`, { method: 'POST', body: new Uint8Array(n) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}, [bytes, spaceId]);
const small = await up(1024 * 1024);
check('1 MB upload is accepted', small.status === 200, `${small.status}`);
const big = await up(6 * 1024 * 1024);
check('6 MB upload is refused', big.status === 413, `${big.status}`);
if (small.body?.url) {
  const anon = await fetch(new URL(small.body.url, BASE));
  check('uploaded files are not served without signing in', anon.status === 403, `${anon.status}`);
}

// ---- REST API and MCP endpoint
const rest = await fetch(new URL('/v1/users/me', BASE), { headers: { authorization: 'Bearer lp_int_x' } });
check('REST API is closed', rest.status === 403, `${rest.status}`);
const mcp = await fetch(new URL('/api/mcp', BASE), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) });
check('MCP endpoint is closed', mcp.status === 403, `${mcp.status}`);

// ---- the account still works for the next visitor
const ctx3 = await newContext();
const page3 = await ctx3.newPage();
await signIn(page3);
await page3.waitForSelector('nav.lit-sidebar-container', { timeout: 30000 }).then(() => check('the next visitor can still sign in', true), (e) => check('the next visitor can still sign in', false, e.message));

await browser.close();
console.log(`demo-mode: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
