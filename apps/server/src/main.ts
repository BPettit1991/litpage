// Server entry: serves the HTTP app (app.ts) and attaches the WebSocket hub (realtime.ts).
import { serve } from '@hono/node-server';
import { userFromRequest } from './auth.ts';
import { app, originAllowed } from './app.ts';
import { realtime } from './realtime.ts';
import { startScheduler } from './scheduler.ts';
import { bootstrapOwner } from './bootstrap.ts';

bootstrapOwner();
const port = Number(process.env.PORT ?? 3001);
const server = serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? '127.0.0.1' }, (info) => {
  console.log(`[server] listening on http://${info.address}:${info.port}`);
});
realtime.attach(server as any, (req) => {
  // cross-site WebSocket hijacking: the browser sends the session cookie with same-site pages on other ports too
  const fwdHost = process.env.NC_TRUST_PROXY === '1' ? (req.headers['x-forwarded-host'] as string | undefined) : undefined;
  if (!originAllowed(req.headers.origin, req.headers.host, fwdHost)) return null;
  return userFromRequest(req);
});
// reminders, notification emails, digests (scheduler.ts; jobs persist in SQLite)
startScheduler();
