// Stages everything the desktop app ships next to Electron, under desktop/build:
//
//   build/server/apps/server/dist/main.mjs   the API server as one file (esbuild)
//   build/server/apps/web/dist/              the built web app (the server serves it from ../../web/dist)
//   build/runtime/node.exe                   Node.js for the server (only with --runtime win-x64)
//   build/licenses/                          license texts for the above
//
// The server needs Node 26 (node:sqlite, TypeScript sources); Electron ships an older Node, so the packaged app
// runs the server with its own node.exe. Without --runtime (local development) the shell uses the `node` on PATH.
//
// Usage: node scripts/bundle.mjs [--runtime win-x64] [--skip-web]
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';

const desktop = resolve(import.meta.dirname, '..');
const repo = resolve(desktop, '..');
const out = join(desktop, 'build');
const serverSrc = join(repo, 'apps/server/src');
const webDist = join(repo, 'apps/web/dist');

const args = process.argv.slice(2);
const runtime = args.includes('--runtime') ? args[args.indexOf('--runtime') + 1] : null;
const skipWeb = args.includes('--skip-web');

if (!existsSync(join(repo, 'apps/server/node_modules'))) {
  console.error('Dependencies are missing. Run `pnpm install` in the repository root first.');
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });

// ---------------------------------------------------------------- web app
if (!skipWeb || !existsSync(webDist)) {
  console.log('[bundle] building the web app');
  const r = spawnSync('pnpm', ['--filter', '@nc/web', 'build'], { cwd: repo, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
// source maps are for debugging in a browser; they would double the installer size
cpSync(webDist, join(out, 'server/apps/web/dist'), { recursive: true, filter: (src) => !src.endsWith('.map') });

// ---------------------------------------------------------------- server
// api/extra.ts discovers its endpoint modules by listing a folder at run time, which cannot work inside one bundled
// file. The same list is resolved here, at build time, into static imports.
const modulesDir = join(serverSrc, 'api/modules');
const moduleFiles = readdirSync(modulesDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).sort();
const staticModules = {
  name: 'litpage-static-api-modules',
  setup(b) {
    b.onLoad({ filter: /[\\/]api[\\/]extra\.ts$/ }, () => ({
      loader: 'ts',
      resolveDir: join(serverSrc, 'api'),
      contents: [
        ...moduleFiles.map((f, i) => `import * as m${i} from './modules/${f}';`),
        'export const extraHandlers: Record<string, any> = {};',
        ...moduleFiles.map((_, i) => `Object.assign(extraHandlers, (m${i} as any).handlers ?? {});`),
      ].join('\n'),
    }));
  },
};

console.log(`[bundle] bundling the server (${moduleFiles.length} endpoint modules)`);
const serverOut = join(out, 'server/apps/server/dist/main.mjs');
await build({
  entryPoints: [join(desktop, 'src/server-entry.ts')],
  outfile: serverOut,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node26',
  legalComments: 'none',
  logLevel: 'warning',
  plugins: [staticModules],
  // CommonJS dependencies (ws) call require() for Node built-ins; an ES module has none unless it is created
  banner: { js: "import { createRequire as __litCreateRequire } from 'node:module';\nconst require = __litCreateRequire(import.meta.url);" },
});
if (/readdirSync\([^)]*modules/.test(readFileSync(serverOut, 'utf8'))) {
  console.error('[bundle] api/extra.ts was not replaced; the bundled server would not find its endpoint modules.');
  process.exit(1);
}

// ---------------------------------------------------------------- licenses
const licenses = join(out, 'licenses');
mkdirSync(licenses, { recursive: true });
cpSync(join(repo, 'LICENSE'), join(licenses, 'LICENSE.txt'));
cpSync(join(repo, 'THIRD_PARTY_NOTICES.md'), join(licenses, 'THIRD_PARTY_NOTICES.md'));

// ---------------------------------------------------------------- Node.js runtime
if (runtime) {
  const pin = JSON.parse(readFileSync(join(desktop, 'node-runtime.json'), 'utf8'));
  const expected = pin.sha256[runtime];
  if (!expected) {
    console.error(`[bundle] no checksum for ${runtime} in node-runtime.json`);
    process.exit(1);
  }
  const download = async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  };
  console.log(`[bundle] downloading Node.js ${pin.version} (${runtime})`);
  const exe = await download(`https://nodejs.org/dist/v${pin.version}/${runtime}/node.exe`);
  const actual = createHash('sha256').update(exe).digest('hex');
  if (actual !== expected) {
    console.error(`[bundle] node.exe checksum mismatch\n  expected ${expected}\n  actual   ${actual}`);
    process.exit(1);
  }
  mkdirSync(join(out, 'runtime'), { recursive: true });
  writeFileSync(join(out, 'runtime/node.exe'), exe);
  writeFileSync(join(licenses, 'NODEJS-LICENSE.txt'), await download(`https://raw.githubusercontent.com/nodejs/node/v${pin.version}/LICENSE`));
} else {
  // electron-builder copies this folder; keep it present so a build without a runtime fails loudly later, not here
  mkdirSync(join(out, 'runtime'), { recursive: true });
}

console.log(`[bundle] done: ${dirname(serverOut)}`);
