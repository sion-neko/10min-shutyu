// 10分をやりきった日と、やりきった時間の記録。日付まわりだけを集めた、画面に依存しない部分。

// 1日の区切りは午前4時。深夜1時にやった分は前日として数える。
export const DAY_START_HOUR = 4;
export const WEEK_DAYS = 7;
export const WEEKDAY_LABELS = ['月', '火', '水', '木', '金', '土', '日'];

// 午前4時の区切りを「4時間ぶんだけ過去にずらした時刻」として扱う。
// こうすると以降は普通の暦日として日付を足し引きできる。
export function today() {
  return new Date(Date.now() - DAY_START_HOUR * 60 * 60 * 1000);
}

export function dayKey(d: Date) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// setDate は月またぎもうるう年も吸収してくれるので自前で計算しない。
export function addDays(d: Date, n: number) {
  const next = new Date(d);
  next.setDate(next.getDate() + n);
  return next;
}

// 今日がまだなら昨日から数える。日付が変わった瞬間に0へ落ちると、
// これから今日のぶんをやる人の記録が消えたように見えてしまうため。
export function streakOf(cleared: Set<string>) {
  let cursor = today();
  if (!cleared.has(dayKey(cursor))) {
    cursor = addDays(cursor, -1);
  }
  let count = 0;
  while (cleared.has(dayKey(cursor))) {
    count += 1;
    cursor = addDays(cursor, -1);
  }
  return count;
}

function dateOfKey(key: string) {
  const [year, month, date] = key.split('-').map(Number);
  return new Date(year, month - 1, date);
}

// これまでで一番長く続いた日数。日付順に並べて、前日と地続きの間だけ数え続ける。
// 今の連続とは違って今日を特別扱いしない。過去の記録は動かないため。
export function bestStreakOf(cleared: Set<string>) {
  const days = [...cleared].filter(isDayKey).sort();
  let best = 0;
  let run = 0;
  let prev: string | null = null;
  for (const key of days) {
    run = prev !== null && dayKey(addDays(dateOfKey(prev), 1)) === key ? run + 1 : 1;
    if (run > best) best = run;
    prev = key;
  }
  return best;
}

// getDay() は日曜が0。月曜はじまりの WEEKDAY_LABELS に合わせてずらす。
export function weekdayLabelOf(d: Date) {
  return WEEKDAY_LABELS[(d.getDay() + 6) % 7];
}

// 古い順に count 日ぶん。最後の要素が今日。
export function lastDays(count: number) {
  const base = today();
  return Array.from({ length: count }, (_, i) => addDays(base, i - count + 1));
}

export type Month = { year: number; month: number };

export function currentMonth(): Month {
  const base = today();
  return { year: base.getFullYear(), month: base.getMonth() };
}

// 年またぎは Date に任せる。12月の次が翌年1月になる計算を自前で書かない。
export function shiftMonth({ year, month }: Month, by: number): Month {
  const d = new Date(year, month + by, 1);
  return { year: d.getFullYear(), month: d.getMonth() };
}

export function isCurrentMonth({ year, month }: Month) {
  const now = currentMonth();
  return year === now.year && month === now.month;
}

// 1か月ぶんを月曜はじまりの週に切る。1日の前と末日の後ろは null で埋めて、
// どの月でも曜日の列がそろうようにする。
export function monthGrid(year: number, month: number): (Date | null)[][] {
  const leading = (new Date(year, month, 1).getDay() + 6) % 7;
  // 翌月の0日目 = 今月の末日。
  const lastDate = new Date(year, month + 1, 0).getDate();

  const cells: (Date | null)[] = Array(leading).fill(null);
  for (let d = 1; d <= lastDate; d += 1) cells.push(new Date(year, month, d));
  while (cells.length % WEEK_DAYS !== 0) cells.push(null);

  const weeks: (Date | null)[][] = [];
  for (let i = 0; i < cells.length; i += WEEK_DAYS) weeks.push(cells.slice(i, i + WEEK_DAYS));
  return weeks;
}

function monthPrefix(year: number, month: number) {
  return `${year}-${String(month + 1).padStart(2, '0')}-`;
}

export function countInMonth(cleared: Set<string>, year: number, month: number) {
  const prefix = monthPrefix(year, month);
  let count = 0;
  for (const key of cleared) {
    if (key.startsWith(prefix)) count += 1;
  }
  return count;
}

// 日付ごとの、最後までやりきった分数。10分なら10、ポモドーロの25分なら25を足していく。
// 途中で離れたぶんは数えない。キーがある日 = 10分をやりきった日。
export type DayMinutes = Record<string, number>;

export function totalMinutes(days: DayMinutes) {
  return Object.values(days).reduce((sum, m) => sum + m, 0);
}

export function minutesInMonth(days: DayMinutes, year: number, month: number) {
  const prefix = monthPrefix(year, month);
  let sum = 0;
  for (const [key, m] of Object.entries(days)) {
    if (key.startsWith(prefix)) sum += m;
  }
  return sum;
}

// 草の濃さ。その日の分数がこの区切り以下なら、その段になる。超えたら最後の段。
// 10分だけ／10分＋ポモドーロ1セット／1時間まで／それより多い、の4段。
export const HEAT_STEPS = [10, 35, 60];

// 1〜4。記録のない日には使わない。
export function heatLevelOf(minutes: number) {
  const i = HEAT_STEPS.findIndex((limit) => minutes <= limit);
  return (i === -1 ? HEAT_STEPS.length : i) + 1;
}

// 「35分」「1時間」「3時間35分」。
export function formatMinutes(total: number) {
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}分`;
  return m === 0 ? `${h}時間` : `${h}時間${m}分`;
}

// 「11月12日（木）」。
export function dateLabelOf(d: Date) {
  return `${d.getMonth() + 1}月${d.getDate()}日（${weekdayLabelOf(d)}）`;
}

// 今年は「8月」だけ。年をまたいだ分だけ「2025年12月」と年を添える。
export function monthLabel(year: number, month: number) {
  const thisYear = today().getFullYear();
  return year === thisYear ? `${month + 1}月` : `${year}年${month + 1}月`;
}

// 形だけでなく、その日付が実在するかまで見る。'' が 1900年に化けたり
// 2027-02-29 が3月に繰り上がったりすると、月の一覧が何百枚にもふくらむ。
export function isDayKey(v: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [year, month, date] = v.split('-').map(Number);
  return dayKey(new Date(year, month - 1, date)) === v;
}

// 古い形式（やった日の配列）も読む。時間は残っていないので、その日は10分とみなす。
const LEGACY_DAY_MINUTES = 10;

export function parseDayMinutes(raw: string | null): DayMinutes {
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    const days: DayMinutes = {};
    if (Array.isArray(parsed)) {
      for (const v of parsed) {
        if (typeof v === 'string' && isDayKey(v)) days[v] = LEGACY_DAY_MINUTES;
      }
      return days;
    }
    if (parsed === null || typeof parsed !== 'object') return {};
    for (const [key, m] of Object.entries(parsed)) {
      if (isDayKey(key) && typeof m === 'number' && Number.isFinite(m) && m > 0) {
        days[key] = Math.round(m);
      }
    }
    return days;
  } catch {
    // 壊れていたら空から作り直す。記録は消えるが起動できなくなるよりはいい。
    return {};
  }
}
