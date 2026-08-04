// 終了チャイム(A5 -> E6 のベル2打)を生成して assets/chime.wav に書き出す。
// 外部音源に依存せず、リポジトリだけで音を再生成できるようにするためのスクリプト。
const fs = require('fs');
const path = require('path');

const SAMPLE_RATE = 44100;
const DURATION = 2.0;
const TOTAL = Math.floor(SAMPLE_RATE * DURATION);

// ベル1打分の波形: 基音 + 倍音、倍音ほど速く減衰させる
function bell(t, freq) {
  if (t < 0) return 0;
  const partials = [
    { mul: 1, amp: 1.0, tau: 0.55 },
    { mul: 2, amp: 0.32, tau: 0.32 },
    { mul: 3.01, amp: 0.14, tau: 0.2 },
    { mul: 4.2, amp: 0.06, tau: 0.12 },
  ];
  let v = 0;
  for (const p of partials) {
    v += p.amp * Math.exp(-t / p.tau) * Math.sin(2 * Math.PI * freq * p.mul * t);
  }
  const attack = Math.min(1, t / 0.004); // 立ち上がりのクリック音を防ぐ
  return v * attack;
}

const strikes = [
  { at: 0.0, freq: 880.0, gain: 0.9 },   // A5
  { at: 0.24, freq: 1318.51, gain: 1.0 }, // E6
];

const samples = new Float32Array(TOTAL);
let peak = 0;
for (let i = 0; i < TOTAL; i++) {
  const t = i / SAMPLE_RATE;
  let v = 0;
  for (const s of strikes) v += s.gain * bell(t - s.at, s.freq);
  const fadeOut = Math.min(1, (DURATION - t) / 0.15); // 末尾のブツ切りを防ぐ
  v *= fadeOut;
  samples[i] = v;
  peak = Math.max(peak, Math.abs(v));
}

const norm = 0.72 / peak;
const data = Buffer.alloc(TOTAL * 2);
for (let i = 0; i < TOTAL; i++) {
  const v = Math.max(-1, Math.min(1, samples[i] * norm));
  data.writeInt16LE(Math.round(v * 32767), i * 2);
}

const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + data.length, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20); // PCM
header.writeUInt16LE(1, 22); // モノラル
header.writeUInt32LE(SAMPLE_RATE, 24);
header.writeUInt32LE(SAMPLE_RATE * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36);
header.writeUInt32LE(data.length, 40);

const out = path.resolve(__dirname, process.argv[2] || 'chime.wav');
fs.writeFileSync(out, Buffer.concat([header, data]));
console.log('wrote', out, Buffer.concat([header, data]).length, 'bytes');
