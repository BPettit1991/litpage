// Entry of the bundled server (scripts/bundle.mjs). The desktop shell starts it with a pipe on stdin and never
// writes to it: when the pipe closes, the shell has quit or crashed, and the server must not stay behind holding
// the port and the database.
try {
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('error', () => process.exit(0));
  process.stdin.resume();
} catch {
  // started by hand without a usable stdin (Node throws on access): run without the watchdog
}

await import('../../apps/server/src/main.ts');
