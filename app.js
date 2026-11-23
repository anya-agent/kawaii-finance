#!/usr/bin/env bun
// @bun

// source/src/db.ts
import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
var DEFAULT_DB = "~/.kawaii-finance/finance.db";
var EXPENSE_CATEGORIES = ["\u5403\u996D", "\u4EA4\u901A", "\u8D2D\u7269", "\u8BA2\u9605", "\u5A31\u4E50", "\u65E5\u7528", "\u5176\u4ED6"];
var SCHEMA = `
CREATE TABLE IF NOT EXISTS txn (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT NOT NULL,           -- YYYY-MM-DD
  time       TEXT,                    -- HH:MM
  amount     REAL NOT NULL,           -- \u6B63\u6570\uFF08\u65B9\u5411\u7531 direction \u51B3\u5B9A\uFF09
  direction  TEXT NOT NULL DEFAULT 'out',  -- out=\u652F\u51FA / in=\u6536\u5165
  category   TEXT NOT NULL DEFAULT '\u5176\u4ED6',
  item       TEXT NOT NULL,           -- \u6761\u76EE\u63CF\u8FF0
  note       TEXT,
  source     TEXT DEFAULT 'manual',   -- manual | screenshot | import
  created_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_txn_date ON txn(date);
CREATE INDEX IF NOT EXISTS idx_txn_cat  ON txn(category);

CREATE TABLE IF NOT EXISTS account (
  name       TEXT PRIMARY KEY,        -- \u793A\u4F8B\u94F6\u884C / \u793A\u4F8B\u652F\u4ED8 / \u6512\u94B1\u7F50 / \u9EC4\u91D1 / \u503A\u57FA ...
  kind       TEXT NOT NULL,           -- cash | invest | reserve
  balance    REAL NOT NULL,           -- \u5F53\u524D\u4F59\u989D\uFF08\u5143\uFF09
  locked     REAL DEFAULT 0,          -- \u5176\u4E2D\u9501\u5B9A/\u4E0D\u53EF\u52A8\u90E8\u5206
  note       TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS account_snapshot (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT NOT NULL,
  account    TEXT NOT NULL,
  balance    REAL NOT NULL,
  created_at TEXT,
  UNIQUE(date, account)
);

CREATE INDEX IF NOT EXISTS idx_snap_date ON account_snapshot(date);

CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
function openDb(path = process.env.FINANCE_DB || DEFAULT_DB) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 3000;");
  db.exec(SCHEMA);
  return db;
}

// source/src/util.ts
var TZ = process.env.TZ || "Asia/Shanghai";
function today() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: TZ });
}
function nowHm() {
  return new Date().toLocaleTimeString("sv-SE", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
}
function shiftDays(date, delta) {
  const d = new Date(date + "T12:00:00");
  d.setDate(d.getDate() + delta);
  return d.toLocaleDateString("sv-SE", { timeZone: TZ });
}
function weekStart(date) {
  const d = new Date(date + "T12:00:00");
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toLocaleDateString("sv-SE", { timeZone: TZ });
}
function monthStart(date) {
  return date.slice(0, 7) + "-01";
}
function money(v) {
  if (v === null || Number.isNaN(v))
    return "\u2014";
  const s = v.toFixed(2);
  return s.endsWith(".00") ? s.slice(0, -3) : s;
}
function parseArgs(argv) {
  const positional = [];
  const opts = {};
  const isNegNumber = (s) => !!s && /^-\d/.test(s);
  for (let i = 0;i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-") && !isNegNumber(next))
        opts[key] = true;
      else {
        opts[key] = next;
        i++;
      }
    } else if (a.startsWith("-") && a.length === 2) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-") && !isNegNumber(next))
        opts[a.slice(1)] = true;
      else {
        opts[a.slice(1)] = next;
        i++;
      }
    } else
      positional.push(a);
  }
  return { positional, opts };
}
function str(v) {
  return typeof v === "string" ? v : undefined;
}
function num(v) {
  if (typeof v !== "string")
    return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function die(msg) {
  process.stderr.write(msg.endsWith(`
