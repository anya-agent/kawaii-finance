/** 摘要与简报：昨日 / 本周 / 本月 + 预算进度 + 异常提示 */
import type { Database } from "bun:sqlite";
import { money, monthStart, shiftDays, today, weekStart } from "./util.ts";
import { netWorth } from "./account.ts";

export interface SummaryRow {
  category: string;
  total: number;
  count: number;
}

export interface BriefData {
  date: string;
  yesterday: { date: string; total: number; income: number; rows: { item: string; amount: number; category: string }[] };
  week: { start: string; spent: number; income: number; budget: number | null; remaining: number | null; daysLeft: number };
  month: { start: string; spent: number; dailyAvg: number; daysElapsed: number; projected: number };
  byCategory: SummaryRow[];
  anomalies: string[];
}

function sumRange(db: Database, from: string, to: string, direction = "out"): number {
  const r = db
    .query("SELECT COALESCE(SUM(amount), 0) AS s FROM txn WHERE date >= ? AND date <= ? AND direction = ?")
    .get(from, to, direction) as { s: number };
  return r.s;
}

function catBreakdown(db: Database, from: string, to: string): SummaryRow[] {
  return db
    .query(
      `SELECT category, SUM(amount) AS total, COUNT(*) AS count
         FROM txn WHERE date >= ? AND date <= ? AND direction = 'out'
        GROUP BY category ORDER BY total DESC`
    )
    .all(from, to) as SummaryRow[];
}

/** 配置：每周可花预算（元）。存在 txn 外的轻量 kv：用 account 表不行，单独建一张 */
export function getConfig(db: Database, key: string): string | null {
  const r = db.query("SELECT value FROM config WHERE key = ?").get(key) as { value: string } | null;
  return r ? r.value : null;
}

export function setConfig(db: Database, key: string, value: string): void {
  db.query(
    "INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}

export function buildBrief(db: Database): BriefData {
  const d = today();
  const y = shiftDays(d, -1);
  const ws = weekStart(d);
  const ms = monthStart(d);

  // 昨天明细
  const yRows = db
    .query("SELECT item, amount, category FROM txn WHERE date = ? AND direction = 'out' ORDER BY amount DESC")
    .all(y) as { item: string; amount: number; category: string }[];
  const yTotal = yRows.reduce((a, b) => a + b.amount, 0);
  const yIncome = sumRange(db, y, y, "in");

  // 本周
  const wSpent = sumRange(db, ws, d);
  const wIncome = sumRange(db, ws, d, "in");
  const budgetRaw = getConfig(db, "weekly_budget");
  const budget = budgetRaw ? Number(budgetRaw) : null;
  const daysLeft = 7 - (new Date(d + "T12:00:00").getDay() === 0 ? 7 : new Date(d + "T12:00:00").getDay());

  // 本月
  const mSpent = sumRange(db, ms, d);
  const dayOfMonth = Number(d.slice(8, 10));
  const dailyAvg = dayOfMonth > 0 ? mSpent / dayOfMonth : 0;
  const daysInMonth = new Date(Number(d.slice(0, 4)), Number(d.slice(5, 7)), 0).getDate();
  const projected = dailyAvg * daysInMonth;

  // 异常：昨天单笔超过本周日均 2 倍
  const anomalies: string[] = [];
  const wDailyAvg = wSpent / Math.max(1, dayOfMonth <= 7 ? dayOfMonth : 7);
  for (const r of yRows) {
    if (r.amount > Math.max(50, wDailyAvg * 2)) {
      anomalies.push(`异常支出：${r.item} ¥${money(r.amount)}`);
    }
  }
  if (budget !== null && wSpent > budget) {
    anomalies.push(`本周已超预算 ¥${money(wSpent - budget)}`);
  }

  return {
    date: d,
    yesterday: { date: y, total: yTotal, income: yIncome, rows: yRows },
    week: { start: ws, spent: wSpent, income: wIncome, budget, remaining: budget === null ? null : budget - wSpent, daysLeft },
    month: { start: ms, spent: mSpent, dailyAvg, daysElapsed: dayOfMonth, projected },
    byCategory: catBreakdown(db, ws, d),
    anomalies,
  };
}

export function renderBrief(b: BriefData, dbForBrief: Database): string {
  const L: string[] = [];
  const yD = b.yesterday;
  L.push(`📊 理财简报 ${b.date}`);
  L.push("");

  if (yD.rows.length === 0) {
    L.push(`昨天（${yD.date}）没有支出记录`);
  } else {
    L.push(`昨天（${yD.date}）支出 ¥${money(yD.total)}`);
    for (const r of yD.rows.slice(0, 6)) {
      L.push(`  · ${r.item}  ¥${money(r.amount)}  [${r.category}]`);
    }
    if (yD.rows.length > 6) L.push(`  · …共 ${yD.rows.length} 笔`);
    if (yD.income > 0) L.push(`  另有收入 ¥${money(yD.income)}`);
  }
  L.push("");

  const w = b.week;
  if (w.budget !== null) {
    const pct = Math.round((w.spent / w.budget) * 100);
    const bar = "█".repeat(Math.min(10, Math.round(pct / 10))) + "░".repeat(Math.max(0, 10 - Math.round(pct / 10)));
    L.push(`本周 ¥${money(w.spent)} / 预算 ¥${money(w.budget)}  ${bar} ${pct}%`);
    if (w.remaining !== null && w.remaining >= 0) {
      L.push(`  还能花 ¥${money(w.remaining)}（剩 ${w.daysLeft} 天）`);
    } else {
      L.push(`  已超 ¥${money(-(w.remaining ?? 0))}`);
    }
  } else {
    L.push(`本周累计 ¥${money(w.spent)}（未设预算，用 \`bun app.js config set --weekly-budget 250\` 设置）`);
  }
  L.push("");

  const m = b.month;
  L.push(`本月 ¥${money(m.spent)}（日均 ¥${money(m.dailyAvg)}）`);
  L.push(`  按此速度月底约 ¥${money(m.projected)}`);
  if (b.byCategory.length) {
    const top = b.byCategory.slice(0, 4).map((c) => `${c.category} ¥${money(c.total)}`).join(" · ");
    L.push(`  本周分布：${top}`);
  }

  // 净资产（各账户最新快照）
  const nw = netWorth(dbForBrief);
  if (nw.items.some((i) => i.balance !== 0)) {
    L.push("");
    L.push(`💰 净资产 ¥${money(nw.total)}（资金 ¥${money(nw.cash)} + 资产 ¥${money(nw.asset)} − 负债 ¥${money(nw.debt)}）`);
  }

  if (b.anomalies.length) {
    L.push("");
    L.push("⚠️ " + b.anomalies.join("\n⚠️ "));
  }
  return L.join("\n");
}
