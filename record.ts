// 10分をやりきった日の記録。日付まわりだけを集めた、画面に依存しない部分。

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

// 記録のある一番古い月から今月まで、新しい順に。
// 記録がなければ今月だけを返して、空のカレンダーが1枚出るようにする。
// 「もっと前」1回でさかのぼる月数。
export const MONTHS_PER_PAGE = 12;

// extraMonths を渡すと、記録より前の月もそのぶんだけ足して遡れるようにする。
export function monthsToShow(cleared: Set<string>, extraMonths = 0): Month[] {
  const base = today();
  let oldest = new Date(base.getFullYear(), base.getMonth(), 1);
  for (const key of cleared) {
    // 読み込み時に弾いているはずだが、ここが崩れると月が何百枚も出るので念のため。
    if (!isDayKey(key)) continue;
    const first = new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, 1);
    if (first < oldest) oldest = first;
  }
  oldest.setMonth(oldest.getMonth() - extraMonths);

  const months: Month[] = [];
  const cursor = new Date(base.getFullYear(), base.getMonth(), 1);
  while (cursor >= oldest) {
    months.push({ year: cursor.getFullYear(), month: cursor.getMonth() });
    cursor.setMonth(cursor.getMonth() - 1);
  }
  return months;
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

// まだ1日も来ていない週は落とす。今月の残りが空行のまま縦の余白になるのを防ぐ。
export function monthWeeks(year: number, month: number, todayKey: string) {
  return monthGrid(year, month).filter((week) =>
    week.some((date) => date !== null && dayKey(date) <= todayKey),
  );
}

export function countInMonth(cleared: Set<string>, year: number, month: number) {
  const prefix = `${year}-${String(month + 1).padStart(2, '0')}-`;
  let count = 0;
  for (const key of cleared) {
    if (key.startsWith(prefix)) count += 1;
  }
  return count;
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

export function parseClearedDays(raw: string | null) {
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string' && isDayKey(v));
  } catch {
    // 壊れていたら空から作り直す。記録は消えるが起動できなくなるよりはいい。
    return [];
  }
}
