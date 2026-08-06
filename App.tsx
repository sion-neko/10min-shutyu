import { useEffect, useRef, useState } from 'react';
import {
  AppState,
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

      <Pressable
        onPress={onDismiss}
        style={({ pressed }) => [styles.tipsButton, pressed && styles.pressed]}>
        <Text style={styles.againLabel}>わかった</Text>
      </Pressable>
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
          <Pressable
            onPress={start}
            style={({ pressed }) => [
              styles.startButton,
              { width: startSize, height: startSize, borderRadius: startSize / 2 },
              pressed && styles.pressed,
            ]}>
            <Text style={styles.startLabel}>はじめる</Text>
          </Pressable>
          <Text style={[styles.note, { marginTop: 48 * gap }]}>
            動画も音楽もなし。{'\n'}10分だけ、手を動かす。
          </Text>
          <Pressable onPress={() => setShowTips(true)} hitSlop={16}>
            <Text style={[styles.quiet, { marginTop: 24 * gap }]}>つかいかた</Text>
          </Pressable>
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
          <Pressable
            onPress={start}
            style={({ pressed }) => [
              styles.againButton,
              { marginTop: 64 * gap },
              pressed && styles.pressed,
            ]}>
            <Text style={styles.againLabel}>もう10分</Text>
          </Pressable>
          <Pressable onPress={() => setStatus('idle')} hitSlop={16}>
            <Text style={[styles.quiet, { marginTop: 24 * gap }]}>おわる</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const TEXT = '#F2F2F0';
const MUTED = 'rgba(242, 242, 240, 0.42)';
const LINE = 'rgba(242, 242, 240, 0.28)';

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
  startButton: {
    borderWidth: 1,
    borderColor: LINE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  startLabel: {
    color: TEXT,
    fontSize: 26,
    fontWeight: '300',
    letterSpacing: 2,
  },
  pressed: {
    opacity: 0.45,
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
  againButton: {
    paddingHorizontal: 40,
    paddingVertical: 16,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: LINE,
  },
  againLabel: {
    color: TEXT,
    fontSize: 18,
    fontWeight: '300',
    letterSpacing: 1,
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
    paddingHorizontal: 40,
    paddingVertical: 16,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: LINE,
  },
});
