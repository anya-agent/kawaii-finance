#!/usr/bin/env bun
/** kawaii-finance —— 随手记账 + 每日理财简报（SQLite，纯本地）
 *  用法：bun app.js <group> <cmd> [--key value]
 */
import { openDb, EXPENSE_CATEGORIES } from "./src/db.ts";
import { cmdTxnAdd, cmdTxnEdit, cmdTxnRm, cmdTxnTransfer, listTxns } from "./src/txn.ts";
import {
  cmdAccountAdd,
  cmdAccountList,
  cmdAccountSnap,
  ensureAccountSchema,
  netWorth,
  ACCOUNT_KINDS,
} from "./src/account.ts";
import { buildBrief, renderBrief, setConfig, getConfig } from "./src/brief.ts";
import { money, num, str, die, parseArgs } from "./src/util.ts";

const HELP = `kawaii-finance —— 随手记账 + 每日理财简报

账户（先建账户，流水才有归属）：
  bun app.js account add --code CARD-1234 --name "示例信用卡" --kind 资金 --org 示例银行 --last4 1234
  bun app.js account add --code CREDIT --name "示例信用付" --kind 负债 --org 示例支付
  bun app.js account list
  bun app.js account snap --code CARD-1234 --balance 30 [--date 2026-11-22]   # 余额快照（负债记正数）
  bun app.js nw                                                             # 净资产汇总
  kind：${ACCOUNT_KINDS.join(" / ")}

记账（类目能猜就猜，不用手动指定）：
  bun app.js add --item "食堂午餐" --amount 12.8 --account CREDIT [--category 吃饭] [--time 12:30]
  bun app.js add --item "工资" --amount 3000 --direction in --account CARD-5678
  bun app.js transfer --from WALLET-B --to CREDIT --amount 735.88   # 还款/充值，不计支出
  bun app.js edit --id 12 [--amount 12] [--account CREDIT] [--note "备注"]
  bun app.js rm --id 12
  bun app.js list [--days 7] [--category 吃饭] [--direction out]

简报（每天 8:30 推送 / 随时查看）：
  bun app.js brief [--json]

预算：
  bun app.js config set --weekly-budget 250
  bun app.js config get

类目：${EXPENSE_CATEGORIES.join(" / ")}

环境变量：FINANCE_DB 覆盖数据库路径（默认 ~/.kawaii-finance/finance.db）
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

  // 账户
  if (group === "account" || group === "acc") {
    if (cmd === "add") return void cmdAccountAdd(db, opts);
    if (cmd === "list" || cmd === undefined) return void cmdAccountList(db);
    if (cmd === "snap" || cmd === "snapshot") return void cmdAccountSnap(db, opts);
    die(`未知账户子命令：${cmd}（add / list / snap）`);
  }
  if (group === "nw" || group === "networth") {
    const n = netWorth(db);
    if (opts.json) {
      process.stdout.write(JSON.stringify(n, null, 2) + "\n");
      return;
    }
    const L: string[] = [`💰 净资产 ¥${money(n.total)}`, ""];
    for (const i of n.items) {
      const tag = i.live ? "实时" : "市值";
      L.push(`  ${i.kind}  ${i.code.padEnd(14)} ${i.name}  ¥${money(i.balance)}  ${tag}(${i.date})`);
    }
    L.push("");
    L.push(`资金 ¥${money(n.cash)} + 资产 ¥${money(n.asset)} − 负债 ¥${money(n.debt)} = ¥${money(n.total)}`);
    process.stdout.write(L.join("\n") + "\n");
    return;
  }

  // 记账
  if (group === "transfer") return void cmdTxnTransfer(db, opts);
  if (group === "add" || group === "txn") {
    if (cmd === "add" || group === "add") return void cmdTxnAdd(db, opts);
    if (cmd === "list") return void listTxns(db, opts);
    if (cmd === "edit") return void cmdTxnEdit(db, opts);
    if (cmd === "rm" || cmd === "del") return void cmdTxnRm(db, opts);
    return void cmdTxnAdd(db, opts);
  }
  if (group === "list") return void listTxns(db, opts);
  if (group === "rm") return void cmdTxnRm(db, opts);
  if (group === "edit") return void cmdTxnEdit(db, opts);

  // 简报
  if (group === "brief" || group === "report") {
    const data = buildBrief(db);
    process.stdout.write(opts.json ? JSON.stringify(data, null, 2) + "\n" : renderBrief(data, db) + "\n");
    return;
  }

  // 配置
  if (group === "config") {
    if (cmd === "set") {
      const wb = num(opts["weekly-budget"]);
      if (wb !== null) {
        setConfig(db, "weekly_budget", String(wb));
        process.stdout.write(`周预算已设为 ¥${money(wb)}\n`);
        return;
      }
      die("用法：config set --weekly-budget 250");
    }
    if (cmd === "get" || cmd === undefined) {
      const wb = getConfig(db, "weekly_budget");
      process.stdout.write(`周预算：${wb ? "¥" + money(Number(wb)) : "未设置"}\n`);
      return;
    }
  }

  die(`未知命令：${positional.join(" ")}（--help 查看用法）`);
}

main();
