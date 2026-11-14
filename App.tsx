import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  AppState,
  Easing,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StatusBar as RNStatusBar,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import type { ScrollViewInstance, ViewInstance } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useKeepAwake } from 'expo-keep-awake';
import * as Haptics from 'expo-haptics';
import { setAudioModeAsync, useAudioPlayer } from 'expo-audio';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SplashScreen from 'expo-splash-screen';
import Svg, { Path } from 'react-native-svg';

import {
  WEEKDAY_LABELS,
  WEEK_DAYS,
  bestStreakOf,
  countInMonth,
  currentMonth,
  dayKey,
  isCurrentMonth,
  lastDays,
  monthLabel,
  monthWeeks,
  parseClearedDays,
  shiftMonth,
  streakOf,
  today,
  weekdayLabelOf,
} from './record';
import type { Month } from './record';

const DURATION_MS = 10 * 60 * 1000;
// 10分をやりきった人だけが入れる続きの道。ポモドーロ法の 25分集中 → 5分休憩。
const FOCUS_MS = 25 * 60 * 1000;
const BREAK_MS = 5 * 60 * 1000;
// 休憩の終わりは残り5秒から「ぽん」で数える。25分がいきなり始まらないように。
const COUNTDOWN_FROM = 5;
const TIPS_SEEN_KEY = 'tipsSeen';

// 起動画面は、最初に出す画面（Tips かホームか）が決まるまで残しておく。決まる前に
// 消すと、空の背景が一瞬見えてから中身がパッと出る。消すときもゆっくり引く。
// fade は iOS にしか効かないので、Android は下の APPEAR_MS の浮かび上がりで補う。
SplashScreen.preventAutoHideAsync().catch(() => {});
SplashScreen.setOptions({ duration: 500, fade: true });
// 起動画面が引いたあと、最初の画面が浮かび上がる時間。
const APPEAR_MS = 520;
const CLEARED_DAYS_KEY = 'clearedDays';

const PRAISES = [
  'おつかれさま！',
  '10分やりきったね！',
  'ナイス集中！',
  'やるじゃん！',
  'えらい！\nちゃんと始められたね',
  '始めるのがいちばん大変なんだよね。\nよくやった！',
  'いい感じに集中できたね',
  '今日の10分、おしまい！',
  'この調子でいこう',
  '今日もちゃんとやったね',
  'すごい、最後までできた！',
  'のってきたなら、\nもう少しやってもいいかも',
  'ちょっと伸びでもしよっか',
  '水でも飲んで、ひと休みしよう',
  'まだいけそう？',
  'よくがんばりました',
  'いいスタートが切れたね',
  'ちゃんと手が動いてたね',
  'やる気、出てきた？',
  '明日もこの調子で！',
];

// 続けて10分をやったときに同じ言葉が並ぶとランダムに見えないので、
// 直前に出したものだけは候補から外す。
function pickPraise(prev?: string) {
  const candidates = PRAISES.filter((p) => p !== prev);
  return candidates[Math.floor(Math.random() * candidates.length)];
}

// running は10分。focus と break はポモドーロの25分と5分。
type Status = 'idle' | 'running' | 'focus' | 'break' | 'done';

// 時計が動いている状態。画面を消さない・離れたらリセット・音で終わりを知らせる、
// の3つはどれも同じ扱いなので、状態ごとに条件を書き分けない。
function isCounting(status: Status) {
  return status === 'running' || status === 'focus' || status === 'break';
}

function formatRemaining(ms: number) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function Dot({ done, isToday, size }: { done: boolean; isToday: boolean; size: number }) {
  return (
    <View
      style={[
        { width: size, height: size, borderRadius: size / 2 },
        done ? styles.dotDone : styles.dotEmpty,
        // 今日だけ輪郭をつけて、右端がどこまで進んだのかを分かるようにする。
        isToday && !done && styles.dotToday,
      ]}
    />
  );
}

// 連続日数の炎。まだ0日のときは灰にして、火が点いていないことを色で示す。
// Bootstrap Icons の fire の外郭だけを使う。1個のためにアイコンフォントは積まない。
function Flame({ size, lit }: { size: number; lit: boolean }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16">
      <Path
        fill={lit ? ACCENT : DOT_OFF}
        d="M8 16c3.314 0 6-2 6-5.5 0-1.5-.5-4-2.5-6 .25 1.5-1.25 2-1.25 2C11 4 9 .5 6 0c.357 2 .5 4-2 6-1.25 1-2 2.729-2 4.5C2 14 4.686 16 8 16Z"
      />
    </Svg>
  );
}

// useKeepAwake はマウント中だけ有効になるので、カウントダウン中のみ描画して
// 開始前・終了後は普通どおり画面が消えるようにする。
function KeepScreenAwake() {
  useKeepAwake();
  return null;
}

// ボタンはツヤや影ではなく「厚み」で押せる物に見せる。同じ形の濃い面を下に
// ずらして敷き、押すと上の面がその厚みのぶんだけ沈む。
// Reanimated は足さず RN 標準の Animated だけで組む。
// press は 0 で浮いている、1 で沈みきった状態。
function usePressSink() {
  const press = useRef(new Animated.Value(0)).current;

  return {
    press,
    onPressIn: () =>
      Animated.timing(press, {
        toValue: 1,
        duration: 80,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }).start(),
    // 離したらバネで少し行き過ぎて戻す。まっすぐ戻すと押した手応えが出ない。
    onPressOut: () =>
      Animated.spring(press, {
        toValue: 0,
        friction: 4,
        tension: 160,
        useNativeDriver: true,
      }).start(),
  };
}

function sinkBy(press: Animated.Value, depth: number) {
  return {
    transform: [{ translateY: press.interpolate({ inputRange: [0, 1], outputRange: [0, depth] }) }],
  };
}

// 待っているあいだ、はじめるボタンはときどきひとりでに「ぽちっ」と沈む。
// 押したらどうなるかを先に見せて、押したくさせる。この間隔で繰り返す。
const IDLE_PRESS_GAP_MS = 2000;

