// 休憩明けのカウントダウン音(「ぽん」1打)を生成して assets/pon.wav に書き出す。
// 終了チャイム(gen-chime.js)と同じく、外部音源に頼らず作り直せるようにしておく。
const fs = require('fs');
const path = require('path');

const SAMPLE_RATE = 44100;
const DURATION = 0.35;
const TOTAL = Math.floor(SAMPLE_RATE * DURATION);

// 木のバチで叩いたような丸い1打。チャイム(A5/E6)より低い E5 にして、
// 最後の「ぽーーーん」が上に抜けて聞こえるようにする。
const FREQ = 659.25;
const partials = [
  { mul: 1, amp: 1.0, tau: 0.11 },
  { mul: 2, amp: 0.22, tau: 0.05 },
  { mul: 3.9, amp: 0.05, tau: 0.02 }, // 叩いた瞬間の「こつ」だけ足す
];

const samples = new Float32Array(TOTAL);
let peak = 0;
for (let i = 0; i < TOTAL; i++) {
  const t = i / SAMPLE_RATE;
  let v = 0;
  for (const p of partials) {
    v += p.amp * Math.exp(-t / p.tau) * Math.sin(2 * Math.PI * FREQ * p.mul * t);
  }
  v *= Math.min(1, t / 0.003); // 立ち上がりのクリック音を防ぐ
  v *= Math.min(1, (DURATION - t) / 0.05); // 末尾のブツ切りを防ぐ
  samples[i] = v;
  peak = Math.max(peak, Math.abs(v));
}

// チャイムより少し控えめ。数えるための音であって、知らせる音ではない。
const norm = 0.55 / peak;
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

const out = path.resolve(__dirname, process.argv[2] || 'pon.wav');
fs.writeFileSync(out, Buffer.concat([header, data]));
console.log('wrote', out, Buffer.concat([header, data]).length, 'bytes');
