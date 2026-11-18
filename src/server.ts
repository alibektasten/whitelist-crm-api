import { openDatabase } from './db/database.ts';
import { createApp } from './http/app.ts';

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535.');
const host = process.env.HOST ?? '127.0.0.1';
const db = openDatabase(process.env.DATABASE_PATH ?? './data/crm.sqlite');
const server = createApp(db);
server.on('error', error => {
  console.error(error);
  db.close();
  process.exitCode = 1;
});
server.listen(port, host, () => console.log(`CRM API is listening on http://${host}:${port}`));

let stopping = false;
function shutdown(): void {
  if (stopping) return;
  stopping = true;
  server.close(() => { db.close(); });
  // Do not let a stalled client keep shutdown open forever.
  const deadline = setTimeout(() => server.closeAllConnections(), 5_000);
  deadline.unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