// 押してから画面が切り替わるまで。押した実感を見せる間 → 円が広がる、の順。
// この間にボタンが沈んで弾む。短くすると押した手応えが消える。
// 全体で 1.25秒ほどかける。10分を始める場面なので、急かすより落ち着いて渡したい。
// 1秒（280 + 700）では「ちょっとはやい」と言われたので、両方を少しずつ延ばした。
const LAUNCH_HOLD_MS = 400;
const LAUNCH_MS = 850;
// 切り替わった先が浮かび上がる時間。
const ENTER_MS = 420;
// 画面を行き来するとき（このアプリについて・きろく・おわる）。一瞬で切り替わると、
// 何が起きたのか分からず不安になる。今の画面がゆっくり引いてから、次が浮かび上がる。
const SCREEN_LEAVE_MS = 360;
const SCREEN_ENTER_MS = 520;
// 広がる円のもとの直径。ここから画面の対角まで引き伸ばす。
const LAUNCH_SIZE = 100;

// カレンダーのマス。格子・曜日見出し・ドットの3か所でそろえる必要があるため定数で持つ。
// 7マス + 6すきま = 7*20 + 6*15 = 230pt。iPhone SE の内寸 311pt に収まる。
const CELL_SIZE = 20;
const CELL_GAP = 15;

