import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";

const SCHEMA = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS mandates (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  name TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  per_tx_cap_cents INTEGER NOT NULL,
  daily_cap_cents INTEGER NOT NULL,
  approval_threshold_cents INTEGER NOT NULL,
  velocity_per_hour INTEGER NOT NULL DEFAULT 20,
  merchant_allowlist TEXT NOT NULL DEFAULT '[]',
  category_allowlist TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS intents (
  id TEXT PRIMARY KEY,
  mandate_id TEXT,
  agent_id TEXT NOT NULL,
  merchant TEXT NOT NULL,
  category TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  reason_code TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  order_id TEXT,
  capture_id TEXT,
  approval_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  raw TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  subject TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
`;

const now = () => new Date().toISOString();
const plain = (row) => (row ? { ...row } : row);

export function openDatabase(path = "mandate.db") {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

export function appendAudit(db, { actor, action, subject, detail = {} }) {
  const prev = plain(db.prepare("SELECT hash FROM audit ORDER BY id DESC LIMIT 1").get());
  const prevHash = prev?.hash ?? "GENESIS";
  const ts = now();
  const payload = JSON.stringify({ ts, actor, action, subject, detail });
  const hash = createHash("sha256").update(prevHash + payload).digest("hex");
  db.prepare(
    "INSERT INTO audit (ts, actor, action, subject, detail, prev_hash, hash) VALUES (?,?,?,?,?,?,?)"
  ).run(ts, actor, action, subject, JSON.stringify(detail), prevHash, hash);
  return hash;
}

export function verifyAuditChain(db) {
  const rows = db.prepare("SELECT * FROM audit ORDER BY id ASC").all().map(plain);
  let prevHash = "GENESIS";
  for (const row of rows) {
    const payload = JSON.stringify({
      ts: row.ts,
      actor: row.actor,
      action: row.action,
      subject: row.subject,
      detail: JSON.parse(row.detail),
    });
    const expected = createHash("sha256").update(prevHash + payload).digest("hex");
    if (row.prev_hash !== prevHash || row.hash !== expected) {
      return { ok: false, brokenAt: row.id };
    }
    prevHash = row.hash;
  }
  return { ok: true, length: rows.length };
}

export function createMandate(db, input) {
  const id = input.id ?? `man_${randomUUID()}`;
  db.prepare(
    `INSERT INTO mandates (id, agent_id, name, currency, per_tx_cap_cents, daily_cap_cents,
      approval_threshold_cents, velocity_per_hour, merchant_allowlist, category_allowlist, active, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    input.agent_id,
    input.name,
    input.currency ?? "USD",
    input.per_tx_cap_cents,
    input.daily_cap_cents,
    input.approval_threshold_cents,
    input.velocity_per_hour ?? 20,
    JSON.stringify(input.merchant_allowlist ?? []),
    JSON.stringify(input.category_allowlist ?? []),
    input.active === false ? 0 : 1,
    now()
  );
  appendAudit(db, {
    actor: "owner",
    action: "mandate.created",
    subject: id,
    detail: { agent_id: input.agent_id, per_tx_cap_cents: input.per_tx_cap_cents },
  });
  return getMandate(db, id);
}

export function getMandate(db, id) {
  const row = plain(db.prepare("SELECT * FROM mandates WHERE id = ?").get(id));
  return row ? hydrateMandate(row) : null;
}

export function findMandateForAgent(db, agentId) {
  const row = plain(
    db
      .prepare("SELECT * FROM mandates WHERE agent_id = ? AND active = 1 ORDER BY created_at DESC LIMIT 1")
      .get(agentId)
  );
  return row ? hydrateMandate(row) : null;
}

export function listMandates(db) {
  return db.prepare("SELECT * FROM mandates ORDER BY created_at DESC").all().map(plain).map(hydrateMandate);
}

function hydrateMandate(row) {
  return {
    ...row,
    active: Boolean(row.active),
    merchant_allowlist: JSON.parse(row.merchant_allowlist),
    category_allowlist: JSON.parse(row.category_allowlist),
  };
}

export function spentTodayCents(db, agentId, day = new Date().toISOString().slice(0, 10)) {
  const row = plain(
    db
      .prepare(
        `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM intents
         WHERE agent_id = ? AND status IN ('captured','settled') AND substr(created_at,1,10) = ?`
      )
      .get(agentId, day)
  );
  return Number(row?.total ?? 0);
}

export function intentsLastHour(db, agentId) {
  const cutoff = new Date(Date.now() - 3600_000).toISOString();
  const row = plain(
    db.prepare("SELECT COUNT(*) AS n FROM intents WHERE agent_id = ? AND created_at >= ?").get(agentId, cutoff)
  );
  return Number(row?.n ?? 0);
}

export function createIntent(db, data) {
  const id = data.id ?? `int_${randomUUID()}`;
  const ts = now();
  db.prepare(
    `INSERT INTO intents (id, mandate_id, agent_id, merchant, category, amount_cents, currency,
      description, status, reason_code, reason, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    data.mandate_id ?? null,
    data.agent_id,
    data.merchant,
    data.category,
    data.amount_cents,
    data.currency ?? "USD",
    data.description ?? "",
    data.status,
    data.reason_code ?? "",
    data.reason ?? "",
    ts,
    ts
  );
  return getIntent(db, id);
}

export function getIntent(db, id) {
  return plain(db.prepare("SELECT * FROM intents WHERE id = ?").get(id));
}

export function updateIntent(db, id, patch) {
  const current = getIntent(db, id);
  if (!current) return null;
  const next = { ...current, ...patch, updated_at: now() };
  db.prepare(
    `UPDATE intents SET status=?, reason_code=?, reason=?, order_id=?, capture_id=?, approval_id=?,
      mandate_id=?, updated_at=? WHERE id=?`
  ).run(
    next.status,
    next.reason_code,
    next.reason,
    next.order_id,
    next.capture_id,
    next.approval_id,
    next.mandate_id,
    next.updated_at,
    id
  );
  return getIntent(db, id);
}

export function listIntents(db, limit = 200) {
  return db.prepare("SELECT * FROM intents ORDER BY created_at DESC LIMIT ?").all(limit).map(plain);
}

export function addTransaction(db, tx) {
  const id = tx.id ?? `txn_${randomUUID()}`;
  db.prepare(
    `INSERT INTO transactions (id, intent_id, kind, provider_id, amount_cents, currency, status, raw, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    tx.intent_id,
    tx.kind,
    tx.provider_id,
    tx.amount_cents,
    tx.currency,
    tx.status,
    JSON.stringify(tx.raw ?? {}),
    now()
  );
  return plain(db.prepare("SELECT * FROM transactions WHERE id = ?").get(id));
}

export function listTransactions(db, limit = 200) {
  return db.prepare("SELECT * FROM transactions ORDER BY created_at DESC LIMIT ?").all(limit).map(plain);
}

export function listAudit(db, limit = 200) {
  return db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT ?").all(limit).map(plain);
}

export { now };
