/**
 * 表示だけの補正（明るさ・コントラスト・色温度・色合い・彩度・シャドウ・ハイライト）。
 * 元の写真のファイルや、書き出し、星・Pickの保存には一切影響しない。画面に出す直前の絵にだけかける。
 *
 * 画素ごとの計算を避けるため、チャンネルごとに256段の変換表(LUT)を作って引く。
 * 彩度だけは画素ごとの計算(明るさとの混ぜ合わせ)が必要。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Adjust = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULTS = Object.freeze({ exposure: 0, contrast: 0, temp: 0, tint: 0, sat: 0, shadows: 0, highlights: 0 });
  // exposure は 1/100 EV 単位 (-300〜300)。ほかは -100〜100。

  const toLin = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  const toEnc = (l) => (l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055);
  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

  function isIdentity(p) {
    return Object.keys(DEFAULTS).every((k) => !p || !p[k]);
  }

  function buildLuts(p) {
    const q = Object.assign({}, DEFAULTS, p || {});
    const ev = Math.pow(2, q.exposure / 100);
    const t = q.temp / 100, m = q.tint / 100;
    // 色温度: +で黄色っぽく(赤を増やし青を減らす)、-で青っぽく。色合い: +でマゼンタ寄り、-で緑寄り
    const gain = [
      ev * (1 + 0.28 * t) * (1 + 0.07 * m),
      ev * (1 - 0.20 * m) * (1 + 0.04 * t),
      ev * (1 - 0.28 * t) * (1 + 0.07 * m),
    ];
    const c = q.contrast;
    const k = c >= 0 ? 1 + c / 50 : 1 + c / 110;
    const sh = (q.shadows / 100) * 0.3, hl = (q.highlights / 100) * 0.3;
    const luts = [new Uint8ClampedArray(256), new Uint8ClampedArray(256), new Uint8ClampedArray(256)];
    for (let ch = 0; ch < 3; ch++) {
      for (let i = 0; i < 256; i++) {
        let x = toEnc(clamp01(toLin(i / 255) * gain[ch]));
        x = (x - 0.5) * k + 0.5;
        x = clamp01(x);
        // シャドウ(暗部が山)・ハイライト(明部が山)のなだらかな持ち上げ/引き下げ
        const ws = 6.75 * x * (1 - x) * (1 - x);
        const wh = 6.75 * x * x * (1 - x);
        x = clamp01(x + sh * ws + hl * wh);
        luts[ch][i] = Math.round(x * 255);
      }
    }
    return { r: luts[0], g: luts[1], b: luts[2], sat: Math.max(0, 1 + q.sat / 100) };
  }

  // RGBA(Uint8ClampedArray)に、その場で補正をかける
  function apply(data, luts) {
    const R = luts.r, G = luts.g, B = luts.b, s = luts.sat;
    const n = data.length;
    if (s === 1) {
      for (let i = 0; i < n; i += 4) { data[i] = R[data[i]]; data[i + 1] = G[data[i + 1]]; data[i + 2] = B[data[i + 2]]; }
    } else {
      for (let i = 0; i < n; i += 4) {
        const r = R[data[i]], g = G[data[i + 1]], b = B[data[i + 2]];
        const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        data[i] = l + (r - l) * s;       // Uint8ClampedArrayなので0〜255に丸められる
        data[i + 1] = l + (g - l) * s;
        data[i + 2] = l + (b - l) * s;
      }
    }
    return data;
  }

  return { DEFAULTS, isIdentity, buildLuts, apply };
});
