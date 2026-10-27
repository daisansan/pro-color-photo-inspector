/**
 * モニタープロファイル(ICC)の読み込みと、画面の色への変換。
 *
 * 対応: matrix/TRC 型のRGBプロファイル（rXYZ/gXYZ/bXYZ + rTRC/gTRC/bTRC を持つもの）。
 *       Windowsのキャリブレーションで作られる多くのモニタープロファイルがこの形式です。
 * 非対応: LUT型（A2B0/B2A0のみで行列を持たない）のプロファイル。読み込み時に分かるようにエラーを返します。
 *
 * 変換: 画像の色(sRGB / Display P3) → 線形RGB → XYZ(D50) → モニターの線形RGB → モニターの階調(逆TRC)
 * ブラウザ(file://)でもNode(テスト)でも読み込めるようにしています。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ICC = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- 行列の基本
  const mul3 = (a, b) => {
    const r = new Array(9);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
      }
    }
    return r;
  };

  const mulVec = (m, v) => [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];

  function inv3(m) {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (!isFinite(det) || Math.abs(det) < 1e-12) throw new Error('行列が逆変換できません');
    return [
      A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
      B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
      C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
    ];
  }

  const xyToXYZ = (x, y) => [x / y, 1, (1 - x - y) / y];

  // 色度座標から「RGB(線形) → XYZ」の行列を作る
  function rgbToXyzMatrix(r, g, b, white) {
    const R = xyToXYZ(r[0], r[1]), G = xyToXYZ(g[0], g[1]), B = xyToXYZ(b[0], b[1]);
    const P = [R[0], G[0], B[0], R[1], G[1], B[1], R[2], G[2], B[2]];
    const S = mulVec(inv3(P), white);
    return [
      P[0] * S[0], P[1] * S[1], P[2] * S[2],
      P[3] * S[0], P[4] * S[1], P[5] * S[2],
      P[6] * S[0], P[7] * S[1], P[8] * S[2],
    ];
  }

  // Bradford色順応（D65 → D50）
  const BRADFORD = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];
  function adaptMatrix(srcWhite, dstWhite) {
    const s = mulVec(BRADFORD, srcWhite);
    const d = mulVec(BRADFORD, dstWhite);
    const scale = [d[0] / s[0], 0, 0, 0, d[1] / s[1], 0, 0, 0, d[2] / s[2]];
    return mul3(inv3(BRADFORD), mul3(scale, BRADFORD));
  }

  const D65 = xyToXYZ(0.3127, 0.3290);
  const D50 = [0.9642, 1.0, 0.8249]; // ICCのPCS白色点

  const SOURCE_SPACES = {
    srgb: { r: [0.64, 0.33], g: [0.30, 0.60], b: [0.15, 0.06] },
    'display-p3': { r: [0.68, 0.32], g: [0.265, 0.69], b: [0.15, 0.06] },
  };

  // 画像側の色空間 → XYZ(D50) の行列
  function sourceToXyzD50(name) {
    const sp = SOURCE_SPACES[name] || SOURCE_SPACES.srgb;
    return mul3(adaptMatrix(D65, D50), rgbToXyzMatrix(sp.r, sp.g, sp.b, D65));
  }

  // sRGB / Display P3 共通の階調（sRGB伝達関数）
  const srgbToLinear = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));

  // ---------------------------------------------------------------- ICC読み込み
  const sig = (dv, o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  const s15 = (dv, o) => dv.getInt32(o, false) / 65536;

  function readDesc(dv, off, size) {
    try {
      const type = sig(dv, off);
      if (type === 'desc') {
        const n = dv.getUint32(off + 8, false);
        let s = '';
        for (let i = 0; i < n - 1 && i < size; i++) s += String.fromCharCode(dv.getUint8(off + 12 + i));
        return s.trim();
      }
      if (type === 'mluc') {
        const count = dv.getUint32(off + 8, false);
        if (count < 1) return '';
        const len = dv.getUint32(off + 20, false);
        const o = dv.getUint32(off + 24, false);
        let s = '';
        for (let i = 0; i < len; i += 2) s += String.fromCharCode(dv.getUint16(off + o + i, false));
        return s.trim();
      }
    } catch (e) { /* 読めなければ空 */ }
    return '';
  }

  function readXYZ(dv, off) {
    if (sig(dv, off) !== 'XYZ ') throw new Error('XYZタグの形式が不正です');
    return [s15(dv, off + 8), s15(dv, off + 12), s15(dv, off + 16)];
  }

  // 階調カーブ（0..1 → 線形0..1）を関数として返す
  function readCurve(dv, off) {
    const type = sig(dv, off);
    if (type === 'curv') {
      const n = dv.getUint32(off + 8, false);
      if (n === 0) return (x) => x;
      if (n === 1) {
        const g = dv.getUint16(off + 12, false) / 256;
        return (x) => Math.pow(x, g);
      }
      const t = new Float64Array(n);
      for (let i = 0; i < n; i++) t[i] = dv.getUint16(off + 12 + i * 2, false) / 65535;
      return (x) => {
        const p = Math.min(Math.max(x, 0), 1) * (n - 1);
        const i = Math.min(Math.floor(p), n - 2);
        return t[i] + (t[i + 1] - t[i]) * (p - i);
      };
    }
    if (type === 'para') {
      const ft = dv.getUint16(off + 8, false);
      const p = [];
      const counts = [1, 3, 4, 5, 7];
      if (ft > 4) throw new Error('未対応のパラメトリックカーブです');
      for (let i = 0; i < counts[ft]; i++) p.push(s15(dv, off + 12 + i * 4));
      const [g, a, b, c, d, e, f] = p;
      switch (ft) {
        case 0: return (x) => Math.pow(Math.max(x, 0), g);
        case 1: return (x) => (x >= -b / a ? Math.pow(a * x + b, g) : 0);
        case 2: return (x) => (x >= -b / a ? Math.pow(a * x + b, g) + c : c);
        case 3: return (x) => (x >= d ? Math.pow(a * x + b, g) : c * x);
        default: return (x) => (x >= d ? Math.pow(a * x + b, g) + e : c * x + f);
      }
    }
    throw new Error('階調カーブの形式が不正です');
  }

  /** ICCファイルを読み込む。使えない場合は Error を投げる（メッセージは利用者向けの日本語）。 */
  function parseProfile(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (u8.length < 132) throw new Error('プロファイルのファイルが小さすぎます');
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (sig(dv, 36) !== 'acsp') throw new Error('ICCプロファイルではありません');

    const colorSpace = sig(dv, 16);
    if (colorSpace !== 'RGB ') throw new Error('RGB用のプロファイルではありません（' + colorSpace.trim() + '）');

    const tagCount = dv.getUint32(128, false);
    if (tagCount > 1000 || 132 + tagCount * 12 > u8.length) throw new Error('プロファイルの構造が不正です');
    const tags = {};
    for (let i = 0; i < tagCount; i++) {
      const o = 132 + i * 12;
      const off = dv.getUint32(o + 4, false);
      const size = dv.getUint32(o + 8, false);
      if (off + size <= u8.length) tags[sig(dv, o)] = { off, size };
    }

    const need = ['rXYZ', 'gXYZ', 'bXYZ', 'rTRC', 'gTRC', 'bTRC'];
    const missing = need.filter((t) => !tags[t]);
    if (missing.length) {
      throw new Error('このプロファイルはLUT型のため未対応です（行列/階調カーブ型のプロファイルに対応しています）');
    }

    const r = readXYZ(dv, tags.rXYZ.off);
    const g = readXYZ(dv, tags.gXYZ.off);
    const b = readXYZ(dv, tags.bXYZ.off);
    const curves = {
      r: readCurve(dv, tags.rTRC.off),
      g: readCurve(dv, tags.gTRC.off),
      b: readCurve(dv, tags.bTRC.off),
    };

    // 参考情報（画面表示用）
    const sample = (c, x) => c(x);
    const gammaOf = (c) => {
      const y = sample(c, 0.5);
      return y > 0 && y < 1 ? Math.log(y) / Math.log(0.5) : NaN;
    };
    const chroma = (v) => { const s = v[0] + v[1] + v[2]; return [v[0] / s, v[1] / s]; };

    return {
      description: tags.desc ? readDesc(dv, tags.desc.off, tags.desc.size) : '',
      matrix: [r[0], g[0], b[0], r[1], g[1], b[1], r[2], g[2], b[2]], // 線形RGB → XYZ(D50)
      curves,
      info: {
        gamma: [gammaOf(curves.r), gammaOf(curves.g), gammaOf(curves.b)],
        primaries: { r: chroma(r), g: chroma(g), b: chroma(b) },
      },
    };
  }

  // ---------------------------------------------------------------- 変換
  const ENC_SIZE = 65536;

  // 線形値(0..1) → モニターの8bit値 の対応表を作る（カーブの逆関数）
  function buildEncodeTable(curve) {
    const table = new Uint8Array(ENC_SIZE);
    let lo = 0;
    // 順方向カーブを粗くサンプリングして逆引き（単調増加を前提）
    const N = 4096;
    const xs = new Float64Array(N + 1);
    for (let i = 0; i <= N; i++) xs[i] = curve(i / N);
    for (let k = 0; k < ENC_SIZE; k++) {
      const y = k / (ENC_SIZE - 1);
      while (lo < N && xs[lo + 1] < y) lo++;
      let x;
      if (lo >= N) x = 1;
      else {
        const y0 = xs[lo], y1 = xs[lo + 1];
        const t = y1 > y0 ? (y - y0) / (y1 - y0) : 0;
        x = (lo + Math.min(Math.max(t, 0), 1)) / N;
      }
      table[k] = Math.max(0, Math.min(255, Math.round(x * 255)));
    }
    return table;
  }

  /**
   * 変換器を作る。
   * @param profile parseProfile の結果
   * @param source  'srgb' | 'display-p3'（変換前の画像データの色空間）
   */
  function createTransform(profile, source) {
    const toXyz = sourceToXyzD50(source);
    const m = mul3(inv3(profile.matrix), toXyz); // 画像の線形RGB → モニターの線形RGB

    const lin = new Float32Array(256);
    for (let i = 0; i < 256; i++) lin[i] = srgbToLinear(i / 255);

    const encR = buildEncodeTable(profile.curves.r);
    const encG = buildEncodeTable(profile.curves.g);
    const encB = buildEncodeTable(profile.curves.b);
    const K = ENC_SIZE - 1;

    /** RGBA(8bit) の配列を変換して dst に書く。src と dst は同じ配列でもよい。 */
    function apply(src, dst, start = 0, end = src.length) {
      const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = m;
      for (let i = start; i < end; i += 4) {
        const r = lin[src[i]], g = lin[src[i + 1]], b = lin[src[i + 2]];
        let R = m0 * r + m1 * g + m2 * b;
        let G = m3 * r + m4 * g + m5 * b;
        let B = m6 * r + m7 * g + m8 * b;
        R = R < 0 ? 0 : R > 1 ? 1 : R;
        G = G < 0 ? 0 : G > 1 ? 1 : G;
        B = B < 0 ? 0 : B > 1 ? 1 : B;
        dst[i] = encR[(R * K + 0.5) | 0];
        dst[i + 1] = encG[(G * K + 0.5) | 0];
        dst[i + 2] = encB[(B * K + 0.5) | 0];
        dst[i + 3] = src[i + 3];
      }
    }

    return { apply, matrix: m };
  }

  return { parseProfile, createTransform, sourceToXyzD50, rgbToXyzMatrix, adaptMatrix, mul3, inv3, D50, D65 };
});
