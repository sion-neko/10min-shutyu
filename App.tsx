import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  AppState,
  Easing,
  Platform,
  Pressable,
  ScrollView,
  StatusBar as RNStatusBar,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useKeepAwake } from 'expo-keep-awake';
import * as Haptics from 'expo-haptics';
import { setAudioModeAsync, useAudioPlayer } from 'expo-audio';
import AsyncStorage from '@react-native-async-storage/async-storage';
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
const CLEARED_DAYS_KEY = 'clearedDays';

const PRAISES = [
  'いい集中だ！',
  '10分、やりきった。',
  'よく始めた。\nそれが一番むずかしい。',
  'その調子。',
  '手が止まらないなら、\n止めなくていい。',
  '今日の自分、悪くない。',
  '10分前の自分に\n感謝しよう。',
  '手を動かした。\nそれがすべて。',
  'ちゃんと、進んだ。',
  '何もしなかった10分とは、\n確かに違う。',
  '上出来。',
  '続きは、いつでも。',
  '止まらずに来たね。',
  'はじめられる人だ。',
  '今日はもう、勝っている。',
  '小さく進むのが、\n結局いちばん速い。',
  'やる気は、\nあとからついてきた。',
  'ひとつ、積み上がった。',
  'まだ、いける気がする？',
  '逃げなかった。',
  '10分ぶん、前へ。',
  'きちんと座っていた。\nそれで十分。',
  '完璧じゃなくていい。\n続けばいい。',
  '手が覚えはじめている。',
  '気分より、行動が勝った。',
  'これを毎日やったら、\nどうなると思う？',
  'ひと区切り。\n伸びをしよう。',
  '誰も見ていなくても、\nやった。',
  '明日の自分が、\n少し楽になった。',
  'また戻ってくればいい。',
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

// 押した瞬間に少し沈む。それだけでボタンは「触れる物」になる。
// Reanimated は足さず RN 標準の Animated だけで組む（Expo Go 54 でそのまま動く）。
function usePressScale(to: number) {
  const scale = useRef(new Animated.Value(1)).current;
  const spring = (toValue: number) =>
    Animated.spring(scale, {
      toValue,
      friction: 6,
      tension: 260,
      useNativeDriver: true,
    }).start();

  return {
    scale,
    onPressIn: () => spring(to),
    onPressOut: () => spring(1),
  };
}

const RIPPLE_MS = 2600;

// カレンダーのマス。格子・曜日見出し・ドットの3か所でそろえる必要があるため定数で持つ。
// 7マス + 6すきま = 7*20 + 6*15 = 230pt。iPhone SE の内寸 311pt に収まる。
const CELL_SIZE = 20;
const CELL_GAP = 15;

// 何も起きていない画面で唯一動いているものが、押してほしいボタン。
function StartButton({ size, onPress }: { size: number; onPress: () => void }) {
  const { scale, onPressIn, onPressOut } = usePressScale(0.93);
  const ripple1 = useRef(new Animated.Value(0)).current;
  const ripple2 = useRef(new Animated.Value(0)).current;

  // 2本の波紋を半周期ずらして流す。1本だと点滅、2本だと「広がり続けている」に見える。
  useEffect(() => {
    const loops = [ripple1, ripple2].map((value) =>
      Animated.loop(
        Animated.timing(value, {
          toValue: 1,
          duration: RIPPLE_MS,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
      ),
    );

    loops[0].start();
    const offset = setTimeout(() => loops[1].start(), RIPPLE_MS / 2);
    return () => {
      clearTimeout(offset);
      loops.forEach((loop) => loop.stop());
    };
  }, [ripple1, ripple2]);

  const ripple = (value: Animated.Value) => ({
    transform: [{ scale: value.interpolate({ inputRange: [0, 1], outputRange: [1, 1.42] }) }],
    opacity: value.interpolate({ inputRange: [0, 0.15, 1], outputRange: [0, 0.45, 0] }),
  });

  return (
    <Pressable
      onPress={onPress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      accessibilityRole="button"
      accessibilityLabel="10分をはじめる"
      style={[styles.startWrap, { width: size, height: size }]}>
      {/* 外へ広がって消えていく波紋。「ここを押す」を無言で指している。 */}
      <Animated.View
        pointerEvents="none"
        style={[
          styles.startRing,
          { width: size, height: size, borderRadius: size / 2 },
          ripple(ripple1),
        ]}
      />
      <Animated.View
        pointerEvents="none"
        style={[
          styles.startRing,
          { width: size, height: size, borderRadius: size / 2 },
          ripple(ripple2),
        ]}
      />

      <Animated.View
        style={[
          styles.startButton,
          { width: size, height: size, borderRadius: size / 2 },
          { transform: [{ scale }] },
        ]}>
        {/* 上から光が当たっているように見せる面。平面だと押せる物に見えない。
            薄い層を3枚ずらして重ね、境目を1本の線ではなく緩やかな階調にする。 */}
        {[0.3, 0.42, 0.54].map((edge) => (
          <View
            key={edge}
            pointerEvents="none"
            style={[
              styles.startSheen,
              {
                width: size * 1.5,
                height: size * 1.5,
                borderRadius: size * 0.75,
                top: (edge - 1.5) * size,
                left: -size * 0.25,
              },
            ]}
          />
        ))}
        <Text style={styles.startLabel}>はじめる</Text>
        <Text style={styles.startSub}>10:00</Text>
      </Animated.View>
    </Pressable>
  );
}

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
  const { scale, onPressIn, onPressOut } = usePressScale(0.95);

  return (
    <Pressable
      onPress={onPress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      accessibilityRole="button"
      accessibilityLabel={sub === undefined ? undefined : `${label} ${sub}`}
      style={style}>
      <Animated.View style={[styles.primaryButton, { transform: [{ scale }] }]}>
        {/* 丸ボタンと同じ考え方で、高さちがいの層を重ねて境目をぼかす。
            1枚だと濃い青の上で1本の線に見えてしまう。 */}
        {[0.34, 0.44, 0.54].map((height) => (
          <View
            key={height}
            pointerEvents="none"
            style={[styles.primarySheen, { height: `${height * 100}%` }]}
          />
        ))}
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
// 文面は変えていない。
function tipsPages() {
  return [
    <>
      <Text style={styles.tipsTitle}>こんにちは！</Text>
      <Text style={styles.tipsBody}>10分だけ集中するためのアプリです。</Text>
    </>,
    <>
      <Text style={styles.tipsTitle}>やる気は、あとから出てくる</Text>
      <Text style={styles.tipsBody}>
        やる気が出るのを待っていると、だいたい何も始まらないですよね。
        でもやる気って、動く前じゃなくて動いたあとから出てくるみたいですよ！
        つらさのピークは始める前で、手を動かし始めると案外そうでもない、という研究もあります。
      </Text>
    </>,
    <>
      <Text style={styles.tipsTitle}>10分で、わざと止める</Text>
      <Text style={styles.tipsBody}>
        しかも人は、10分で強制的に中断されると続きをやりたくなるそうです。
        終わったあとにもう少しやりたくなったら、それが狙いどおりです。
      </Text>
      <Text style={styles.tipsBody}>このアプリを使って、やるべきことをやりましょう！</Text>
    </>,
    <>
      <Text style={styles.tipsTitle}>ルールは3つだけ</Text>
      <Text style={styles.tipsRule}>1. 途中で止める方法はありません</Text>
      <Text style={styles.tipsRule}>2. アプリを離れると最初からやり直しです</Text>
      <Text style={styles.tipsRule}>3. 動画も音楽もなし。ただ10分、手を動かします</Text>
    </>,
  ];
}

function Tips({ onDismiss }: { onDismiss: () => void }) {
  const { width } = useWindowDimensions();
  const [page, setPage] = useState(0);
  const pager = useRef<ScrollView>(null);
  const pages = tipsPages();
  const lastPage = pages.length - 1;

  // 回転で幅が変わると、ページ何枚ぶんずれた位置に取り残される。合わせ直す。
  useEffect(() => {
    pager.current?.scrollTo({ x: page * width, animated: false });
  }, [width]);

  const goTo = (next: number) => {
    const clamped = Math.max(0, Math.min(lastPage, next));
    setPage(clamped);
    pager.current?.scrollTo({ x: clamped * width, animated: true });
  };

  return (
    <View style={styles.tipsRoot}>
      <ScrollView
        ref={pager}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        // 慣性の終わりではなく位置そのものから今のページを決める。
        // ゆっくり払うと慣性が出ず、onMomentumScrollEnd は来ないことがある。
        scrollEventThrottle={16}
        onScroll={(e) => {
          const next = Math.round(e.nativeEvent.contentOffset.x / width);
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
          onPress={() => (page === lastPage ? onDismiss() : goTo(page + 1))}
        />
      </View>
    </View>
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
  // 同じ秒で何度も鳴らさないための「最後に鳴らした残り秒数」。0 は未再生。
  const countdownRef = useRef(0);

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

  const dismissTips = () => {
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

  const start = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    startPhase('running');
  };

  const startPomodoro = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setPomodoroSet(1);
    startPhase('focus');
  };

  // 横向きは高さが一気に詰まるので、文字も余白も短い辺に合わせて縮める。
  const isLandscape = width > height;
  const gap = isLandscape ? 0.5 : 1;
  const clockSize = Math.min(width * 0.34, height * 0.42);
  // safe-area のライブラリは入れずに済ませる。この余白を使う帯は
  // 縦向きでしか出さないので、縦向きのぶんだけ考えればいい。
  const topInset = Platform.OS === 'android' ? RNStatusBar.currentHeight ?? 0 : 56;
  const streak = streakOf(cleared);
  // 丸ボタンは画面の高さではなく「帯を引いた残り」から決める。全体の高さで
  // 決めると、背の低い端末で下の「つかいかた／きろく」が画面外に出る。
  // 帯の実測ではなく目安でよく、縮めるべきかどうかが分かれば足りる。
  const stripHeight = isLandscape ? 0 : topInset + 110;
  const startSize = Math.min(220, (height - stripHeight) * 0.46);

  if (showTips !== false) {
    return (
      <View style={styles.root}>
        <StatusBar style="dark" />
        {showTips === true && <Tips onDismiss={dismissTips} />}
      </View>
    );
  }

  if (showRecord) {
    return (
      <View style={styles.root}>
        <StatusBar style="dark" />
        <Record cleared={cleared} onDismiss={() => setShowRecord(false)} />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <StatusBar style="dark" hidden={isCounting(status)} />
      {isCounting(status) && <KeepScreenAwake />}

      {/* 連続日数と直近1週間。開かなくても見える位置に置く。
          場所を取る帯なので絶対配置にはしない。重ねると小さい端末で
          「10 MIN」の上に乗ってしまう。ここで高さを取り、残りを中央が使う。
          横向きは縦の余白がないので、この帯ごと出さない。 */}
      {status === 'idle' && !isLandscape && (
        <View style={[styles.streakArea, { paddingTop: topInset + 12 }]}>
          <Pressable
            onPress={() => setShowRecord(true)}
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
        </View>
      )}

      {status === 'idle' && (
        <View style={[styles.center, isLandscape && styles.centerLandscape]}>
          <Text style={[styles.eyebrow, { marginBottom: 48 * gap }]}>10 MIN</Text>
          <StartButton size={startSize} onPress={start} />
          <Text style={[styles.note, { marginTop: 48 * gap }]}>
            動画も音楽もなし。{'\n'}10分だけ、手を動かす。
          </Text>
          {/* 横向きではドット列を出せないので、きろくへの入口はここにも置く。 */}
          <View style={[styles.quietRow, { marginTop: 24 * gap }]}>
            <QuietButton label="つかいかた" onPress={() => setShowTips(true)} />
            <QuietButton label="きろく" onPress={() => setShowRecord(true)} />
          </View>
        </View>
      )}

      {status === 'running' && (
        <View style={[styles.center, isLandscape && styles.centerLandscape]}>
          <Text
            numberOfLines={1}
            adjustsFontSizeToFit
            style={[styles.clock, { fontSize: clockSize }]}>
            {formatRemaining(remainMs)}
          </Text>
          <Text style={[styles.hint, { marginTop: 24 * gap }]}>アプリを離れるとリセット</Text>
        </View>
      )}

      {/* 25分。10分の画面にセット数だけを足す。集中中に増える情報はこれ以上いらない。 */}
      {status === 'focus' && (
        <View style={[styles.center, isLandscape && styles.centerLandscape]}>
          <Text style={[styles.eyebrow, { marginBottom: 16 * gap }]}>
            {pomodoroSet} セットめ
          </Text>
          <Text
            numberOfLines={1}
            adjustsFontSizeToFit
            style={[styles.clock, { fontSize: clockSize }]}>
            {formatRemaining(remainMs)}
          </Text>
          <Text style={[styles.hint, { marginTop: 24 * gap }]}>アプリを離れるとリセット</Text>
        </View>
      )}

      {/* 5分の休憩。時計を薄くして、同じ数字でも「進む時間」に見えないようにする。
          途中で止められないルールの唯一の抜け道がここ。「おわる」はこの5分にしかない。 */}
      {status === 'break' && (
        <View style={[styles.center, isLandscape && styles.centerLandscape]}>
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
          <QuietButton label="おわる" onPress={stop} style={{ marginTop: 32 * gap }} />
        </View>
      )}

      {status === 'done' && (
        <View style={[styles.center, isLandscape && styles.centerLandscape]}>
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
          <QuietButton label="おわる" onPress={stop} style={{ marginTop: 24 * gap }} />
        </View>
      )}

    </View>
  );
}

// ほんのり青みのある明るい灰。純白より目が疲れず、白いカードや
// ボタンの影が沈んで見える。
const BG = '#F3F6FC';
// 黒ではなく濃紺。背景の青みと同じ側に寄せると画面がひとつにまとまる。
const INK = '#16234A';
const TEXT = INK;
const MUTED = 'rgba(22, 35, 74, 0.65)';
// 画面のほとんどが背景と同じ青みの濃淡なので、はっきり色がついているのは
// 「押すところ」だけ。迷いようがない。
// 明るい背景では淡い青は沈むので、暗い背景のときより濃いほうへ振る。
const ACCENT = '#2F6FE4';
const ACCENT_EDGE = '#5B8DEF';
const ON_ACCENT = '#FFFFFF';
const CARD = '#FFFFFF';
// 記録のドットはあえて色を持たせない。ここに青を足すと、押してほしい
// 丸ボタンと目線を取り合ってしまう。記録は眺めるもので、押すものではない。
const DOT_ON = 'rgba(22, 35, 74, 0.72)';
const DOT_OFF = 'rgba(22, 35, 74, 0.1)';
const DOT_TODAY = 'rgba(22, 35, 74, 0.28)';
const WEEKDAY = 'rgba(22, 35, 74, 0.5)';

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
  startWrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  startRing: {
    position: 'absolute',
    borderWidth: 1.5,
    borderColor: ACCENT,
  },
  startButton: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    backgroundColor: ACCENT,
    borderWidth: 1,
    borderColor: ACCENT_EDGE,
    // 暗い背景から浮き上がらせる。押し込みのアニメーションが効いて見える。
    // 強くしすぎると波紋が発光に溶けて見えなくなるので控えめに。
    shadowColor: ACCENT,
    shadowOpacity: 0.4,
    shadowRadius: 26,
    shadowOffset: { width: 0, height: 10 },
    elevation: 14,
  },
  // 濃い青の上では白の層がそのまま縞に見えるので、暗い背景のときより薄くする。
  startSheen: {
    position: 'absolute',
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  startLabel: {
    color: ON_ACCENT,
    fontSize: 28,
    fontWeight: '600',
    letterSpacing: 2,
  },
  startSub: {
    color: 'rgba(255, 255, 255, 0.8)',
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
    overflow: 'hidden',
    backgroundColor: ACCENT,
    borderWidth: 1,
    borderColor: ACCENT_EDGE,
    shadowColor: ACCENT,
    shadowOpacity: 0.34,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
  },
  // 上ほど明るくして厚みを出す。高さは重ねる側で決める。
  primarySheen: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
  },
  primaryLabel: {
    color: ON_ACCENT,
    fontSize: 18,
    fontWeight: '600',
    letterSpacing: 1,
    textAlign: 'center',
  },
  primarySub: {
    color: 'rgba(255, 255, 255, 0.8)',
    fontSize: 12,
    marginTop: 3,
    textAlign: 'center',
  },
  quietPressed: {
    opacity: 0.5,
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
    color: 'rgba(22, 35, 74, 0.4)',
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
    color: 'rgba(22, 35, 74, 0.78)',
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
