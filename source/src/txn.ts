/** 流水记录：增删改查 + 类目推断 */
import type { Database } from "bun:sqlite";
import { EXPENSE_CATEGORIES, type ExpenseCategory } from "./db.ts";
import { die, money, nowHm, num, str, today } from "./util.ts";
import { findAccount, normCode } from "./account.ts";

export interface TxnRow {
  id: number;
  date: string;
  time: string | null;
  amount: number;
  direction: string;
  category: string;
  item: string;
  note: string | null;
  source: string;
  account: string | null;
  to_account: string | null;
  created_at: string | null;
}

/** 按关键词猜类目——够用就行，猜错了他改就是了，别让他记账时做选择题 */
const CATEGORY_HINTS: [ExpenseCategory, string[]][] = [
  ["吃饭", ["饭", "食堂", "面", "菜", "鸡", "肉", "蛋", "咖啡", "奶茶", "瑞幸", "星巴克", "外卖", "早餐", "午餐", "晚餐", "水果", "零食", "巧克力", "牛奶", "拉面", "麻辣", "火锅", "麦当劳", "肯德基", "早点", "包子", "馒头", "海苔", "翅"]],
  ["交通", ["地铁", "公交", "打车", "顺风车", "车费", "高铁", "火车", "机票", "油费", "停车", "共享单车", "滴滴", "高德"]],
  ["订阅", ["订阅", "会员", "vip", "会员费", "续费", "服务器", "vps", "域名", "云", "github", "chatgpt", "claude", "api", "流量卡", "话费"]],
  ["购物", ["买", "衣服", "鞋", "袜", "书", "教材", "耳机", "数码", "快递", "网购", "淘宝", "示例商城", "拼多多", "闲鱼"]],
  ["娱乐", ["游戏", "epic", "steam", "电影", "演出", "机厅", "maimai", "舞萌", "唱歌", "票"]],
  ["日用", ["纸", "洗发", "沐浴", "牙膏", "纸巾", "洗衣", "水电", "网费", "宿舍", "理发"]],
];

export function guessCategory(item: string): ExpenseCategory {
  const s = item.toLowerCase();
  for (const [cat, words] of CATEGORY_HINTS) {
    if (words.some((w) => s.includes(w.toLowerCase()))) return cat;
  }
  return "其他";
}

export function isCategory(v: string): v is ExpenseCategory {
  return (EXPENSE_CATEGORIES as readonly string[]).includes(v);
}

