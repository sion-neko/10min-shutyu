import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  AppState,
  Easing,
  Pressable,
  ScrollView,
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

const DURATION_MS = 10 * 60 * 1000;
const TIPS_SEEN_KEY = 'tipsSeen';

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

export default function App() {
  const { width, height } = useWindowDimensions();
  const [status, setStatus] = useState<Status>('idle');
  const [remainMs, setRemainMs] = useState(DURATION_MS);
  const [praise, setPraise] = useState(PRAISES[0]);
  // null は読み込み中。一瞬ホーム画面が見えてから Tips が出るのを避ける。
  const [showTips, setShowTips] = useState<boolean | null>(null);
  const endAtRef = useRef(0);
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

  if (showTips !== false) {
    return (
      <View style={styles.root}>
        <StatusBar style="light" />
        {showTips === true && <Tips onDismiss={dismissTips} />}
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
    </View>
  );
}

const TEXT = '#F2F2F0';
const MUTED = 'rgba(242, 242, 240, 0.42)';
// 画面全体が無彩色なので、色がついているのは「押すところ」だけ。迷いようがない。
const ACCENT = '#FFA94D';
const ACCENT_EDGE = '#FFC489';
const ON_ACCENT = '#1A1206';

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0D0D0F',
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
    shadowColor: ACCENT,
    shadowOpacity: 0.5,
    shadowRadius: 32,
    shadowOffset: { width: 0, height: 10 },
    elevation: 14,
  },
  startSheen: {
    position: 'absolute',
    backgroundColor: 'rgba(255, 255, 255, 0.09)',
  },
  startLabel: {
    color: ON_ACCENT,
    fontSize: 28,
    fontWeight: '600',
    letterSpacing: 2,
  },
  startSub: {
    color: 'rgba(26, 18, 6, 0.5)',
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
    shadowOpacity: 0.4,
    shadowRadius: 22,
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
