/** SQLite 层：schema + 打开连接（bun:sqlite，零依赖） */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_DB = "~/.kawaii-finance/finance.db";

/** 支出类目：粗粒度，够用即可（改这里等于改全局口径） */
export const EXPENSE_CATEGORIES = ["吃饭", "交通", "购物", "订阅", "娱乐", "日用", "其他"] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS txn (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT NOT NULL,           -- YYYY-MM-DD
  time       TEXT,                    -- HH:MM
  amount     REAL NOT NULL,           -- 正数（方向由 direction 决定）
  direction  TEXT NOT NULL DEFAULT 'out',  -- out=支出 / in=收入
  category   TEXT NOT NULL DEFAULT '其他',
  item       TEXT NOT NULL,           -- 条目描述
  note       TEXT,
  source     TEXT DEFAULT 'manual',   -- manual | screenshot | import
  created_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_txn_date ON txn(date);
CREATE INDEX IF NOT EXISTS idx_txn_cat  ON txn(category);

CREATE TABLE IF NOT EXISTS account (
  name       TEXT PRIMARY KEY,        -- 示例银行 / 示例支付 / 攒钱罐 / 黄金 / 债基 ...
  kind       TEXT NOT NULL,           -- cash | invest | reserve
  balance    REAL NOT NULL,           -- 当前余额（元）
  locked     REAL DEFAULT 0,          -- 其中锁定/不可动部分
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

export function openDb(path = process.env.FINANCE_DB || DEFAULT_DB): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 3000;");
  db.exec(SCHEMA);
  return db;
}