// 何も起きていない画面で唯一動いているものが、押してほしいボタン。
function StartButton({
  size,
  onPress,
  onCenter,
}: {
  size: number;
  onPress: () => void;
  onCenter: (c: { x: number; y: number }) => void;
}) {
  const { press, onPressIn, onPressOut } = usePressSink();
  // 厚み。ボタンが小さい端末では一緒に薄くする。
  const depth = Math.round(size * 0.045);
  const wrapRef = useRef<ViewInstance>(null);
  // 指が触れたら止めるために、ひとりでに沈む動きをここに持っておく。
  const idleRef = useRef<Animated.CompositeAnimation | null>(null);
  const firedRef = useRef(false);

  const startIdle = () => {
    idleRef.current?.stop();
    const idle = Animated.loop(
      Animated.sequence([
        Animated.delay(IDLE_PRESS_GAP_MS),
        Animated.timing(press, {
          toValue: 1,
          duration: 110,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.delay(120),
        Animated.spring(press, {
          toValue: 0,
          friction: 5,
          tension: 140,
          useNativeDriver: true,
        }),
      ]),
    );
    idleRef.current = idle;
    idle.start();
  };

  useEffect(() => {
    startIdle();
    return () => idleRef.current?.stop();
  }, []);

  // 円はボタンのど真ん中から出したい。画面のどこにいるかは測らないと分からない。
  const reportCenter = () => {
    wrapRef.current?.measureInWindow((x, y, w, h) => {
      if (w > 0) onCenter({ x: x + w / 2, y: y + h / 2 });
    });
  };

  const pressIn = () => {
    idleRef.current?.stop();
    onPressIn();
  };

  // 押さずに指をずらして離れたときは、また待っている動きに戻る。
  const pressOut = () => {
    onPressOut();
    setTimeout(() => {
      if (!firedRef.current) startIdle();
    }, 0);
  };

  const fire = () => {
    if (firedRef.current) return;
    firedRef.current = true;
    idleRef.current?.stop();
    onPress();
  };

  return (
    <Pressable
      ref={wrapRef}
      onLayout={reportCenter}
      onPress={fire}
      onPressIn={pressIn}
      onPressOut={pressOut}
      accessibilityRole="button"
      accessibilityLabel="10分をはじめる"
      style={{ width: size, height: size + depth }}>
      <View
        pointerEvents="none"
        style={[
          styles.startEdge,
          { width: size, height: size, borderRadius: size / 2, top: depth },
        ]}
      />
      <Animated.View
        style={[
          styles.startButton,
          { width: size, height: size, borderRadius: size / 2 },
          sinkBy(press, depth),
        ]}>
        <Text style={styles.startLabel}>はじめる</Text>
        <Text style={styles.startSub}>10:00</Text>
      </Animated.View>
    </Pressable>
  );
}

// 横長の主ボタンの厚み。丸ボタンより小さいので薄くする。
const PRIMARY_DEPTH = 5;

// 「ポモドーロで続ける」「わかった」など、次に進むための主ボタン。
// sub は丸ボタンの「はじめる / 10:00」と同じで、押した先の長さを添えるためのもの。
function PrimaryButton({
  label,
  sub,
  onPress,
  style,
}: {
  label: string;
  sub?: string;
  onPress: () => void;
  style?: object;
}) {
  const { press, onPressIn, onPressOut } = usePressSink();

  return (
    <Pressable
      onPress={onPress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      accessibilityRole="button"
      accessibilityLabel={sub === undefined ? undefined : `${label} ${sub}`}
      style={[{ paddingBottom: PRIMARY_DEPTH }, style]}>
      <View pointerEvents="none" style={[styles.primaryEdge, { top: PRIMARY_DEPTH }]} />
      <Animated.View style={[styles.primaryButton, sinkBy(press, PRIMARY_DEPTH)]}>
        <Text style={styles.primaryLabel}>{label}</Text>
        {sub !== undefined && <Text style={styles.primarySub}>{sub}</Text>}
      </Animated.View>
    </Pressable>
  );
}

// 目立たせたくないテキストリンク。押した手応えだけは返す。
function QuietButton({
  label,
  onPress,
  style,
}: {
  label: string;
  onPress: () => void;
  style?: object;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={16}
      accessibilityRole="button"
      style={({ pressed }) => pressed && styles.quietPressed}>
      <Text style={[styles.quiet, style]}>{label}</Text>
    </Pressable>
  );
}

// 1枚に詰めると読むのがつらいので、話の切れ目でページを分ける。
function tipsPages() {
  return [
    <>
      <Text style={styles.tipsTitle}>こんにちは！</Text>
      <Text style={styles.tipsBody}>10分だけ集中するためのアプリです。</Text>
    </>,
    <>
      <Text style={styles.tipsTitle}>やる気はあとから出てくるらしい</Text>
      <Text style={styles.tipsBody}>
        やる気が出るのを待っていると、だいたい何も始まらないですよね。
        でもやる気は、手を動かしはじめてから出てくるものらしいです。
        始める前がいちばんしんどくて、やってみると案外そうでもない、という研究もあります。
      </Text>
    </>,
    <>
      <Text style={styles.tipsTitle}>10分で止まるのはわざとです</Text>
      <Text style={styles.tipsBody}>
        人は途中で区切られると、続きが気になってやりたくなるそうです。
        10分たって「もうちょっとやりたいな」と思ったら、作戦成功です。
      </Text>
      <Text style={styles.tipsBody}>さっそく10分、やってみましょう！</Text>
    </>,
    <>
      <Text style={styles.tipsTitle}>ルールは3つ</Text>
      <Text style={styles.tipsRule}>1. 途中で止めることはできません</Text>
      <Text style={styles.tipsRule}>2. アプリを離れると最初からやり直しです</Text>
      <Text style={styles.tipsRule}>3. 動画や音楽は見ないで、10分だけ手を動かします</Text>
    </>,
  ];
}

function Tips({ onDismiss }: { onDismiss: () => void }) {
  const { width } = useWindowDimensions();
  const [page, setPage] = useState(0);
  const pager = useRef<ScrollViewInstance>(null);
  const pages = tipsPages();
  const lastPage = pages.length - 1;
  const leave = useRef(new Animated.Value(1)).current;
  const leavingRef = useRef(false);

  // 消えきってから親に閉じてもらう。連打で2回閉じない。
  const close = () => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    Animated.timing(leave, {
      toValue: 0,
      duration: SCREEN_LEAVE_MS,
      easing: Easing.in(Easing.quad),
      useNativeDriver: true,
    }).start(() => onDismiss());
  };

  // 回転で幅が変わると、ページ何枚ぶんずれた位置に取り残される。合わせ直す。
  useEffect(() => {
    pager.current?.scrollTo({ x: page * width, animated: false });
  }, [width]);

  // ボタンで送っている最中の行き先。アニメーション途中の onScroll はまだ前のページの位置を
  // 指していて、そのまま拾うと点が「次→前→次」とちらつく。着くまでは無視する。
  const seekingTo = useRef<number | null>(null);

  const goTo = (next: number) => {
    const clamped = Math.max(0, Math.min(lastPage, next));
    seekingTo.current = clamped;
    setPage(clamped);
    pager.current?.scrollTo({ x: clamped * width, animated: true });
  };

  return (
    <Animated.View
      pointerEvents={leavingRef.current ? 'none' : 'auto'}
      style={[
        styles.tipsRoot,
        {
          opacity: leave,
          transform: [{ scale: leave.interpolate({ inputRange: [0, 1], outputRange: [0.98, 1] }) }],
        },
      ]}>
      <ScrollView
        ref={pager}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        // 慣性の終わりではなく位置そのものから今のページを決める。
        // ゆっくり払うと慣性が出ず、onMomentumScrollEnd は来ないことがある。
        scrollEventThrottle={16}
        // 送りの途中で指で触ったら、そこからは指の位置に従う。
        onScrollBeginDrag={() => {
          seekingTo.current = null;
        }}
        onScroll={(e) => {
          const x = e.nativeEvent.contentOffset.x;
          if (seekingTo.current !== null) {
            if (Math.abs(x - seekingTo.current * width) > 1) return;
            seekingTo.current = null;
          }
          const next = Math.round(x / width);
          if (next !== page && next >= 0 && next <= lastPage) setPage(next);
        }}>
        {pages.map((content, i) => (
          // 横向きや小さい端末で1枚に収まらないときのために、中も縦に流せるようにする。
          <ScrollView key={i} style={{ width }} contentContainerStyle={styles.tipsPage}>
            {content}
          </ScrollView>
        ))}
      </ScrollView>

      <View style={styles.tipsFooter}>
        <View style={styles.tipsDots}>
          {pages.map((_, i) => (
            <View key={i} style={[styles.tipsDot, i === page && styles.tipsDotOn]} />
          ))}
        </View>
        <PrimaryButton
          label={page === lastPage ? 'わかった' : 'つぎへ'}
          onPress={() => (page === lastPage ? close() : goTo(page + 1))}
        />
      </View>
    </Animated.View>
  );
}

// カレンダーの月送り。押せないほうも消さずに薄くして、矢印の位置が動かないようにする。
function ArrowButton({
  label,
  hint,
  onPress,
  disabled,
}: {
  label: string;
  hint: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={20}
      accessibilityRole="button"
      accessibilityLabel={hint}
      accessibilityState={{ disabled: Boolean(disabled) }}
      style={({ pressed }) => pressed && styles.quietPressed}>
      <Text style={[styles.monthArrow, disabled && styles.monthArrowOff]}>{label}</Text>
    </Pressable>
  );
}

function MonthCalendar({
  year,
  month,
  cleared,
  todayKey,
}: {
  year: number;
  month: number;
  cleared: Set<string>;
  todayKey: string;
}) {
  return (
    <View style={styles.month}>
      {monthWeeks(year, month, todayKey).map((week, row) => (
        <View key={row} style={styles.gridRow}>
          {week.map((date, col) => {
            // 月の前後にはみ出したマスと未来の日は、場所だけ空けて何も描かない。
            const key = date && dayKey(date);
            if (!key || key > todayKey) {
              return <View key={col} style={styles.gridCell} />;
            }
            return (
              <View key={col} style={styles.gridCell}>
                <Dot done={cleared.has(key)} isToday={key === todayKey} size={CELL_SIZE} />
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}

function Record({ cleared, onDismiss }: { cleared: Set<string>; onDismiss: () => void }) {
  const todayKey = dayKey(today());
  const streak = streakOf(cleared);
  const best = bestStreakOf(cleared);
  // 表示中の月。過去は好きなだけさかのぼれる。今月より先には記録が存在しない。
  const [month, setMonth] = useState<Month>(currentMonth);
  const monthCount = countInMonth(cleared, month.year, month.month);

  return (
    <View style={styles.recordRoot}>
      <ScrollView style={styles.recordScroll} contentContainerStyle={styles.record}>
        <Text style={styles.recordTitle}>きろく</Text>

        <View style={styles.stats}>
          {[
            { label: '連続日数', value: streak },
            { label: '最高日数', value: best },
            { label: '通算日数', value: cleared.size },
          ].map(({ label, value }) => (
            <View key={label} style={styles.statRow}>
              <Text style={styles.statLabel}>{label}</Text>
              <Text style={styles.statValue}>
                {value}
                <Text style={styles.statUnit}> 日</Text>
              </Text>
            </View>
          ))}
        </View>

        <View style={styles.monthNav}>
          <ArrowButton label="←" hint="前の月" onPress={() => setMonth(shiftMonth(month, -1))} />
          <View style={styles.monthTitle}>
            <Text style={styles.monthLabel}>{monthLabel(month.year, month.month)}</Text>
            <Text style={styles.monthCount}>{monthCount > 0 ? `${monthCount}日` : ' '}</Text>
          </View>
          <ArrowButton
            label="→"
            hint="次の月"
            onPress={() => setMonth(shiftMonth(month, 1))}
            disabled={isCurrentMonth(month)}
          />
        </View>

        {/* 曜日はどの月も同じ幅でそろうので、格子の上に1つだけ置く。 */}
        <View style={[styles.gridRow, styles.weekdayRow]}>
          {WEEKDAY_LABELS.map((label) => (
            <Text key={label} style={styles.weekdayLabel}>
              {label}
            </Text>
          ))}
        </View>

        <MonthCalendar
          year={month.year}
          month={month.month}
          cleared={cleared}
          todayKey={todayKey}
        />

        <Text style={styles.recordNote}>
          10分を最後までやりきった日に印がつきます。{'\n'}
          1日に何回やってもその日は1つです。
        </Text>
      </ScrollView>

      {/* 記録が何年ぶんにもなるので、とじるだけはスクロールの外に出して常に届かせる。 */}
      <View style={styles.recordFooter}>
        <PrimaryButton label="とじる" onPress={onDismiss} />
      </View>
    </View>
  );
}

export default function App() {
  const { width, height } = useWindowDimensions();
  const [status, setStatus] = useState<Status>('idle');
  const [remainMs, setRemainMs] = useState(DURATION_MS);
  const [praise, setPraise] = useState(() => pickPraise());
  // ポモドーロの何セット目か。1から数える。
  const [pomodoroSet, setPomodoroSet] = useState(1);
  // null は読み込み中。一瞬ホーム画面が見えてから Tips が出るのを避ける。
  const [showTips, setShowTips] = useState<boolean | null>(null);
  const [showRecord, setShowRecord] = useState(false);
  const [cleared, setCleared] = useState<Set<string>>(() => new Set());
  const endAtRef = useRef(0);
  // 記録は完了時に読み書きするので、state とは別に最新値を同期で持っておく。
  const clearedRef = useRef<Set<string>>(cleared);
  const chime = useAudioPlayer(require('./assets/chime.wav'));
  const pon = useAudioPlayer(require('./assets/pon.wav'));
  // 開始音だけは合成ではなく既成の効果音。くらげ工匠(kurage-kosho.info)の
  // 「ボタン081」。商用利用無料・クレジット不要・加工自由。素材の再配布は禁止。
  // 3.5秒あり、画面が切り替わったあとも余韻として鳴り続ける。切らずにそのまま使う。
  const startSound = useAudioPlayer(require('./assets/start.mp3'));
  // 同じ秒で何度も鳴らさないための「最後に鳴らした残り秒数」。0 は未再生。
  const countdownRef = useRef(0);
  // 円を出す位置。ボタンを置いたときに測って覚えておく。
  const [buttonCenter, setButtonCenter] = useState<{ x: number; y: number } | null>(null);
  // 開始の演出中。円が広がりきるまで次の画面へは行かない。
  const [launching, setLaunching] = useState(false);
  const launchingRef = useRef(false);
  const launch = useRef(new Animated.Value(0)).current;
  // 切り替わった先の画面が浮かび上がるための値。
  const enter = useRef(new Animated.Value(1)).current;
  // 画面を行き来するときに、引いて・浮かび上がるための値。
  const screen = useRef(new Animated.Value(1)).current;
  // 切り替えるたびに進める。新しい画面が描かれたのを、これで知って浮かび上がらせる。
  const [screenSwap, setScreenSwap] = useState(0);
  // 引いている最中。連打で2回切り替えず、消えかけの画面のボタンも押させない。
  const [switching, setSwitching] = useState(false);
  const switchingRef = useRef(false);
  // 起動直後の画面が浮かび上がるための値。一度 1 になったらそのまま。
  const appear = useRef(new Animated.Value(0)).current;

  // サイレントスイッチが入っていても終了音は鳴らす。
  useEffect(() => {
    setAudioModeAsync({ playsInSilentMode: true });
  }, []);

  // Tips は初回起動時だけ出す。読めなかったときは邪魔しない側に倒す。
  useEffect(() => {
    AsyncStorage.getItem(TIPS_SEEN_KEY)
      .then((seen) => setShowTips(seen === null))
      .catch(() => setShowTips(false));
  }, []);

  // 記録が読めなくても10分は測れる。空のまま進めて起動は止めない。
  // 読み込み中に完了した日があっても消さないよう、上書きではなく足し合わせる。
  useEffect(() => {
    AsyncStorage.getItem(CLEARED_DAYS_KEY)
      .then((raw) => {
        const merged = new Set([...parseClearedDays(raw), ...clearedRef.current]);
        clearedRef.current = merged;
        setCleared(merged);
      })
      .catch(() => {});
  }, []);

  const recordToday = () => {
    const key = dayKey(today());
    if (clearedRef.current.has(key)) return;
    const next = new Set(clearedRef.current).add(key);
    clearedRef.current = next;
    setCleared(next);
    AsyncStorage.setItem(CLEARED_DAYS_KEY, JSON.stringify([...next].sort())).catch(() => {
      // 保存できなくても今回の10分は成立している。記録だけ諦める。
    });
  };

  // 最初の画面が決まったら起動画面を引き、入れ替わりに中身を浮かび上がらせる。
  // 読み込みに失敗しても showTips は false に決まるので、起動画面が残り続けることはない。
  const appeared = useRef(false);
  useEffect(() => {
    if (showTips === null || appeared.current) return;
    appeared.current = true;
    SplashScreen.hide();
    Animated.timing(appear, {
      toValue: 1,
      duration: APPEAR_MS,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [showTips]);

  // 次の画面が描かれてから浮かび上がらせる。描く前に動かすと、出た瞬間には終わっている。
  useEffect(() => {
    if (screenSwap === 0) return;
    switchingRef.current = false;
    setSwitching(false);
    Animated.timing(screen, {
      toValue: 1,
      duration: SCREEN_ENTER_MS,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [screenSwap]);

  // 今の画面を引いてから go で差し替える。浮かび上がるのは上の effect。
  const switchScreen = (go: () => void) => {
    if (switchingRef.current) return;
    switchingRef.current = true;
    setSwitching(true);
    Animated.timing(screen, {
      toValue: 0,
      duration: SCREEN_LEAVE_MS,
      easing: Easing.in(Easing.quad),
      useNativeDriver: true,
    }).start(() => {
      go();
      setScreenSwap((n) => n + 1);
    });
  };

  // Tips は自分で引いてから閉じてくるので、ここでは浮かび上がらせるだけ。
  const dismissTips = () => {
    screen.setValue(0);
    setScreenSwap((n) => n + 1);
    setShowTips(false);
    AsyncStorage.setItem(TIPS_SEEN_KEY, '1').catch(() => {
      // 保存できなくても今回は閉じる。次回また出るだけで実害はない。
    });
  };

  // 2回目以降は再生位置が末尾に残っているので、頭出しを待ってから鳴らす。
  const playSound = async (player: typeof chime) => {
    try {
      await player.seekTo(0);
    } catch {
      // 頭出しに失敗しても鳴らすことを優先する
    }
    player.play();
  };

  // 終了時刻だけを置いて状態を切り替える。残り時間はこの時刻から毎回引き直す。
  const startPhase = (next: 'running' | 'focus' | 'break') => {
    const ms = next === 'running' ? DURATION_MS : next === 'focus' ? FOCUS_MS : BREAK_MS;
    countdownRef.current = 0;
    endAtRef.current = Date.now() + ms;
    setRemainMs(ms);
    setStatus(next);
  };

  const stop = () => {
    setRemainMs(DURATION_MS);
    setPomodoroSet(1);
    setStatus('idle');
  };

  // 残り時間は「終了時刻との差」で毎回求める。setInterval のズレが蓄積しない。
  useEffect(() => {
    if (!isCounting(status)) return;

    const tick = () => {
      const left = endAtRef.current - Date.now();
      if (left > 0) {
        setRemainMs(left);
        // 休憩の残り5秒だけ、1秒ごとに「ぽん」。0秒のチャイムが開始の合図になる。
        if (status === 'break') {
          const sec = Math.ceil(left / 1000);
          if (sec <= COUNTDOWN_FROM && sec !== countdownRef.current) {
            countdownRef.current = sec;
            playSound(pon);
          }
        }
        return;
      }
      setRemainMs(0);
      if (status === 'running') {
        setPraise((prev) => pickPraise(prev));
        setStatus('done');
        // 記録は10分をやりきった日に付く。ポモドーロはこの完了画面からしか
        // 始められないので、25分のほうで付け直す必要はない。
        recordToday();
      } else if (status === 'focus') {
        startPhase('break');
      } else {
        // 休憩明けはタップを待たずに次の25分へ入る。離れたらリセットである以上
        // どのみち画面の前にいるので、ここで待たせても手が止まるだけ。
        setPomodoroSet((n) => n + 1);
        startPhase('focus');
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      playSound(chime);
    };

    tick();
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [status]);

  // 円が消えたあとに数字が浮かび上がる。演出の後半にあたる。
  // 時間切れでひとりでに切り替わる休憩・完了の画面も、同じように浮かび上がらせる。
  useEffect(() => {
    if (status === 'idle') return;
    enter.setValue(0);
    Animated.timing(enter, {
      toValue: 1,
      duration: ENTER_MS,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [status]);

  // アプリを離れたらタイマーは破棄。10分は10分、途中離脱は最初からやり直し。
  // ポモドーロも同じで、休憩中に離れてもそこで終わり。セット数も1に戻る。
  // 'inactive'（通知センターを少し引いた等）は含めない。誤爆が厳しすぎるため。
  useEffect(() => {
    if (!isCounting(status)) return;
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background') {
        stop();
      }
    });
    return () => sub.remove();
  }, [status]);

  // 始まりの合図。チャイムは「終わった」の音なので、ここでは鳴らさない。
  // 休憩明けの自動再開だけは 0秒のチャイムが合図を兼ねるので、この関数を通らない。
  //
  // 押した瞬間に画面を差し替えると、自分が押したのか勝手に変わったのか分からない。
  // 音を鳴らし、押されたボタンを見せ、そこから円が広がりきってから次の画面へ渡す。
  // 待機中の波紋がそのまま画面いっぱいまで広がった、という見え方にする。
  const launchInto = (go: () => void) => {
    if (launchingRef.current) return; // 連打で2回走らせない
    launchingRef.current = true;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    playSound(startSound);
    setLaunching(true);
    Animated.sequence([
      Animated.delay(LAUNCH_HOLD_MS),
      Animated.timing(launch, {
        toValue: 1,
        duration: LAUNCH_MS,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    ]).start(() => {
      go();
      setLaunching(false);
      launchingRef.current = false;
      // 同じフレームで戻すと、縮んだ円が1コマだけ映ることがある。
      requestAnimationFrame(() => launch.setValue(0));
    });
  };

  const start = () => launchInto(() => startPhase('running'));

  const startPomodoro = () =>
    launchInto(() => {
      setPomodoroSet(1);
      startPhase('focus');
    });

  // 横向きは高さが一気に詰まるので、文字も余白も短い辺に合わせて縮める。
  const isLandscape = width > height;
  const gap = isLandscape ? 0.5 : 1;
  const clockSize = Math.min(width * 0.34, height * 0.42);
  // safe-area のライブラリは入れずに済ませる。この余白を使う帯は
  // 縦向きでしか出さないので、縦向きのぶんだけ考えればいい。
  const topInset = Platform.OS === 'android' ? (RNStatusBar.currentHeight ?? 0) : 56;
  const streak = streakOf(cleared);
  // 丸ボタンは画面の高さではなく「帯を引いた残り」から決める。全体の高さで
  // 決めると、背の低い端末で下の「つかいかた／きろく」が画面外に出る。
  // 帯の実測ではなく目安でよく、縮めるべきかどうかが分かれば足りる。
  const stripHeight = isLandscape ? 0 : topInset + 110;
  // 円はボタンのいた場所から広げる。覆いきるには、そこから画面のいちばん
  // 遠い角までが半径ぶん必要になる。
  const center = buttonCenter ?? { x: width / 2, y: height / 2 };
  const farthest = Math.max(
    Math.hypot(center.x, center.y),
    Math.hypot(width - center.x, center.y),
    Math.hypot(center.x, height - center.y),
    Math.hypot(width - center.x, height - center.y),
  );
  const launchCover = ((farthest * 2) / LAUNCH_SIZE) * 1.05;
  const launchStyle = {
    opacity: launch.interpolate({
      inputRange: [0, 0.15, 0.7, 1],
      outputRange: [0, 0.9, 0.75, 0],
    }),
    transform: [
      { scale: launch.interpolate({ inputRange: [0, 1], outputRange: [0.35, launchCover] }) },
    ],
  };
  // 円が広がるあいだに、裏のホーム画面は引いておく。
  const leaveStyle = {
    opacity: launch.interpolate({
      inputRange: [0, 0.45],
      outputRange: [1, 0],
      extrapolate: 'clamp' as const,
    }),
  };
  // 円が消えたあとに現れる側。下から浮かぶのではなく、少し小さい状態から起き上がる。
  const enterStyle = {
    opacity: enter,
    transform: [{ scale: enter.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) }],
  };
  // やりきった画面。時間切れでひとりでに来るので浮かび上がり、ポモドーロへ進むときは円の裏で引く。
  const doneStyle = {
    opacity: Animated.multiply(leaveStyle.opacity, enter),
    transform: enterStyle.transform,
  };
  // 画面を行き来するときの動き。どの画面もこれで包む。
  const screenStyle = {
    flex: 1,
    opacity: screen,
    transform: [{ scale: screen.interpolate({ inputRange: [0, 1], outputRange: [0.98, 1] }) }],
  };
  const startSize = Math.min(220, (height - stripHeight) * 0.46);
  // 起動画面が引いたあとに最初の画面が現れるときの動き。中身だけを動かし、背景は
  // 起動画面と同じ色のまま置いておく。
  const appearStyle = {
    flex: 1,
    opacity: appear,
    transform: [{ scale: appear.interpolate({ inputRange: [0, 1], outputRange: [0.98, 1] }) }],
  };

  if (showTips !== false) {
    return (
      <View style={styles.root}>
        <StatusBar style="dark" />
        {showTips === true && (
          <Animated.View style={appearStyle}>
            <Animated.View style={screenStyle}>
              <Tips onDismiss={dismissTips} />
            </Animated.View>
          </Animated.View>
        )}
      </View>
    );
  }

  if (showRecord) {
    return (
      <View style={styles.root}>
        <StatusBar style="dark" />
        <Animated.View pointerEvents={switching ? 'none' : 'auto'} style={screenStyle}>
          <Record cleared={cleared} onDismiss={() => switchScreen(() => setShowRecord(false))} />
        </Animated.View>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <StatusBar style="dark" hidden={isCounting(status)} />
      {isCounting(status) && <KeepScreenAwake />}
      <Animated.View style={appearStyle}>
        <Animated.View pointerEvents={switching ? 'none' : 'auto'} style={screenStyle}>
          {/* 連続日数と直近1週間。開かなくても見える位置に置く。
            場所を取る帯なので絶対配置にはしない。重ねると小さい端末で
            「10 MIN」の上に乗ってしまう。ここで高さを取り、残りを中央が使う。
            横向きは縦の余白がないので、この帯ごと出さない。 */}
          {status === 'idle' && !isLandscape && (
            <Animated.View
              pointerEvents={launching ? 'none' : 'auto'}
              style={[styles.streakArea, { paddingTop: topInset + 12 }, leaveStyle]}>
              <Pressable
                onPress={() => switchScreen(() => setShowRecord(true))}
                accessibilityRole="button"
                accessibilityLabel={`きろくを見る。連続${streak}日`}
                style={({ pressed }) => [styles.streakCard, pressed && styles.quietPressed]}>
                <Flame size={26} lit={streak > 0} />

                {/* 0日でも出す。出たり消えたりすると、この場所に何があるのか覚えられない。 */}
                <View style={styles.streakCount}>
                  <Text style={styles.streakLabel}>連続</Text>
                  <Text style={styles.streakValue}>
                    {streak}
                    <Text style={styles.streakUnit}>日</Text>
                  </Text>
                </View>

                {/* 丸を等間隔に並べただけだと、ページ送りのドットにしか見えない。
                  曜日を添えると一目で「日付の並び」になる。 */}
                <View style={styles.weekDays}>
                  {lastDays(WEEK_DAYS).map((date, i) => {
                    const isToday = i === WEEK_DAYS - 1;
                    return (
                      <View key={dayKey(date)} style={styles.weekDay}>
                        <Text style={[styles.weekDayLabel, isToday && styles.weekDayLabelToday]}>
                          {weekdayLabelOf(date)}
                        </Text>
                        <Dot done={cleared.has(dayKey(date))} isToday={isToday} size={10} />
                      </View>
                    );
                  })}
                </View>
              </Pressable>
            </Animated.View>
          )}

          {status === 'idle' && (
            <Animated.View
              pointerEvents={launching ? 'none' : 'auto'}
              style={[styles.center, isLandscape && styles.centerLandscape, leaveStyle]}>
              <Text style={[styles.eyebrow, { marginBottom: 48 * gap }]}>10 MIN</Text>
              <StartButton size={startSize} onPress={start} onCenter={setButtonCenter} />
              <Text style={[styles.note, { marginTop: 48 * gap }]}>まずは10分だけやってみよう</Text>
              {/* 縦向きは上の帯がきろくの入口になるので、ここには出さない。
                横向きは帯ごと出せないので、ここだけが入口になる。 */}
              <View style={[styles.quietRow, { marginTop: 24 * gap }]}>
                <QuietButton
                  label="このアプリについて"
                  onPress={() => switchScreen(() => setShowTips(true))}
                  style={styles.faint}
                />
                {isLandscape && (
                  <QuietButton
                    label="きろく"
                    onPress={() => switchScreen(() => setShowRecord(true))}
                    style={styles.faint}
                  />
                )}
              </View>
            </Animated.View>
          )}

          {status === 'running' && (
            <Animated.View
              style={[styles.center, isLandscape && styles.centerLandscape, enterStyle]}>
              <Text
                numberOfLines={1}
                adjustsFontSizeToFit
                style={[styles.clock, { fontSize: clockSize }]}>
                {formatRemaining(remainMs)}
              </Text>
              <Text style={[styles.hint, { marginTop: 24 * gap }]}>アプリを離れるとリセット</Text>
            </Animated.View>
          )}

          {/* 25分。10分の画面にセット数だけを足す。集中中に増える情報はこれ以上いらない。 */}
          {status === 'focus' && (
            <Animated.View
              style={[styles.center, isLandscape && styles.centerLandscape, enterStyle]}>
              <Text style={[styles.eyebrow, { marginBottom: 16 * gap }]}>{pomodoroSet} セットめ</Text>
              <Text
                numberOfLines={1}
                adjustsFontSizeToFit
                style={[styles.clock, { fontSize: clockSize }]}>
                {formatRemaining(remainMs)}
              </Text>
              <Text style={[styles.hint, { marginTop: 24 * gap }]}>アプリを離れるとリセット</Text>
            </Animated.View>
          )}

          {/* 5分の休憩。時計を薄くして、同じ数字でも「進む時間」に見えないようにする。
            途中で止められないルールの唯一の抜け道がここ。「おわる」はこの5分にしかない。 */}
          {status === 'break' && (
            <Animated.View
              style={[styles.center, isLandscape && styles.centerLandscape, enterStyle]}>
              {/* アイコンのおばけは、休む画面とやりきった画面にだけ出す。
                数字を追う画面に置くと、集中の邪魔になる。 */}
              {!isLandscape && (
                <Image
                  source={require('./assets/ghost-sleep.png')}
                  style={[styles.ghostSleep, { marginBottom: 16 * gap }]}
                  accessibilityIgnoresInvertColors
                />
              )}
              <Text style={[styles.eyebrow, { marginBottom: 16 * gap }]}>きゅうけい</Text>
              <Text
                numberOfLines={1}
                adjustsFontSizeToFit
                style={[styles.clock, styles.clockBreak, { fontSize: clockSize }]}>
                {formatRemaining(remainMs)}
              </Text>
              <Text style={[styles.hint, { marginTop: 24 * gap }]}>
                アプリを離れるとリセット{'\n'}0になると {pomodoroSet + 1} セットめが始まります
              </Text>
              <QuietButton
                label="おわる"
                onPress={() => switchScreen(stop)}
                style={{ marginTop: 32 * gap }}
              />
            </Animated.View>
          )}

          {status === 'done' && (
            <Animated.View
              pointerEvents={launching ? 'none' : 'auto'}
              style={[styles.center, isLandscape && styles.centerLandscape, doneStyle]}>
              {!isLandscape && (
                <Image
                  source={require('./assets/ghost-laugh.png')}
                  style={[styles.ghostLaugh, { marginBottom: 20 * gap }]}
                  accessibilityIgnoresInvertColors
                />
              )}
              <Text style={[styles.eyebrow, { marginBottom: 48 * gap }]}>10 MIN 完了</Text>
              <Text style={[styles.praise, isLandscape && styles.praiseLandscape]}>{praise}</Text>
              {/* 10分が終わってまだ手が動く人のための続き。ここにしか入口はない。
                もう10分やりたい人もここへ来る。同じことを2つ並べても選べない。 */}
              <PrimaryButton
                label="ポモドーロで続ける"
                sub="25分やって5分休む"
                onPress={startPomodoro}
                style={{ marginTop: 64 * gap }}
              />
              <QuietButton
                label="おわる"
                onPress={() => switchScreen(stop)}
                style={{ marginTop: 24 * gap }}
              />
            </Animated.View>
          )}

          {/* 押したところから広がって画面を覆い、薄れて消える円。待機中の波紋が
            最後にひと息で広がりきった、という見立て。消えたあとに数字が現れる。 */}
          {launching && (
            <View pointerEvents="none" style={styles.launchOverlay}>
              <Animated.View
                style={[
                  styles.launchCircle,
                  { left: center.x - LAUNCH_SIZE / 2, top: center.y - LAUNCH_SIZE / 2 },
                  launchStyle,
                ]}
              />
            </View>
          )}
        </Animated.View>
      </Animated.View>
    </View>
  );
}

// 色はアプリアイコンのストップウォッチから取る。背景は文字盤のクリーム色。
// 純白より目が疲れず、白いカードが浮いて見える。
const BG = '#FBF5EC';
// 黒ではなく暖かい焦げ茶。背景のクリームと同じ側に寄せると画面がひとつにまとまる。
const INK = '#2E2620';
const TEXT = INK;
const MUTED = 'rgba(46, 38, 32, 0.65)';
const FAINT = 'rgba(46, 38, 32, 0.38)';
// 画面のほとんどが背景と同じクリームの濃淡なので、はっきり色がついているのは
// 「押すところ」だけ。迷いようがない。
// アイコンの背景のオレンジ。白い文字は沈むので、文字は焦げ茶にする。
const ACCENT = '#F6A56A';
// ボタンの厚み。影ではなく、同じ色相を濃くした面で見せる。
const ACCENT_EDGE = '#DE8646';
const ON_ACCENT = INK;
const CARD = '#FFFFFF';
// 記録のドットはあえて色を持たせない。ここに赤を足すと、押してほしい
// 丸ボタンと目線を取り合ってしまう。記録は眺めるもので、押すものではない。
const DOT_ON = 'rgba(46, 38, 32, 0.72)';
const DOT_OFF = 'rgba(46, 38, 32, 0.1)';
const DOT_TODAY = 'rgba(46, 38, 32, 0.28)';
const WEEKDAY = 'rgba(46, 38, 32, 0.5)';

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: BG,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  // 横向きのノッチ／Dynamic Island は左右に来る。実測 44pt を余裕をもって避ける。
  centerLandscape: {
    paddingHorizontal: 56,
  },
  eyebrow: {
    color: MUTED,
    fontSize: 14,
    letterSpacing: 4,
  },
  startButton: {
    position: 'absolute',
    top: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: ACCENT,
  },
  startEdge: {
    position: 'absolute',
    backgroundColor: ACCENT_EDGE,
  },
  startLabel: {
    color: ON_ACCENT,
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: 2,
  },
  startSub: {
    color: MUTED,
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 3,
    marginTop: 6,
    fontVariant: ['tabular-nums'],
  },
  primaryButton: {
    alignItems: 'center',
    paddingHorizontal: 44,
    paddingVertical: 17,
    borderRadius: 999,
    backgroundColor: ACCENT,
  },
  primaryEdge: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: 999,
    backgroundColor: ACCENT_EDGE,
  },
  primaryLabel: {
    color: ON_ACCENT,
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: 1,
    textAlign: 'center',
  },
  primarySub: {
    color: MUTED,
    fontSize: 12,
    marginTop: 3,
    textAlign: 'center',
  },
  quietPressed: {
    opacity: 0.5,
  },
  launchOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  launchCircle: {
    position: 'absolute',
    width: LAUNCH_SIZE,
    height: LAUNCH_SIZE,
    borderRadius: LAUNCH_SIZE / 2,
    backgroundColor: ACCENT,
  },
  // 切り抜きの縦横比のまま置く。横向きは縦の余白がないので出さない。
  ghostLaugh: {
    width: 104,
    height: 103,
  },
  ghostSleep: {
    width: 104,
    height: 86,
  },
  note: {
    color: MUTED,
    fontSize: 14,
    lineHeight: 22,
    textAlign: 'center',
  },
  clock: {
    color: TEXT,
    fontWeight: '200',
    fontVariant: ['tabular-nums'],
    letterSpacing: -2,
  },
  // 休憩は数字を追う時間ではない。濃さを落として、集中の25分と役割を分ける。
  clockBreak: {
    color: MUTED,
  },
  hint: {
    color: 'rgba(46, 38, 32, 0.4)',
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
  },
  praise: {
    color: TEXT,
    fontSize: 32,
    fontWeight: '300',
    lineHeight: 46,
    textAlign: 'center',
  },
  praiseLandscape: {
    fontSize: 26,
    lineHeight: 38,
  },
  quiet: {
    color: MUTED,
    fontSize: 15,
  },
  // すぐ上の「10分だけ、手を動かす。」より一段落とす。読む文と押せる文が
  // 同じ濃さで並ぶと、どちらも素通りされる。
  faint: {
    color: FAINT,
    fontSize: 12,
    letterSpacing: 0.4,
  },
  streakArea: {
    paddingHorizontal: 24,
    paddingBottom: 12,
  },
  // 白いカードで浮かせる。地の色に溶けていると、押せる場所だと気づけない。
  streakCard: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    gap: 14,
    maxWidth: 360,
    paddingHorizontal: 20,
    paddingVertical: 14,
    backgroundColor: CARD,
    borderRadius: 22,
    shadowColor: INK,
    shadowOpacity: 0.08,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 4,
  },
  streakCount: {
    alignItems: 'center',
    gap: 2,
  },
  streakLabel: {
    color: MUTED,
    fontSize: 12,
  },
  streakValue: {
    color: TEXT,
    fontSize: 26,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  streakUnit: {
    color: MUTED,
    fontSize: 13,
    fontWeight: '400',
  },
  weekDays: {
    flexDirection: 'row',
    gap: 10,
  },
  quietRow: {
    flexDirection: 'row',
    gap: 32,
  },
  weekDay: {
    alignItems: 'center',
    gap: 5,
  },
  weekDayLabel: {
    color: WEEKDAY,
    fontSize: 11,
  },
  // 右端が今日。曜日だけ明るくして、どちら向きに時間が流れているかを示す。
  weekDayLabelToday: {
    color: MUTED,
  },
  dotDone: {
    backgroundColor: DOT_ON,
  },
  dotEmpty: {
    backgroundColor: DOT_OFF,
  },
  dotToday: {
    borderWidth: 1,
    borderColor: DOT_TODAY,
  },
  recordRoot: {
    flex: 1,
  },
  recordScroll: {
    flex: 1,
  },
  record: {
    flexGrow: 1,
    justifyContent: 'center',
    alignSelf: 'center',
    alignItems: 'center',
    maxWidth: 560,
    paddingHorizontal: 32,
    paddingTop: 64,
    paddingBottom: 32,
  },
  // スクロールしてきたドットが透けないよう、背景を敷いて隠す。
  recordFooter: {
    alignItems: 'center',
    backgroundColor: BG,
    paddingTop: 20,
    paddingBottom: 32,
  },
  recordTitle: {
    color: TEXT,
    fontSize: 30,
    fontWeight: '300',
    marginBottom: 36,
  },
  // ラベルを左、数を右。等幅数字なので桁がそろう。
  stats: {
    width: 208,
    gap: 14,
    marginBottom: 44,
  },
  statRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  statLabel: {
    color: MUTED,
    fontSize: 15,
  },
  statValue: {
    color: TEXT,
    fontSize: 32,
    fontWeight: '200',
    fontVariant: ['tabular-nums'],
  },
  statUnit: {
    color: MUTED,
    fontSize: 15,
  },
  month: {
    alignItems: 'flex-start',
    gap: CELL_GAP,
    marginBottom: 32,
  },
  monthNav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 28,
    marginBottom: 20,
  },
  // 「8月」と「2025年12月」で矢印が動かないよう、最小幅を決めておく。
  monthTitle: {
    alignItems: 'center',
    minWidth: 116,
    gap: 2,
  },
  monthArrow: {
    color: TEXT,
    fontSize: 20,
    paddingHorizontal: 6,
  },
  monthArrowOff: {
    color: DOT_OFF,
  },
  monthLabel: {
    color: TEXT,
    fontSize: 17,
    fontWeight: '300',
  },
  monthCount: {
    color: MUTED,
    fontSize: 13,
  },
  gridRow: {
    flexDirection: 'row',
    gap: CELL_GAP,
  },
  gridCell: {
    width: CELL_SIZE,
    height: CELL_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  weekdayRow: {
    marginBottom: 16,
  },
  weekdayLabel: {
    width: CELL_SIZE,
    color: WEEKDAY,
    fontSize: 11,
    textAlign: 'center',
  },
  recordNote: {
    color: MUTED,
    fontSize: 13,
    lineHeight: 22,
    textAlign: 'center',
    marginTop: 8,
  },
  tipsRoot: {
    flex: 1,
  },
  // 横向きやiPadで1行が長くなりすぎないよう幅を頭打ちにして中央に置く。
  // ついでに横向きのノッチも避けられる。
  tipsPage: {
    flexGrow: 1,
    justifyContent: 'center',
    alignSelf: 'center',
    maxWidth: 560,
    paddingHorizontal: 32,
    paddingVertical: 48,
  },
  tipsTitle: {
    color: TEXT,
    fontSize: 30,
    fontWeight: '300',
    marginBottom: 28,
  },
  tipsBody: {
    color: 'rgba(46, 38, 32, 0.78)',
    fontSize: 16,
    lineHeight: 28,
    marginBottom: 20,
  },
  tipsRule: {
    color: TEXT,
    fontSize: 16,
    lineHeight: 26,
    marginBottom: 10,
  },
  // ページを送っても動かない位置に置く。何枚あって今どこかが常に見える。
  tipsFooter: {
    alignItems: 'center',
    paddingBottom: 40,
    gap: 24,
  },
  tipsDots: {
    flexDirection: 'row',
    gap: 8,
  },
  tipsDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: DOT_OFF,
  },
  tipsDotOn: {
    backgroundColor: DOT_ON,
  },
});
