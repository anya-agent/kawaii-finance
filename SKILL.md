---
name: kawaii-finance
description: "记账与理财简报：账户、流水、余额快照与净资产。"
---

# kawaii-finance

本地记账 + 理财简报工具。SQLite 单文件库，纯 CLI，无外部依赖、不联网、不做银行对接。

- DB：`~/.kawaii-finance/finance.db`（`FINANCE_DB` 可覆盖）
- 入口：`bun app.js <cmd>`（在本 skill 目录下执行）
- 源码：`source/index.ts` + `source/src/{db,account,txn,brief,util}.ts`
- 编译：`bun build source/index.ts --outfile app.js --target bun`（**必须 `--target bun`**，`--target node` 中文会双重编码）

## 三层结构

| 表 | 作用 | 关键点 |
|---|---|---|
| `account_info` | 账户元数据 + 期初余额 | `code` 短码主键、`kind` = 资金 / 负债 / 资产、`opening_balance` 期初 |
| `balance_snapshot` | **仅限资产的市值快照** | 净值天天变，只在报数/买卖/盘点时记 |
| `txn` | 流水 | `account` 出账账户、`to_account` 转账目标 |

**两种余额口径（重要）**

- **资金 / 负债 = 实时余额**：`期初 + Σ流水净额`，记账后自动变，不需要也不应该手动打快照
- **资产（理财）= 市值快照**：净值每天波动，只有主动报数时才更新

净资产 = 资金（实时）+ 资产（市值）− 负债（实时）。只算金融账户，不含设备/实物。

`account snap --code X --balance Y` 对两类账户行为不同：资产记市值快照；资金/负债做**对账**（回调期初，让实时余额等于 App 里看到的数，并打印差额）。

## 常用命令

```bash
# 账户
bun app.js account add --code CARD-1234 --name "示例信用卡" --kind 资金 --org 示例银行 --last4 1234
bun app.js account list
bun app.js account snap --code CARD-1234 --balance 30 [--date YYYY-MM-DD] [--note "..."]
bun app.js nw                     # 净资产汇总（--json 可机读）

# 流水
bun app.js add --item "食堂午饭" --amount 12.8 --account CARD-5678 [--category 吃饭] [--time 12:30]
bun app.js add --item "生活费到账" --amount 500 --direction in --account WALLET-C
bun app.js transfer --from WALLET-B --to CREDIT --amount 200   # 还款/充值，不算支出
bun app.js list [--days 7] [--category 吃饭]
bun app.js edit --id 12 [--amount 12] [--account CREDIT]
bun app.js rm --id 12

# 简报 / 预算
bun app.js brief [--json]
bun app.js config set --weekly-budget 250
```

类目：吃饭 / 交通 / 购物 / 订阅 / 娱乐 / 日用 / 其他（不传就按关键词猜）。

## 账户建模建议

用 **短码** 区分账户，而不是卡号或手机号：

- 资金类：储蓄卡、支付平台余额、现金账户
- 资产类：基金、理财、黄金等有市值的持仓
- 负债类：信用卡、消费信贷、先买后付

短码只用 ASCII 大写字母和连字符（如 `CARD-1234`、`WALLET-A`、`CREDIT`）。**不要混入形近字符**：西里尔 `І` 和拉丁 `I` 看起来一模一样，列表里发现不了，但查询永远匹配不上。

## 口径与陷阱

- **还款、充值必须走 `transfer`**：记成支出会让「支出」和「负债」双重记账，月度汇总直接虚高。`brief` 的支出统计只取 `direction='out'`，transfer 不计。
- **负债在 `balance_snapshot` 里记正数**（欠多少），净资产计算时减掉；不要写成负数。
- **资金/负债是「实时余额」，不是快照**：这类账户余额由流水滚动得出，记账后自动变化；只有**理财产品**才配叫「市值快照」，因为它天天波动、只能靠人工报数。别把两类混着叫，也别给资金账户手动打快照。
- **理财不逐日同步**：只在报数/买卖/盘点时打快照。基金看「市值」，**不要用总资产反推本金**，也不要把年内亏损当成待记支出。
- **`--account` 是软校验**：给了但账户不存在会直接报错退出（防拼错写进另一笔）；不给则允许记账，但之后只能靠 note 补归属。
- **零碎消费可以整体跳过**：如果某类支出单笔金额小、频次高（水费、打印、小额刷卡），与其逐笔记成噪音，不如只在充值时记一笔。这条要按个人习惯定，工具不强制。

## 每日简报

`brief` 输出当周支出、预算占用、账户余额与净资产。可由 cron / 定时任务每天跑一次，再由外层脚本决定要不要推送：

- 昨天有支出 → 推送
- 余额异常（负数、超额）→ 推送
- 固定复盘日 → 推送
- 其余 → 静默，零打扰

## 设计边界

- **不做银行/支付平台自动同步**：需要授权、容易失效，且凭证安全成本远高于手动记一笔。
- **不做票据 OCR**：识别误差会污染账本，纠错成本比手输高。
- **不估算、不预测**：只记录已发生的事实，投资建议不在范围内。