export function cmdTxnAdd(db: Database, opts: Record<string, string | boolean>): void {
  const amount = num(opts.amount);
  if (amount === null || amount <= 0) die("--amount 必须是正数");
  const item = str(opts.item);
  if (!item) die("--item 不能为空（记录的是什么）");

  const date = str(opts.date) ?? today();
  const time = str(opts.time) ?? nowHm();
  const direction = str(opts.direction) === "in" || opts.income === true ? "in" : "out";
  const catRaw = str(opts.category);
  const category = catRaw && isCategory(catRaw) ? catRaw : guessCategory(item);

  // 账户（可选但强烈建议）：软校验，没建就先放行，别让他记账时被流程卡住
  const account = resolveAccount(db, str(opts.account));
  const toAccount = resolveAccount(db, str(opts.to));

  const res = db
    .query(
      `INSERT INTO txn (date, time, amount, direction, category, item, note, source, account, to_account, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      date,
      time,
      amount,
      direction,
      category,
      item,
      str(opts.note) ?? null,
      str(opts.source) ?? "manual",
      account,
      toAccount,
      new Date().toISOString()
    );

  const id = res.lastInsertRowid;
  const arrow = direction === "in" ? "+" : "-";
  const acc = account ? `  <${account}>` : "";
  const to = toAccount ? ` → <${toAccount}>` : "";
  process.stdout.write(`已记录 #${id}  ${date} ${time}  ${arrow}¥${money(amount)}  [${category}] ${item}${acc}${to}\n`);
}

/** 账户软校验：给了就必须已存在（防止拼错写进另一笔账），不给就返回 null */
export function resolveAccount(db: Database, raw: string | undefined): string | null {
  if (!raw) return null;
  const code = normCode(raw);
  if (!findAccount(db, code)) {
    die(`账户 ${code} 不存在。现有账户：list 看 account list，或先 account add --code ${code} --name ...`);
  }
  return code;
}

export function cmdTxnTransfer(db: Database, opts: Record<string, string | boolean>): void {
  const amount = num(opts.amount);
  if (amount === null || amount <= 0) die("--amount 必须是正数");
  const from = resolveAccount(db, str(opts.from));
  const to = resolveAccount(db, str(opts.to));
  if (!from || !to) die("transfer 需要 --from <账户> --to <账户>");
  if (from === to) die("--from 和 --to 不能是同一个账户");
  const date = str(opts.date) ?? today();
  const time = str(opts.time) ?? nowHm();
  const item = str(opts.item) ?? "内部转账";
  db.query(
    `INSERT INTO txn (date, time, amount, direction, category, item, note, source, account, to_account, created_at)
     VALUES (?, ?, ?, 'transfer', '其他', ?, ?, 'manual', ?, ?, ?)`
  ).run(date, time, amount, item, str(opts.note) ?? null, from, to, new Date().toISOString());
  process.stdout.write(`已记录转账 ${date} ${time}  ¥${money(amount)}  ${from} → ${to}（不计入支出）\n`);
}

export function cmdTxnEdit(db: Database, opts: Record<string, string | boolean>): void {
  const id = num(opts.id);
  if (id === null) die("--id 必填");
  const row = db.query("SELECT * FROM txn WHERE id = ?").get(id) as TxnRow | null;
  if (!row) die(`#${id} 不存在`);

  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  const put = (col: string, v: string | number | null) => {
    sets.push(`${col} = ?`);
    vals.push(v);
  };

  if (opts.amount !== undefined) {
    const a = num(opts.amount);
    if (a === null || a <= 0) die("--amount 必须是正数");
    put("amount", a);
  }
  if (opts.item !== undefined) put("item", str(opts.item) ?? row.item);
  if (opts.category !== undefined) {
    const c = str(opts.category)!;
    if (!isCategory(c)) die(`--category 必须是：${EXPENSE_CATEGORIES.join(" / ")}`);
    put("category", c);
  }
  if (opts.date !== undefined) put("date", str(opts.date)!);
  if (opts.time !== undefined) put("time", str(opts.time)!);
  if (opts.note !== undefined) put("note", str(opts.note) ?? null);
  if (opts.direction !== undefined) put("direction", str(opts.direction) === "in" ? "in" : "out");
  if (opts.account !== undefined) put("account", resolveAccount(db, str(opts.account)));
  if (opts.to !== undefined) put("to_account", resolveAccount(db, str(opts.to)));

  if (!sets.length) die("没有要改的字段");
  vals.push(id);
  db.query(`UPDATE txn SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  process.stdout.write(`已更新 #${id}\n`);
}

export function cmdTxnRm(db: Database, opts: Record<string, string | boolean>): void {
  const id = num(opts.id);
  if (id === null) die("--id 必填");
  const r = db.query("DELETE FROM txn WHERE id = ?").run(id);
  if (!r.changes) die(`#${id} 不存在`);
  process.stdout.write(`已删除 #${id}\n`);
}

export function listTxns(db: Database, opts: Record<string, string | boolean>): void {
  const days = num(opts.days) ?? 7;
  const from = str(opts.since) ?? (() => {
    const d = new Date();
    d.setDate(d.getDate() - (days! - 1));
    return d.toLocaleDateString("sv-SE", { timeZone: process.env.TZ || "Asia/Shanghai" });
  })();

  const where: string[] = ["date >= ?"];
  const params: (string | number)[] = [from];
  const cat = str(opts.category);
  if (cat) { where.push("category = ?"); params.push(cat); }
  const dir = str(opts.direction);
  if (dir) { where.push("direction = ?"); params.push(dir); }

  const rows = db
    .query(`SELECT * FROM txn WHERE ${where.join(" AND ")} ORDER BY date DESC, time DESC, id DESC`)
    .all(...params) as TxnRow[];

  if (!rows.length) {
    process.stdout.write("（无记录）\n");
    return;
  }
  for (const r of rows) {
    const arrow = r.direction === "in" ? "+" : r.direction === "transfer" ? "→" : "-";
    const note = r.note ? `  «${r.note}»` : "";
    const acc = r.account ? ` <${r.account}>` : "";
    const to = r.to_account ? ` →<${r.to_account}>` : "";
    process.stdout.write(
      `#${String(r.id).padStart(3)}  ${r.date} ${r.time ?? "--:--"}  ${arrow}¥${money(r.amount).padStart(7)}  ${r.category.padEnd(3, "　")}  ${r.item}${acc}${to}${note}\n`
    );
  }
}
