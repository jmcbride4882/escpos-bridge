/**
 * Forwarder — POSTs parsed events to Hetzner with a SQLite-backed retry queue.
 *
 * On success: discard.
 * On failure: enqueue with exponential backoff, sweep every 30s.
 * On 7+ days old: drop with a loud log so disk doesn't fill.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

let db = null;

function initDb() {
  if (db) return db;
  mkdirSync(dirname(config.retry.dbPath), { recursive: true });
  db = new Database(config.retry.dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      kind        TEXT NOT NULL,        -- 'receipt' | 'kp'
      url         TEXT NOT NULL,
      payload     TEXT NOT NULL,        -- JSON string
      created_at  INTEGER NOT NULL,     -- epoch ms
      attempts    INTEGER NOT NULL DEFAULT 0,
      last_error  TEXT,
      last_attempt INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_pending_age ON pending(created_at);
  `);
  return db;
}

async function postOnce(url, payload) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), config.hetzner.timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Interceptor-Secret': config.hetzner.secret,
        'X-Device-Id': config.device.deviceId,
        'X-Venue': config.device.venue,
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return true;
  } finally {
    clearTimeout(t);
  }
}

/** Best-effort: try immediately; on failure enqueue for later. */
export async function send(kind, payload) {
  const url = kind === 'receipt' ? config.hetzner.receiptUrl : config.hetzner.kpUrl;
  try {
    await postOnce(url, payload);
    if (config.logLevel !== 'error') console.log(`[forward] ${kind} sent OK`);
    return;
  } catch (err) {
    console.error(`[forward] ${kind} immediate send failed (${err.message}) — queuing`);
    initDb().prepare(
      `INSERT INTO pending (kind, url, payload, created_at, last_error)
       VALUES (?, ?, ?, ?, ?)`
    ).run(kind, url, JSON.stringify(payload), Date.now(), err.message);
  }
}

/** Sweep — replay queued items. Called by setInterval. */
export async function sweep() {
  const d = initDb();
  const cutoff = Date.now() - config.retry.maxAgeHours * 60 * 60 * 1000;
  // Drop ancient
  const dropped = d.prepare('DELETE FROM pending WHERE created_at < ?').run(cutoff);
  if (dropped.changes) console.error(`[forward] dropped ${dropped.changes} rows older than ${config.retry.maxAgeHours}h`);

  const rows = d.prepare('SELECT * FROM pending ORDER BY id LIMIT 50').all();
  if (!rows.length) return;
  let ok = 0, fail = 0;
  for (const row of rows) {
    // exponential backoff: 0s, 30s, 2m, 8m, 32m...
    const since = row.last_attempt ? Date.now() - row.last_attempt : Infinity;
    const wait = Math.min(30 * 1000 * Math.pow(4, row.attempts), 60 * 60 * 1000);
    if (since < wait) continue;
    try {
      await postOnce(row.url, JSON.parse(row.payload));
      d.prepare('DELETE FROM pending WHERE id = ?').run(row.id);
      ok++;
    } catch (err) {
      d.prepare('UPDATE pending SET attempts = attempts + 1, last_error = ?, last_attempt = ? WHERE id = ?')
        .run(err.message, Date.now(), row.id);
      fail++;
    }
  }
  if (ok || fail) console.log(`[forward] sweep: ${ok} replayed, ${fail} failed, ${rows.length - ok - fail} pending`);
}

let sweepTimer = null;
export function startSweepTimer() {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => sweep().catch(err => console.error('[forward] sweep error:', err)),
                            config.retry.sweepEveryMs);
  console.log(`[forward] sweep timer started (every ${config.retry.sweepEveryMs / 1000}s)`);
}

export function getQueueDepth() {
  return initDb().prepare('SELECT COUNT(*) AS n FROM pending').get().n;
}
