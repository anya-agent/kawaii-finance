/** 通用工具：日期、参数解析、格式化、金额 */

export const TZ = process.env.TZ || "Asia/Shanghai";

/** 今天（本地时区）YYYY-MM-DD */
export function today(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: TZ });
}

/** 现在 HH:MM */
export function nowHm(): string {
  return new Date().toLocaleTimeString("sv-SE", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
}

/** 某个日期偏移 N 天 */
export function shiftDays(date: string, delta: number): string {
  const d = new Date(date + "T12:00:00");
  d.setDate(d.getDate() + delta);
  return d.toLocaleDateString("sv-SE", { timeZone: TZ });
}

/** 日期所在的周一（ISO 周，周一为首日） */
export function weekStart(date: string): string {
  const d = new Date(date + "T12:00:00");
  const day = d.getDay(); // 0=周日
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toLocaleDateString("sv-SE", { timeZone: TZ });
}

/** 日期所在月的 1 号 */
export function monthStart(date: string): string {
  return date.slice(0, 7) + "-01";
}

/** "HH:MM" 校验 */
export function hm2min(v?: string | null): number | null {
  if (!v) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function checkHm(v: string | undefined, label: string): void {
  if (v === undefined) return;
  if (hm2min(v) === null) die(`${label} 不是合法时间（HH:MM，24 小时制）：${v}`);
}

/** 金额格式化：保留 2 位，去尾随 0 */
export function money(v: number | null): string {
  if (v === null || Number.isNaN(v)) return "—";
  const s = v.toFixed(2);
  return s.endsWith(".00") ? s.slice(0, -3) : s;
}

export function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** 极简参数解析：--key value / --flag / -k value */
export function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const opts: Record<string, string | boolean> = {};
  const isNegNumber = (s: string | undefined) => !!s && /^-\d/.test(s);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith("-") && !isNegNumber(next))) opts[key] = true;
      else { opts[key] = next; i++; }
    } else if (a.startsWith("-") && a.length === 2) {
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith("-") && !isNegNumber(next))) opts[a.slice(1)] = true;
      else { opts[a.slice(1)] = next; i++; }
    } else positional.push(a);
  }
  return { positional, opts };
}

export function str(v: string | boolean | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function num(v: string | boolean | undefined): number | null {
  if (typeof v !== "string") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function die(msg: string): never {
  process.stderr.write(msg.endsWith("\n") ? msg : msg + "\n");
  process.exit(1);
}