`) ? msg : msg + `
`);
  process.exit(1);
}

// source/src/account.ts
var ACCOUNT_KINDS = ["\u8D44\u91D1", "\u8D1F\u503A", "\u8D44\u4EA7"];
function ensureAccountSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS account_info (
      code       TEXT PRIMARY KEY,          -- \u77ED\u7801\uFF1ACARD-1234 / WALLET-A / BAI\u0422IAO
      name       TEXT NOT NULL,             -- \u5168\u540D\uFF1A\u793A\u4F8B\u4FE1\u7528\u5361
      kind       TEXT NOT NULL,             -- \u8D44\u91D1 | \u8D1F\u503A | \u8D44\u4EA7
      org        TEXT,                      -- \u673A\u6784\uFF1A\u793A\u4F8B\u94F6\u884C / \u793A\u4F8B\u652F\u4ED8 / \u793A\u4F8B\u5546\u57CE
      last4      TEXT,                      -- \u5361\u53F7\u540E\u56DB\u4F4D
      note       TEXT,
      active     INTEGER DEFAULT 1,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS balance_snapshot (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      date       TEXT NOT NULL,
      time       TEXT,
      account    TEXT NOT NULL,
      balance    REAL NOT NULL,             -- \u8D1F\u503A\u8BB0\u6B63\u6570\uFF08\u6B20\u591A\u5C11\uFF09\uFF0C\u7EDF\u8BA1\u65F6\u53D6\u8D1F
      note       TEXT,
      created_at TEXT,
      UNIQUE(date, account)
    );
    CREATE INDEX IF NOT EXISTS idx_snap_acc ON balance_snapshot(account, date);
  `);
  const cols = db.query("PRAGMA table_info(txn)").all().map((c) => c.name);
  if (!cols.includes("account"))
    db.exec("ALTER TABLE txn ADD COLUMN account TEXT");
  if (!cols.includes("to_account"))
    db.exec("ALTER TABLE txn ADD COLUMN to_account TEXT");
  const acols = db.query("PRAGMA table_info(account_info)").all().map((c) => c.name);
  if (!acols.includes("opening_balance"))
    db.exec("ALTER TABLE account_info ADD COLUMN opening_balance REAL DEFAULT 0");
  if (!acols.includes("opening_date"))
    db.exec("ALTER TABLE account_info ADD COLUMN opening_date TEXT");
}
function findAccount(db, code) {
  return db.query("SELECT * FROM account_info WHERE code = ?").get(code) ?? null;
}
function normCode(v) {
  return v.trim().toUpperCase();
}
function cmdAccountAdd(db, opts) {
  const codeRaw = str(opts.code);
  const name = str(opts.name);
  if (!codeRaw)
    die("--code \u5FC5\u586B\uFF08\u77ED\u7801\uFF0C\u5982 CARD-1234 / WALLET-A\uFF09");
  if (!name)
    die("--name \u5FC5\u586B\uFF08\u8D26\u6237\u5168\u540D\uFF09");
  const code = normCode(codeRaw);
  const kind = str(opts.kind) ?? "\u8D44\u91D1";
  if (!ACCOUNT_KINDS.includes(kind)) {
    die(`--kind \u5FC5\u987B\u662F\uFF1A${ACCOUNT_KINDS.join(" / ")}`);
  }
  db.query(`INSERT INTO account_info (code, name, kind, org, last4, note, active, opening_balance, opening_date, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT(code) DO UPDATE SET name=excluded.name, kind=excluded.kind,
       org=excluded.org, last4=excluded.last4, note=excluded.note, active=1`).run(code, name, kind, str(opts.org) ?? null, str(opts.last4) ?? null, str(opts.note) ?? null, num(opts.opening) ?? 0, today(), new Date().toISOString());
  process.stdout.write(`\u8D26\u6237\u5DF2\u5B58\uFF1A[${kind}] ${code} ${name}
`);
}
function cmdAccountList(db) {
  const rows = db.query("SELECT * FROM account_info WHERE active = 1 ORDER BY kind, code").all();
  if (!rows.length) {
    process.stdout.write(`\uFF08\u8FD8\u6CA1\u6709\u8D26\u6237\uFF0C\u7528 account add \u5EFA\uFF09
`);
    return;
  }
  for (const r of rows) {
    const b = accountBalance(db, r);
    const tag = b.live ? "\u5B9E\u65F6" : "\u5E02\u503C";
    const debtMark = r.kind === "\u8D1F\u503A" ? "\uFF08\u6B20\uFF09" : "";
    process.stdout.write(`${r.kind.padEnd(2, "\u3000")}  ${r.code.padEnd(14)} ${r.name.padEnd(16, "\u3000")}  ${tag} \xA5${money(b.balance)}${debtMark}
`);
  }
}
function ledgerNet(db, code) {
  const r = db.query(`SELECT COALESCE(SUM(CASE
          WHEN direction = 'in' THEN amount
          WHEN direction IN ('out','transfer') THEN -amount
          ELSE 0 END), 0) AS net
         FROM txn WHERE account = ?`).get(code);
  const inflow = db.query("SELECT COALESCE(SUM(amount), 0) AS s FROM txn WHERE to_account = ? AND direction = 'transfer'").get(code);
  return r.net + inflow.s;
}
function accountBalance(db, row) {
  if (row.kind === "\u8D44\u4EA7") {
    const s = latestSnapshot(db, row.code);
    return { balance: s?.balance ?? row.opening_balance ?? 0, date: s?.date ?? "-", live: false };
  }
  const base = row.opening_balance ?? 0;
  return { balance: base + ledgerNet(db, row.code), date: row.opening_date ?? "-", live: true };
}
function cmdAccountSnap(db, opts) {
  const codeRaw = str(opts.code);
  const bal = num(opts.balance);
  if (!codeRaw)
    die("--code \u5FC5\u586B");
  if (bal === null)
    die("--balance \u5FC5\u586B\uFF08\u8D1F\u503A\u8BB0\u6B63\u6570\uFF1D\u6B20\u591A\u5C11\uFF09");
  const code = normCode(codeRaw);
  const row = findAccount(db, code);
  if (!row)
    die(`\u8D26\u6237 ${code} \u4E0D\u5B58\u5728\uFF0C\u5148 account add`);
  const date = str(opts.date) ?? today();
  const time = str(opts.time) ?? nowHm();
  if (row.kind !== "\u8D44\u4EA7") {
    const net = ledgerNet(db, code);
    const old = row.opening_balance ?? 0;
    const next = bal - net;
    db.query("UPDATE account_info SET opening_balance = ?, opening_date = ? WHERE code = ?").run(next, date, code);
    const delta = next - old;
    const sign = delta >= 0 ? "+" : "";
    process.stdout.write(`\u5BF9\u8D26\u5B8C\u6210 ${code}\uFF1A\u5B9E\u65F6\u4F59\u989D \xA5${money(bal)}\uFF08\u671F\u521D \xA5${money(old)} \u2192 \xA5${money(next)}\uFF0C\u5DEE\u989D ${sign}\xA5${money(delta)}\uFF09
`);
    return;
  }
  db.query(`INSERT INTO balance_snapshot (date, time, account, balance, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(date, account) DO UPDATE SET balance=excluded.balance,
       time=excluded.time, note=excluded.note`).run(date, time, code, bal, str(opts.note) ?? null, new Date().toISOString());
  process.stdout.write(`\u5E02\u503C\u5FEB\u7167\u5DF2\u8BB0 ${date} ${code} \xA5${money(bal)}
`);
}
function latestSnapshot(db, code) {
  return db.query("SELECT * FROM balance_snapshot WHERE account = ? ORDER BY date DESC, id DESC LIMIT 1").get(code);
}
function netWorth(db) {
  const rows = db.query("SELECT * FROM account_info WHERE active = 1").all();
  const items = rows.map((r) => {
    const b = accountBalance(db, r);
    return { code: r.code, name: r.name, kind: r.kind, balance: b.balance, date: b.date, live: b.live };
  });
  const sum = (k) => items.filter((i) => i.kind === k).reduce((a, b) => a + b.balance, 0);
  const cash = sum("\u8D44\u91D1");
  const asset = sum("\u8D44\u4EA7");
  const debt = sum("\u8D1F\u503A");
  return { items, total: cash + asset - debt, cash, asset, debt };
}

