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

import {
  WEEKDAY_LABELS,
  WEEK_DAYS,
  countInMonth,
  dayKey,
  lastDays,
  monthLabel,
  monthWeeks,
  monthsToShow,
  parseClearedDays,
  streakOf,
  today,
} from './record';

const DURATION_MS = 10 * 60 * 1000;
const TIPS_SEEN_KEY = 'tipsSeen';
const CLEARED_DAYS_KEY = 'clearedDays';

const PRAISES = [
  'いい集中だ！',
  '10分、やりきった。',
  'よく始めた。\nそれが一番むずかしい。',
  'その調子。',
  '手が止まらないなら、\nもう10分。',
  '今日の自分、悪くない。',
  '10分前の自分に\n感謝しよう。',
];

type Status = 'idle' | 'running' | 'done';

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

// 「もう10分」「わかった」など、次に進むための主ボタン。
function PrimaryButton({
  label,
  onPress,
  style,
}: {
  label: string;
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
      style={style}>
      <Animated.View style={[styles.primaryButton, { transform: [{ scale }] }]}>
        <View pointerEvents="none" style={styles.primarySheen} />
        <Text style={styles.primaryLabel}>{label}</Text>
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

function Tips({ onDismiss }: { onDismiss: () => void }) {
  return (
    <ScrollView style={styles.tipsScroll} contentContainerStyle={styles.tips}>
      <Text style={styles.tipsTitle}>こんにちは！</Text>

      <Text style={styles.tipsBody}>10分だけ集中するためのアプリです。</Text>

      <Text style={styles.tipsBody}>
        やる気が出るのを待っていると、だいたい何も始まらないですよね。
        でもやる気って、動く前じゃなくて動いたあとから出てくるみたいですよ！
        つらさのピークは始める前で、手を動かし始めると案外そうでもない、という研究もあります。
      </Text>

      <Text style={styles.tipsBody}>
        しかも人は、10分で強制的に中断されると続きをやりたくなるそうです。
        終わったあとにもう少しやりたくなったら、それが狙いどおりです。
      </Text>

      <Text style={styles.tipsBody}>このアプリを使って、やるべきことをやりましょう！</Text>

      <Text style={styles.tipsHeading}>ルールは3つだけ</Text>
      <Text style={styles.tipsRule}>1. 途中で止める方法はありません</Text>
      <Text style={styles.tipsRule}>2. アプリを離れると最初からやり直しです</Text>
      <Text style={styles.tipsRule}>3. 動画も音楽もなし。ただ10分、手を動かします</Text>

      <PrimaryButton label="わかった" onPress={onDismiss} style={styles.tipsButton} />
    </ScrollView>
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
      <View style={styles.monthHeader}>
        <Text style={styles.monthLabel}>{monthLabel(year, month)}</Text>
        <Text style={styles.monthCount}>{countInMonth(cleared, year, month)}日</Text>
      </View>

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
                <Dot done={cleared.has(key)} isToday={key === todayKey} size={14} />
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

  return (
    <View style={styles.recordRoot}>
      <ScrollView style={styles.recordScroll} contentContainerStyle={styles.record}>
        <Text style={styles.recordTitle}>きろく</Text>

        <View style={styles.counts}>
          <View style={styles.count}>
            <Text style={styles.countLabel}>連続</Text>
            <Text style={styles.countValue}>
              {streak}
              <Text style={styles.countUnit}> 日</Text>
            </Text>
          </View>
          <View style={styles.count}>
            <Text style={styles.countLabel}>通算</Text>
            <Text style={styles.countValue}>
              {cleared.size}
              <Text style={styles.countUnit}> 日</Text>
            </Text>
          </View>
        </View>

        {/* 曜日はどの月も同じ幅でそろうので、先頭に1つだけ置く。 */}
        <View style={[styles.gridRow, styles.weekdayRow]}>
          {WEEKDAY_LABELS.map((label) => (
            <Text key={label} style={styles.weekdayLabel}>
              {label}
            </Text>
          ))}
        </View>

        {/* 今月が上。下へたどると過去へさかのぼる。 */}
        {monthsToShow(cleared).map(({ year, month }) => (
          <MonthCalendar
            key={`${year}-${month}`}
            year={year}
            month={month}
            cleared={cleared}
            todayKey={todayKey}
          />
        ))}

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
  const [praise, setPraise] = useState(PRAISES[0]);
  // null は読み込み中。一瞬ホーム画面が見えてから Tips が出るのを避ける。
  const [showTips, setShowTips] = useState<boolean | null>(null);
  const [showRecord, setShowRecord] = useState(false);
  const [cleared, setCleared] = useState<Set<string>>(() => new Set());
  const endAtRef = useRef(0);
  // 記録は完了時に読み書きするので、state とは別に最新値を同期で持っておく。
  const clearedRef = useRef<Set<string>>(cleared);
  const chime = useAudioPlayer(require('./assets/chime.wav'));

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
  const playChime = async () => {
    try {
      await chime.seekTo(0);
    } catch {
      // 頭出しに失敗しても鳴らすことを優先する
    }
    chime.play();
  };

  // 残り時間は「終了時刻との差」で毎回求める。setInterval のズレが蓄積しない。
  useEffect(() => {
    if (status !== 'running') return;

    const tick = () => {
      const left = endAtRef.current - Date.now();
      if (left > 0) {
        setRemainMs(left);
        return;
      }
      setRemainMs(0);
      setPraise(PRAISES[Math.floor(Math.random() * PRAISES.length)]);
      setStatus('done');
      recordToday();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      playChime();
    };

    tick();
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [status]);

  // アプリを離れたらタイマーは破棄。10分は10分、途中離脱は最初からやり直し。
  // 'inactive'（通知センターを少し引いた等）は含めない。誤爆が厳しすぎるため。
  useEffect(() => {
    if (status !== 'running') return;
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background') {
        setRemainMs(DURATION_MS);
        setStatus('idle');
      }
    });
    return () => sub.remove();
  }, [status]);

  const start = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    endAtRef.current = Date.now() + DURATION_MS;
    setRemainMs(DURATION_MS);
    setStatus('running');
  };

  // 横向きは高さが一気に詰まるので、文字も余白も短い辺に合わせて縮める。
  const isLandscape = width > height;
  const gap = isLandscape ? 0.5 : 1;
  const clockSize = Math.min(width * 0.34, height * 0.42);
  const startSize = Math.min(220, height * 0.46);
  // safe-area のライブラリは入れずに済ませる。横向きのノッチは左右に来るので
  // 上に必要な余白は縦向きのときだけ。
  const topInset =
    Platform.OS === 'android' ? RNStatusBar.currentHeight ?? 0 : isLandscape ? 12 : 56;

  if (showTips !== false) {
    return (
      <View style={styles.root}>
        <StatusBar style="light" />
        {showTips === true && <Tips onDismiss={dismissTips} />}
      </View>
    );
  }

  if (showRecord) {
    return (
      <View style={styles.root}>
        <StatusBar style="light" />
        <Record cleared={cleared} onDismiss={() => setShowRecord(false)} />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <StatusBar style="light" hidden={status === 'running'} />
      {status === 'running' && <KeepScreenAwake />}

      {status === 'idle' && (
        <View style={[styles.center, isLandscape && styles.centerLandscape]}>
          <Text style={[styles.eyebrow, { marginBottom: 48 * gap }]}>10 MIN</Text>
          <StartButton size={startSize} onPress={start} />
          <Text style={[styles.note, { marginTop: 48 * gap }]}>
            動画も音楽もなし。{'\n'}10分だけ、手を動かす。
          </Text>
          <QuietButton
            label="つかいかた"
            onPress={() => setShowTips(true)}
            style={{ marginTop: 24 * gap }}
          />
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

      {status === 'done' && (
        <View style={[styles.center, isLandscape && styles.centerLandscape]}>
          <Text style={[styles.eyebrow, { marginBottom: 48 * gap }]}>10 MIN 完了</Text>
          <Text style={[styles.praise, isLandscape && styles.praiseLandscape]}>{praise}</Text>
          <PrimaryButton label="もう10分" onPress={start} style={{ marginTop: 64 * gap }} />
          <QuietButton
            label="おわる"
            onPress={() => setStatus('idle')}
            style={{ marginTop: 24 * gap }}
          />
        </View>
      )}

      {/* 直近1週間は開かなくても見える位置に。中央の配置は動かしたくないので絶対配置。
          兄弟は後に書いたほうが上に乗るので、必ず中央のブロックより後ろに置く。
          先に書くと絶対配置でも中央ブロックの下敷きになり、タップが届かない。 */}
      {status === 'idle' && (
        <Pressable
          onPress={() => setShowRecord(true)}
          hitSlop={16}
          accessibilityRole="button"
          accessibilityLabel="きろくを見る"
          style={({ pressed }) => [
            styles.weekStrip,
            { paddingTop: topInset + 12 },
            pressed && styles.quietPressed,
          ]}>
          {lastDays(WEEK_DAYS).map((date, i) => (
            <Dot
              key={dayKey(date)}
              done={cleared.has(dayKey(date))}
              isToday={i === WEEK_DAYS - 1}
              size={8}
            />
          ))}
        </Pressable>
      )}
    </View>
  );
}

const BG = '#0D0D0F';
const TEXT = '#F2F2F0';
const MUTED = 'rgba(242, 242, 240, 0.42)';
// 画面全体が無彩色なので、色がついているのは「押すところ」だけ。迷いようがない。
// 彩度は抑えめ。鮮やかにすると集中前の画面から浮いてしまう。
const ACCENT = '#8FB8FF';
const ACCENT_EDGE = '#B4D0FF';
const ON_ACCENT = '#0A1730';

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
  startSheen: {
    position: 'absolute',
    backgroundColor: 'rgba(255, 255, 255, 0.13)',
  },
  startLabel: {
    color: ON_ACCENT,
    fontSize: 28,
    fontWeight: '600',
    letterSpacing: 2,
  },
  startSub: {
    color: 'rgba(10, 23, 48, 0.5)',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 3,
    marginTop: 6,
    fontVariant: ['tabular-nums'],
  },
  primaryButton: {
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
  // 丸ボタンと同じく、上半分だけ明るくして厚みを出す。
  primarySheen: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: '48%',
    backgroundColor: 'rgba(255, 255, 255, 0.16)',
  },
  primaryLabel: {
    color: ON_ACCENT,
    fontSize: 18,
    fontWeight: '600',
    letterSpacing: 1,
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
  hint: {
    color: 'rgba(242, 242, 240, 0.22)',
    fontSize: 12,
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
  weekStrip: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 10,
    paddingBottom: 12,
  },
  dotDone: {
    backgroundColor: 'rgba(242, 242, 240, 0.85)',
  },
  dotEmpty: {
    backgroundColor: 'rgba(242, 242, 240, 0.13)',
  },
  dotToday: {
    borderWidth: 1,
    borderColor: 'rgba(242, 242, 240, 0.28)',
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
  counts: {
    flexDirection: 'row',
    gap: 56,
    marginBottom: 44,
  },
  count: {
    alignItems: 'center',
  },
  countValue: {
    color: TEXT,
    fontSize: 44,
    fontWeight: '200',
    fontVariant: ['tabular-nums'],
  },
  countLabel: {
    color: MUTED,
    fontSize: 13,
    letterSpacing: 2,
    marginBottom: 8,
  },
  countUnit: {
    fontSize: 16,
    color: MUTED,
  },
  month: {
    alignItems: 'flex-start',
    gap: 12,
    marginBottom: 40,
  },
  // 月見出しはグリッドと同じ幅に広げて、日数を右端にそろえる。
  monthHeader: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: 4,
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
    gap: 12,
  },
  gridCell: {
    width: 14,
    height: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  weekdayRow: {
    marginBottom: 16,
  },
  weekdayLabel: {
    width: 14,
    color: 'rgba(242, 242, 240, 0.3)',
    fontSize: 10,
    textAlign: 'center',
  },
  recordNote: {
    color: MUTED,
    fontSize: 13,
    lineHeight: 22,
    textAlign: 'center',
    marginTop: 8,
  },
  tipsScroll: {
    flex: 1,
  },
  // 横向きやiPadで1行が長くなりすぎないよう幅を頭打ちにして中央に置く。
  // ついでに横向きのノッチも避けられる。
  tips: {
    flexGrow: 1,
    justifyContent: 'center',
    alignSelf: 'center',
    maxWidth: 560,
    paddingHorizontal: 32,
    paddingVertical: 64,
  },
  tipsTitle: {
    color: TEXT,
    fontSize: 30,
    fontWeight: '300',
    marginBottom: 28,
  },
  tipsBody: {
    color: 'rgba(242, 242, 240, 0.78)',
    fontSize: 16,
    lineHeight: 28,
    marginBottom: 20,
  },
  tipsHeading: {
    color: MUTED,
    fontSize: 13,
    letterSpacing: 2,
    marginTop: 12,
    marginBottom: 14,
  },
  tipsRule: {
    color: TEXT,
    fontSize: 16,
    lineHeight: 26,
    marginBottom: 10,
  },
  tipsButton: {
    alignSelf: 'center',
    marginTop: 44,
  },
});
