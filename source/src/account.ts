/** 账户：资金 / 负债 / 资产 + 余额快照
 *  记账时用 --account <code> 指向某个账户，账户本身只存元数据，余额靠快照追。
 */
import type { Database } from "bun:sqlite";
import { die, money, num, str, today, nowHm } from "./util.ts";

export const ACCOUNT_KINDS = ["资金", "负债", "资产"] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export interface AccountRow {
  code: string;
  name: string;
  kind: string;
  org: string | null;
  last4: string | null;
  note: string | null;
  active: number;
  opening_balance: number | null;
  opening_date: string | null;
  created_at: string | null;
}

/** 建表（幂等）——老库升级时也会跑一遍 */
export function ensureAccountSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS account_info (
      code       TEXT PRIMARY KEY,          -- 短码：CARD-1234 / WALLET-A / BAIТIAO
      name       TEXT NOT NULL,             -- 全名：示例信用卡
      kind       TEXT NOT NULL,             -- 资金 | 负债 | 资产
      org        TEXT,                      -- 机构：示例银行 / 示例支付 / 示例商城
      last4      TEXT,                      -- 卡号后四位
      note       TEXT,
      active     INTEGER DEFAULT 1,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS balance_snapshot (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      date       TEXT NOT NULL,
      time       TEXT,
      account    TEXT NOT NULL,
      balance    REAL NOT NULL,             -- 负债记正数（欠多少），统计时取负
      note       TEXT,
      created_at TEXT,
      UNIQUE(date, account)
    );
    CREATE INDEX IF NOT EXISTS idx_snap_acc ON balance_snapshot(account, date);
  `);
  // 老库补列：txn.account / txn.to_account
  const cols = (db.query("PRAGMA table_info(txn)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("account")) db.exec("ALTER TABLE txn ADD COLUMN account TEXT");
  if (!cols.includes("to_account")) db.exec("ALTER TABLE txn ADD COLUMN to_account TEXT");

  // 资金/负债账户是「实时余额」：期初余额 + 流水滚动，不用快照
  const acols = (db.query("PRAGMA table_info(account_info)").all() as { name: string }[]).map((c) => c.name);
  if (!acols.includes("opening_balance")) db.exec("ALTER TABLE account_info ADD COLUMN opening_balance REAL DEFAULT 0");
  if (!acols.includes("opening_date")) db.exec("ALTER TABLE account_info ADD COLUMN opening_date TEXT");
}

export function findAccount(db: Database, code: string): AccountRow | null {
  return (db.query("SELECT * FROM account_info WHERE code = ?").get(code) as AccountRow | null) ?? null;
}

/** 允许写得松：大小写/空格都行，落库统一大写 */
export function normCode(v: string): string {
  return v.trim().toUpperCase();
}

export function cmdAccountAdd(db: Database, opts: Record<string, string | boolean>): void {
  const codeRaw = str(opts.code);
  const name = str(opts.name);
  if (!codeRaw) die("--code 必填（短码，如 CARD-1234 / WALLET-A）");
  if (!name) die("--name 必填（账户全名）");
  const code = normCode(codeRaw);
  const kind = str(opts.kind) ?? "资金";
  if (!(ACCOUNT_KINDS as readonly string[]).includes(kind)) {
    die(`--kind 必须是：${ACCOUNT_KINDS.join(" / ")}`);
  }
  db.query(
    `INSERT INTO account_info (code, name, kind, org, last4, note, active, opening_balance, opening_date, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT(code) DO UPDATE SET name=excluded.name, kind=excluded.kind,
       org=excluded.org, last4=excluded.last4, note=excluded.note, active=1`
  ).run(
    code,
    name,
    kind,
    str(opts.org) ?? null,
    str(opts.last4) ?? null,
    str(opts.note) ?? null,
    num(opts.opening) ?? 0,
    today(),
    new Date().toISOString()
  );
  process.stdout.write(`账户已存：[${kind}] ${code} ${name}\n`);
}

export function cmdAccountList(db: Database): void {
  const rows = db
    .query("SELECT * FROM account_info WHERE active = 1 ORDER BY kind, code")
    .all() as AccountRow[];
  if (!rows.length) {
    process.stdout.write("（还没有账户，用 account add 建）\n");
    return;
  }
  for (const r of rows) {
    const b = accountBalance(db, r);
    const tag = b.live ? "实时" : "市值";
    const debtMark = r.kind === "负债" ? "（欠）" : "";
    process.stdout.write(
      `${r.kind.padEnd(2, "　")}  ${r.code.padEnd(14)} ${r.name.padEnd(16, "　")}  ${tag} ¥${money(b.balance)}${debtMark}\n`
    );
  }
}

/** 流水净额：out 记负、in 记正、transfer 从本账户流出记负 */
export function ledgerNet(db: Database, code: string): number {
  const r = db
    .query(
      `SELECT COALESCE(SUM(CASE
          WHEN direction = 'in' THEN amount
          WHEN direction IN ('out','transfer') THEN -amount
          ELSE 0 END), 0) AS net
         FROM txn WHERE account = ?`
    )
    .get(code) as { net: number };
  const inflow = db
    .query("SELECT COALESCE(SUM(amount), 0) AS s FROM txn WHERE to_account = ? AND direction = 'transfer'")
    .get(code) as { s: number };
  return r.net + inflow.s;
}

/** 账户当前余额
 *  - 资金 / 负债：实时 = 期初 + 流水净额
 *  - 资产（理财）：市值快照（净值天天变，不滚动）
 */
export function accountBalance(db: Database, row: AccountRow): { balance: number; date: string; live: boolean } {
  if (row.kind === "资产") {
    const s = latestSnapshot(db, row.code);
    return { balance: s?.balance ?? row.opening_balance ?? 0, date: s?.date ?? "-", live: false };
  }
  const base = row.opening_balance ?? 0;
  return { balance: base + ledgerNet(db, row.code), date: row.opening_date ?? "-", live: true };
}

export function cmdAccountSnap(db: Database, opts: Record<string, string | boolean>): void {
  const codeRaw = str(opts.code);
  const bal = num(opts.balance);
  if (!codeRaw) die("--code 必填");
  if (bal === null) die("--balance 必填（负债记正数＝欠多少）");
  const code = normCode(codeRaw);
  const row = findAccount(db, code);
  if (!row) die(`账户 ${code} 不存在，先 account add`);
  const date = str(opts.date) ?? today();
  const time = str(opts.time) ?? nowHm();

  // 资金/负债：对账——把期初余额回调到「让实时余额等于你报的数」，并报出差额
  if (row.kind !== "资产") {
    const net = ledgerNet(db, code);
    const old = row.opening_balance ?? 0;
    const next = bal - net;
    db.query("UPDATE account_info SET opening_balance = ?, opening_date = ? WHERE code = ?").run(next, date, code);
    const delta = next - old;
    const sign = delta >= 0 ? "+" : "";
    process.stdout.write(
      `对账完成 ${code}：实时余额 ¥${money(bal)}（期初 ¥${money(old)} → ¥${money(next)}，差额 ${sign}¥${money(delta)}）\n`
    );
    return;
  }

  db.query(
    `INSERT INTO balance_snapshot (date, time, account, balance, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(date, account) DO UPDATE SET balance=excluded.balance,
       time=excluded.time, note=excluded.note`
  ).run(date, time, code, bal, str(opts.note) ?? null, new Date().toISOString());
  process.stdout.write(`市值快照已记 ${date} ${code} ¥${money(bal)}\n`);
}

export function latestSnapshot(db: Database, code: string) {
  return db
    .query("SELECT * FROM balance_snapshot WHERE account = ? ORDER BY date DESC, id DESC LIMIT 1")
    .get(code) as { date: string; balance: number; note: string | null } | null;
}

/** 净资产 = 资金（实时）+ 资产（市值快照）− 负债（实时） */
export function netWorth(db: Database): {
  items: { code: string; name: string; kind: string; balance: number; date: string; live: boolean }[];
  total: number;
  cash: number;
  asset: number;
  debt: number;
} {
  const rows = db.query("SELECT * FROM account_info WHERE active = 1").all() as AccountRow[];
  const items = rows.map((r) => {
    const b = accountBalance(db, r);
    return { code: r.code, name: r.name, kind: r.kind, balance: b.balance, date: b.date, live: b.live };
  });
  const sum = (k: string) => items.filter((i) => i.kind === k).reduce((a, b) => a + b.balance, 0);
  const cash = sum("资金");
  const asset = sum("资产");
  const debt = sum("负债");
  return { items, total: cash + asset - debt, cash, asset, debt };
}