// source/src/txn.ts
var CATEGORY_HINTS = [
  ["\u5403\u996D", ["\u996D", "\u98DF\u5802", "\u9762", "\u83DC", "\u9E21", "\u8089", "\u86CB", "\u5496\u5561", "\u5976\u8336", "\u745E\u5E78", "\u661F\u5DF4\u514B", "\u5916\u5356", "\u65E9\u9910", "\u5348\u9910", "\u665A\u9910", "\u6C34\u679C", "\u96F6\u98DF", "\u5DE7\u514B\u529B", "\u725B\u5976", "\u62C9\u9762", "\u9EBB\u8FA3", "\u706B\u9505", "\u9EA6\u5F53\u52B3", "\u80AF\u5FB7\u57FA", "\u65E9\u70B9", "\u5305\u5B50", "\u9992\u5934", "\u6D77\u82D4", "\u7FC5"]],
  ["\u4EA4\u901A", ["\u5730\u94C1", "\u516C\u4EA4", "\u6253\u8F66", "\u987A\u98CE\u8F66", "\u8F66\u8D39", "\u9AD8\u94C1", "\u706B\u8F66", "\u673A\u7968", "\u6CB9\u8D39", "\u505C\u8F66", "\u5171\u4EAB\u5355\u8F66", "\u6EF4\u6EF4", "\u9AD8\u5FB7"]],
  ["\u8BA2\u9605", ["\u8BA2\u9605", "\u4F1A\u5458", "vip", "\u4F1A\u5458\u8D39", "\u7EED\u8D39", "\u670D\u52A1\u5668", "vps", "\u57DF\u540D", "\u4E91", "github", "chatgpt", "claude", "api", "\u6D41\u91CF\u5361", "\u8BDD\u8D39"]],
  ["\u8D2D\u7269", ["\u4E70", "\u8863\u670D", "\u978B", "\u889C", "\u4E66", "\u6559\u6750", "\u8033\u673A", "\u6570\u7801", "\u5FEB\u9012", "\u7F51\u8D2D", "\u6DD8\u5B9D", "\u793A\u4F8B\u5546\u57CE", "\u62FC\u591A\u591A", "\u95F2\u9C7C"]],
  ["\u5A31\u4E50", ["\u6E38\u620F", "epic", "steam", "\u7535\u5F71", "\u6F14\u51FA", "\u673A\u5385", "maimai", "\u821E\u840C", "\u5531\u6B4C", "\u7968"]],
  ["\u65E5\u7528", ["\u7EB8", "\u6D17\u53D1", "\u6C90\u6D74", "\u7259\u818F", "\u7EB8\u5DFE", "\u6D17\u8863", "\u6C34\u7535", "\u7F51\u8D39", "\u5BBF\u820D", "\u7406\u53D1"]]
];
function guessCategory(item) {
  const s = item.toLowerCase();
  for (const [cat, words] of CATEGORY_HINTS) {
    if (words.some((w) => s.includes(w.toLowerCase())))
      return cat;
  }
  return "\u5176\u4ED6";
}
function isCategory(v) {
  return EXPENSE_CATEGORIES.includes(v);
}
function cmdTxnAdd(db, opts) {
  const amount = num(opts.amount);
  if (amount === null || amount <= 0)
    die("--amount \u5FC5\u987B\u662F\u6B63\u6570");
  const item = str(opts.item);
  if (!item)
    die("--item \u4E0D\u80FD\u4E3A\u7A7A\uFF08\u8BB0\u5F55\u7684\u662F\u4EC0\u4E48\uFF09");
  const date = str(opts.date) ?? today();
  const time = str(opts.time) ?? nowHm();
  const direction = str(opts.direction) === "in" || opts.income === true ? "in" : "out";
  const catRaw = str(opts.category);
  const category = catRaw && isCategory(catRaw) ? catRaw : guessCategory(item);
  const account = resolveAccount(db, str(opts.account));
  const toAccount = resolveAccount(db, str(opts.to));
  const res = db.query(`INSERT INTO txn (date, time, amount, direction, category, item, note, source, account, to_account, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(date, time, amount, direction, category, item, str(opts.note) ?? null, str(opts.source) ?? "manual", account, toAccount, new Date().toISOString());
  const id = res.lastInsertRowid;
  const arrow = direction === "in" ? "+" : "-";
  const acc = account ? `  <${account}>` : "";
  const to = toAccount ? ` \u2192 <${toAccount}>` : "";
  process.stdout.write(`\u5DF2\u8BB0\u5F55 #${id}  ${date} ${time}  ${arrow}\xA5${money(amount)}  [${category}] ${item}${acc}${to}
`);
}
function resolveAccount(db, raw) {
  if (!raw)
    return null;
  const code = normCode(raw);
  if (!findAccount(db, code)) {
    die(`\u8D26\u6237 ${code} \u4E0D\u5B58\u5728\u3002\u73B0\u6709\u8D26\u6237\uFF1Alist \u770B account list\uFF0C\u6216\u5148 account add --code ${code} --name ...`);
  }
  return code;
}
function cmdTxnTransfer(db, opts) {
  const amount = num(opts.amount);
  if (amount === null || amount <= 0)
    die("--amount \u5FC5\u987B\u662F\u6B63\u6570");
  const from = resolveAccount(db, str(opts.from));
  const to = resolveAccount(db, str(opts.to));
  if (!from || !to)
    die("transfer \u9700\u8981 --from <\u8D26\u6237> --to <\u8D26\u6237>");
  if (from === to)
    die("--from \u548C --to \u4E0D\u80FD\u662F\u540C\u4E00\u4E2A\u8D26\u6237");
  const date = str(opts.date) ?? today();
  const time = str(opts.time) ?? nowHm();
  const item = str(opts.item) ?? "\u5185\u90E8\u8F6C\u8D26";
  db.query(`INSERT INTO txn (date, time, amount, direction, category, item, note, source, account, to_account, created_at)
     VALUES (?, ?, ?, 'transfer', '\u5176\u4ED6', ?, ?, 'manual', ?, ?, ?)`).run(date, time, amount, item, str(opts.note) ?? null, from, to, new Date().toISOString());
  process.stdout.write(`\u5DF2\u8BB0\u5F55\u8F6C\u8D26 ${date} ${time}  \xA5${money(amount)}  ${from} \u2192 ${to}\uFF08\u4E0D\u8BA1\u5165\u652F\u51FA\uFF09
`);
}
function cmdTxnEdit(db, opts) {
  const id = num(opts.id);
  if (id === null)
    die("--id \u5FC5\u586B");
  const row = db.query("SELECT * FROM txn WHERE id = ?").get(id);
  if (!row)
    die(`#${id} \u4E0D\u5B58\u5728`);
  const sets = [];
  const vals = [];
  const put = (col, v) => {
    sets.push(`${col} = ?`);
    vals.push(v);
  };
  if (opts.amount !== undefined) {
    const a = num(opts.amount);
    if (a === null || a <= 0)
      die("--amount \u5FC5\u987B\u662F\u6B63\u6570");
    put("amount", a);
  }
  if (opts.item !== undefined)
    put("item", str(opts.item) ?? row.item);
  if (opts.category !== undefined) {
    const c = str(opts.category);
    if (!isCategory(c))
      die(`--category \u5FC5\u987B\u662F\uFF1A${EXPENSE_CATEGORIES.join(" / ")}`);
    put("category", c);
  }
  if (opts.date !== undefined)
    put("date", str(opts.date));
  if (opts.time !== undefined)
    put("time", str(opts.time));
  if (opts.note !== undefined)
    put("note", str(opts.note) ?? null);
  if (opts.direction !== undefined)
    put("direction", str(opts.direction) === "in" ? "in" : "out");
  if (opts.account !== undefined)
    put("account", resolveAccount(db, str(opts.account)));
  if (opts.to !== undefined)
    put("to_account", resolveAccount(db, str(opts.to)));
  if (!sets.length)
    die("\u6CA1\u6709\u8981\u6539\u7684\u5B57\u6BB5");
  vals.push(id);
  db.query(`UPDATE txn SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  process.stdout.write(`\u5DF2\u66F4\u65B0 #${id}
`);
}
function cmdTxnRm(db, opts) {
  const id = num(opts.id);
  if (id === null)
    die("--id \u5FC5\u586B");
  const r = db.query("DELETE FROM txn WHERE id = ?").run(id);
  if (!r.changes)
    die(`#${id} \u4E0D\u5B58\u5728`);
  process.stdout.write(`\u5DF2\u5220\u9664 #${id}
`);
}
function listTxns(db, opts) {
  const days = num(opts.days) ?? 7;
  const from = str(opts.since) ?? (() => {
    const d = new Date;
    d.setDate(d.getDate() - (days - 1));
    return d.toLocaleDateString("sv-SE", { timeZone: process.env.TZ || "Asia/Shanghai" });
  })();
  const where = ["date >= ?"];
  const params = [from];
  const cat = str(opts.category);
  if (cat) {
    where.push("category = ?");
    params.push(cat);
  }
  const dir = str(opts.direction);
  if (dir) {
    where.push("direction = ?");
    params.push(dir);
  }
  const rows = db.query(`SELECT * FROM txn WHERE ${where.join(" AND ")} ORDER BY date DESC, time DESC, id DESC`).all(...params);
  if (!rows.length) {
    process.stdout.write(`\uFF08\u65E0\u8BB0\u5F55\uFF09
`);
    return;
  }
  for (const r of rows) {
    const arrow = r.direction === "in" ? "+" : r.direction === "transfer" ? "\u2192" : "-";
    const note = r.note ? `  \xAB${r.note}\xBB` : "";
    const acc = r.account ? ` <${r.account}>` : "";
    const to = r.to_account ? ` \u2192<${r.to_account}>` : "";
    process.stdout.write(`#${String(r.id).padStart(3)}  ${r.date} ${r.time ?? "--:--"}  ${arrow}\xA5${money(r.amount).padStart(7)}  ${r.category.padEnd(3, "\u3000")}  ${r.item}${acc}${to}${note}
`);
  }
}

// source/src/brief.ts
function sumRange(db, from, to, direction = "out") {
  const r = db.query("SELECT COALESCE(SUM(amount), 0) AS s FROM txn WHERE date >= ? AND date <= ? AND direction = ?").get(from, to, direction);
  return r.s;
}
function catBreakdown(db, from, to) {
  return db.query(`SELECT category, SUM(amount) AS total, COUNT(*) AS count
         FROM txn WHERE date >= ? AND date <= ? AND direction = 'out'
        GROUP BY category ORDER BY total DESC`).all(from, to);
}
function getConfig(db, key) {
  const r = db.query("SELECT value FROM config WHERE key = ?").get(key);
  return r ? r.value : null;
}
function setConfig(db, key, value) {
  db.query("INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}
function buildBrief(db) {
  const d = today();
  const y = shiftDays(d, -1);
  const ws = weekStart(d);
  const ms = monthStart(d);
  const yRows = db.query("SELECT item, amount, category FROM txn WHERE date = ? AND direction = 'out' ORDER BY amount DESC").all(y);
  const yTotal = yRows.reduce((a, b) => a + b.amount, 0);
  const yIncome = sumRange(db, y, y, "in");
  const wSpent = sumRange(db, ws, d);
  const wIncome = sumRange(db, ws, d, "in");
  const budgetRaw = getConfig(db, "weekly_budget");
  const budget = budgetRaw ? Number(budgetRaw) : null;
  const daysLeft = 7 - (new Date(d + "T12:00:00").getDay() === 0 ? 7 : new Date(d + "T12:00:00").getDay());
  const mSpent = sumRange(db, ms, d);
  const dayOfMonth = Number(d.slice(8, 10));
  const dailyAvg = dayOfMonth > 0 ? mSpent / dayOfMonth : 0;
  const daysInMonth = new Date(Number(d.slice(0, 4)), Number(d.slice(5, 7)), 0).getDate();
  const projected = dailyAvg * daysInMonth;
  const anomalies = [];
  const wDailyAvg = wSpent / Math.max(1, dayOfMonth <= 7 ? dayOfMonth : 7);
  for (const r of yRows) {
    if (r.amount > Math.max(50, wDailyAvg * 2)) {
      anomalies.push(`\u5F02\u5E38\u652F\u51FA\uFF1A${r.item} \xA5${money(r.amount)}`);
    }
  }
  if (budget !== null && wSpent > budget) {
    anomalies.push(`\u672C\u5468\u5DF2\u8D85\u9884\u7B97 \xA5${money(wSpent - budget)}`);
  }
  return {
    date: d,
    yesterday: { date: y, total: yTotal, income: yIncome, rows: yRows },
    week: { start: ws, spent: wSpent, income: wIncome, budget, remaining: budget === null ? null : budget - wSpent, daysLeft },
    month: { start: ms, spent: mSpent, dailyAvg, daysElapsed: dayOfMonth, projected },
    byCategory: catBreakdown(db, ws, d),
    anomalies
  };
}
function renderBrief(b, dbForBrief) {
  const L = [];
  const yD = b.yesterday;
  L.push(`\uD83D\uDCCA \u7406\u8D22\u7B80\u62A5 ${b.date}`);
  L.push("");
  if (yD.rows.length === 0) {
    L.push(`\u6628\u5929\uFF08${yD.date}\uFF09\u6CA1\u6709\u652F\u51FA\u8BB0\u5F55`);
  } else {
    L.push(`\u6628\u5929\uFF08${yD.date}\uFF09\u652F\u51FA \xA5${money(yD.total)}`);
    for (const r of yD.rows.slice(0, 6)) {
      L.push(`  \xB7 ${r.item}  \xA5${money(r.amount)}  [${r.category}]`);
    }
    if (yD.rows.length > 6)
      L.push(`  \xB7 \u2026\u5171 ${yD.rows.length} \u7B14`);
    if (yD.income > 0)
      L.push(`  \u53E6\u6709\u6536\u5165 \xA5${money(yD.income)}`);
  }
  L.push("");
  const w = b.week;
  if (w.budget !== null) {
    const pct = Math.round(w.spent / w.budget * 100);
    const bar = "\u2588".repeat(Math.min(10, Math.round(pct / 10))) + "\u2591".repeat(Math.max(0, 10 - Math.round(pct / 10)));
    L.push(`\u672C\u5468 \xA5${money(w.spent)} / \u9884\u7B97 \xA5${money(w.budget)}  ${bar} ${pct}%`);
    if (w.remaining !== null && w.remaining >= 0) {
      L.push(`  \u8FD8\u80FD\u82B1 \xA5${money(w.remaining)}\uFF08\u5269 ${w.daysLeft} \u5929\uFF09`);
    } else {
      L.push(`  \u5DF2\u8D85 \xA5${money(-(w.remaining ?? 0))}`);
    }
  } else {
    L.push(`\u672C\u5468\u7D2F\u8BA1 \xA5${money(w.spent)}\uFF08\u672A\u8BBE\u9884\u7B97\uFF0C\u7528 \`bun app.js config set --weekly-budget 250\` \u8BBE\u7F6E\uFF09`);
  }
  L.push("");
  const m = b.month;
  L.push(`\u672C\u6708 \xA5${money(m.spent)}\uFF08\u65E5\u5747 \xA5${money(m.dailyAvg)}\uFF09`);
  L.push(`  \u6309\u6B64\u901F\u5EA6\u6708\u5E95\u7EA6 \xA5${money(m.projected)}`);
  if (b.byCategory.length) {
    const top = b.byCategory.slice(0, 4).map((c) => `${c.category} \xA5${money(c.total)}`).join(" \xB7 ");
    L.push(`  \u672C\u5468\u5206\u5E03\uFF1A${top}`);
  }
  const nw = netWorth(dbForBrief);
  if (nw.items.some((i) => i.balance !== 0)) {
    L.push("");
    L.push(`\uD83D\uDCB0 \u51C0\u8D44\u4EA7 \xA5${money(nw.total)}\uFF08\u8D44\u91D1 \xA5${money(nw.cash)} + \u8D44\u4EA7 \xA5${money(nw.asset)} \u2212 \u8D1F\u503A \xA5${money(nw.debt)}\uFF09`);
  }
  if (b.anomalies.length) {
    L.push("");
    L.push("\u26A0\uFE0F " + b.anomalies.join(`
\u26A0\uFE0F `));
  }
  return L.join(`
`);
}

// source/index.ts
var HELP = `kawaii-finance \u2014\u2014 \u968F\u624B\u8BB0\u8D26 + \u6BCF\u65E5\u7406\u8D22\u7B80\u62A5

\u8D26\u6237\uFF08\u5148\u5EFA\u8D26\u6237\uFF0C\u6D41\u6C34\u624D\u6709\u5F52\u5C5E\uFF09\uFF1A
  bun app.js account add --code CARD-1234 --name "\u793A\u4F8B\u4FE1\u7528\u5361" --kind \u8D44\u91D1 --org \u793A\u4F8B\u94F6\u884C --last4 1234
  bun app.js account add --code CREDIT --name "\u793A\u4F8B\u4FE1\u7528\u4ED8" --kind \u8D1F\u503A --org \u793A\u4F8B\u652F\u4ED8
  bun app.js account list
  bun app.js account snap --code CARD-1234 --balance 30 [--date 2026-11-22]   # \u4F59\u989D\u5FEB\u7167\uFF08\u8D1F\u503A\u8BB0\u6B63\u6570\uFF09
  bun app.js nw                                                             # \u51C0\u8D44\u4EA7\u6C47\u603B
  kind\uFF1A${ACCOUNT_KINDS.join(" / ")}

\u8BB0\u8D26\uFF08\u7C7B\u76EE\u80FD\u731C\u5C31\u731C\uFF0C\u4E0D\u7528\u624B\u52A8\u6307\u5B9A\uFF09\uFF1A
  bun app.js add --item "\u98DF\u5802\u5348\u9910" --amount 12.8 --account CREDIT [--category \u5403\u996D] [--time 12:30]
  bun app.js add --item "\u5DE5\u8D44" --amount 3000 --direction in --account CARD-5678
  bun app.js transfer --from WALLET-B --to CREDIT --amount 735.88   # \u8FD8\u6B3E/\u5145\u503C\uFF0C\u4E0D\u8BA1\u652F\u51FA
  bun app.js edit --id 12 [--amount 12] [--account CREDIT] [--note "\u5907\u6CE8"]
  bun app.js rm --id 12
  bun app.js list [--days 7] [--category \u5403\u996D] [--direction out]

\u7B80\u62A5\uFF08\u6BCF\u5929 8:30 \u63A8\u9001 / \u968F\u65F6\u67E5\u770B\uFF09\uFF1A
  bun app.js brief [--json]

\u9884\u7B97\uFF1A
  bun app.js config set --weekly-budget 250
  bun app.js config get

\u7C7B\u76EE\uFF1A${EXPENSE_CATEGORIES.join(" / ")}

\u73AF\u5883\u53D8\u91CF\uFF1AFINANCE_DB \u8986\u76D6\u6570\u636E\u5E93\u8DEF\u5F84\uFF08\u9ED8\u8BA4 ~/.kawaii-finance/finance.db\uFF09
`;
function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(HELP);
    return;
  }
  const { positional, opts } = parseArgs(argv);
  const [group, cmd] = positional;
  const db = openDb();
  ensureAccountSchema(db);
  if (group === "account" || group === "acc") {
    if (cmd === "add")
      return void cmdAccountAdd(db, opts);
    if (cmd === "list" || cmd === undefined)
      return void cmdAccountList(db);
    if (cmd === "snap" || cmd === "snapshot")
      return void cmdAccountSnap(db, opts);
    die(`\u672A\u77E5\u8D26\u6237\u5B50\u547D\u4EE4\uFF1A${cmd}\uFF08add / list / snap\uFF09`);
  }
  if (group === "nw" || group === "networth") {
    const n = netWorth(db);
    if (opts.json) {
      process.stdout.write(JSON.stringify(n, null, 2) + `
`);
      return;
    }
    const L = [`\uD83D\uDCB0 \u51C0\u8D44\u4EA7 \xA5${money(n.total)}`, ""];
    for (const i of n.items) {
      const tag = i.live ? "\u5B9E\u65F6" : "\u5E02\u503C";
      L.push(`  ${i.kind}  ${i.code.padEnd(14)} ${i.name}  \xA5${money(i.balance)}  ${tag}(${i.date})`);
    }
    L.push("");
    L.push(`\u8D44\u91D1 \xA5${money(n.cash)} + \u8D44\u4EA7 \xA5${money(n.asset)} \u2212 \u8D1F\u503A \xA5${money(n.debt)} = \xA5${money(n.total)}`);
    process.stdout.write(L.join(`
`) + `
`);
    return;
  }
  if (group === "transfer")
    return void cmdTxnTransfer(db, opts);
  if (group === "add" || group === "txn") {
    if (cmd === "add" || group === "add")
      return void cmdTxnAdd(db, opts);
    if (cmd === "list")
      return void listTxns(db, opts);
    if (cmd === "edit")
      return void cmdTxnEdit(db, opts);
    if (cmd === "rm" || cmd === "del")
      return void cmdTxnRm(db, opts);
    return void cmdTxnAdd(db, opts);
  }
  if (group === "list")
    return void listTxns(db, opts);
  if (group === "rm")
    return void cmdTxnRm(db, opts);
  if (group === "edit")
    return void cmdTxnEdit(db, opts);
  if (group === "brief" || group === "report") {
    const data = buildBrief(db);
    process.stdout.write(opts.json ? JSON.stringify(data, null, 2) + `
` : renderBrief(data, db) + `
`);
    return;
  }
  if (group === "config") {
    if (cmd === "set") {
      const wb = num(opts["weekly-budget"]);
      if (wb !== null) {
        setConfig(db, "weekly_budget", String(wb));
        process.stdout.write(`\u5468\u9884\u7B97\u5DF2\u8BBE\u4E3A \xA5${money(wb)}
`);
        return;
      }
      die("\u7528\u6CD5\uFF1Aconfig set --weekly-budget 250");
    }
    if (cmd === "get" || cmd === undefined) {
      const wb = getConfig(db, "weekly_budget");
      process.stdout.write(`\u5468\u9884\u7B97\uFF1A${wb ? "\xA5" + money(Number(wb)) : "\u672A\u8BBE\u7F6E"}
`);
      return;
    }
  }
  die(`\u672A\u77E5\u547D\u4EE4\uFF1A${positional.join(" ")}\uFF08--help \u67E5\u770B\u7528\u6CD5\uFF09`);
}
main();
