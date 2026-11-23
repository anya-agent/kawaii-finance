# kawaii-finance

一个**单文件 SQLite + 纯 CLI** 的本地记账工具。没有账号、没有云同步、没有订阅费，数据库就是磁盘上一个 `.db` 文件。

给想要「自己掌控账本」的人用：数据不出本机，逻辑可读可改，一条命令记一笔。

```
$ bun app.js nw
💰 净资产 ¥12,340.56

  资金  CARD-1234      示例信用卡        ¥1,280.00   实时(2026-11-23)
  资金  WALLET-C       支付余额          ¥420.50     实时(2026-11-23)
  资产  INV-BANK       基金持仓          ¥11,000.00  市值(2026-11-20)
  负债  CREDIT         信用付            ¥-360.00    实时(2026-11-23)

资金 ¥1700.50 + 资产 ¥11000.00 − 负债 ¥360.00 = ¥12340.50
```

## 为什么又是一个记账工具

市面上多数记账 App 有两个问题：**数据锁在别人服务器**，以及**图表比账本重要**。

这个项目的取舍很直接：

| 取舍 | 选择 |
|---|---|
| 数据存放 | 本地 SQLite，一个文件，可随时 `cp` 备份 |
| 交互方式 | CLI，一条命令一笔，可脚本化、可被 AI agent 调用 |
| 依赖 | 只有 Bun 内置的 `bun:sqlite`，零 npm 依赖 |
| 联网 | 完全不联网 |
| 分析能力 | 只做确定性的汇总，不预测、不推荐 |

## 快速开始

```bash
git clone https://github.com/anya-agent/kawaii-finance.git
cd kawaii-finance

# 建账户（先有账户，流水才有归属）
bun app.js account add --code WALLET-A --name "支付余额" --kind 资金 --org 示例支付
bun app.js account add --code CARD-1234 --name "储蓄卡" --kind 资金 --org 示例银行 --last4 1234
bun app.js account add --code INV-BANK  --name "基金持仓" --kind 资产 --org 示例银行
bun app.js account add --code CREDIT    --name "信用卡"   --kind 负债 --org 示例银行

# 记一笔
bun app.js add --item "食堂午饭" --amount 12.8 --account WALLET-A --category 吃饭

# 看净资产
bun app.js nw

# 本周简报
bun app.js brief
```

数据库默认落在 `~/.kawaii-finance/finance.db`，可用 `FINANCE_DB` 覆盖：

```bash
FINANCE_DB=/path/to/my.db bun app.js list --days 30
```

## 数据模型

三张表，覆盖 90% 的个人场景。

```
account_info      账户元数据 + 期初余额
  code            短码主键（CARD-1234）
  name            全名
  kind            资金 / 负债 / 资产
  org             机构
  last4           卡号后四位（仅展示用）
  opening_balance 期初余额

balance_snapshot  资产市值快照（只给资产用）
  account / balance / date / note

txn               流水
  item / amount / direction(out|in)
  account         出账账户
  to_account      转账目标（transfer 时）
  category        吃饭/交通/购物/订阅/娱乐/日用/其他
  time
```

### 两种余额，别混着算

这是整个工具最核心的一条规则：

- **资金 / 负债** 是**实时余额** = `期初 + Σ流水净额`。记一笔账它就变，不需要也不应该手动更新。
- **资产（基金、理财）** 是**市值快照**。净值每天波动，只有你主动报数时才记一次。

`account snap` 对两类账户行为不同：资产记快照；资金/负债做**对账**，回调期初让实时余额对得上你 App 里看到的数，并打印差额。这个设计让你既能享受"流水自动滚"，又能在对不上账时一键校正。

### 转账不等于支出

还信用卡、给钱包充值、账户间挪钱，**必须用 `transfer`**：

```bash
bun app.js transfer --from WALLET-B --to CREDIT --amount 200
```

记成两笔普通收支会让「支出」和「负债」双重计数，月度汇总直接虚高。`brief` 的支出统计只取 `direction='out'`，transfer 天然不计入。

## 命令参考

### 账户

```bash
bun app.js account add --code X --name "名称" --kind 资金|负债|资产 [--org 机构] [--last4 1234]
bun app.js account list
bun app.js account snap --code X --balance 1234.56 [--date YYYY-MM-DD] [--note "..."]
bun app.js nw [--json]
```

### 流水

```bash
bun app.js add --item "午饭" --amount 12.8 --account WALLET-A [--category 吃饭] [--time 12:30]
bun app.js add --item "工资" --amount 5000 --direction in --account CARD-1234
bun app.js list [--days 7] [--category 吃饭] [--direction out]
bun app.js edit --id 12 [--amount 12] [--account CREDIT] [--note "..."]
bun app.js rm --id 12
```

类目枚举是固定的：`吃饭 / 交通 / 购物 / 订阅 / 娱乐 / 日用 / 其他`。**传了非法值不会报错，会静默落成「其他」**；`edit` 也改不了类目，只能 `rm` 后重记。

### 简报与预算

```bash
bun app.js brief [--json]
bun app.js config set --weekly-budget 250
bun app.js config get
```

## 定时推送

`brief` 是纯确定性输出，适合挂 cron：

```bash
# 每天早上 8:45 跑一次，有内容才推
45 8 * * * cd /path/to/kawaii-finance && bun app.js brief
```

外层脚本自己决定要不要推送——没支出就静默，避免每天固定一条"今日消费 0 元"的噪音。

## 账户短码的坑

短码只用 **ASCII 大写字母 + 连字符**。

看起来是废话，但真踩过：西里尔字母 `І`（U+0406）和拉丁字母 `I`（U+0049）在终端里完全一样，`BAITIAO` 建成了 `BAІTIAO`，列表显示正常，查询永远匹配不上。建完账户一定跑一次 `account list` 扫一眼。

## 作为 AI agent skill 使用

`SKILL.md` 就是给 agent 看的文档，包含完整的数据模型、命令语义、以及一堆踩过的口径陷阱（实时余额 vs 市值快照、transfer 的记账方式、类目枚举的静默降级等）。

直接把这个目录丢进 agent 的 skills 路径，它就能自己读 `SKILL.md` 学会怎么记账。

## 设计边界

明确不做的事：

- **不自动同步银行/支付平台**：需要授权、容易失效，凭证安全成本远高于手记一笔
- **不做票据 OCR**：识别误差污染账本，纠错比手输更贵
- **不预测、不推荐**：只记录已发生的事实

## License

MIT