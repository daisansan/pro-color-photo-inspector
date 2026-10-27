/**
 * 縮小した絵に、ごく弱いシャープ（アンシャープマスク）をかける。
 * 縮小で失われた細部の「くっきり感」を少し戻すためのもの。元の写真には影響しない（表示用の絵だけ）。
 *
 * ぼかし(横→縦の [1 2 1]/4) との差を amount 倍して足す。amount は 0〜1 程度（0で何もしない）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Sharpen = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function sharpen(data, w, h, amount) {
    if (!(amount > 0) || w < 3 || h < 3) return data;
    const amt = Math.round(amount * 256);
    const tmp = new Uint8ClampedArray(data.length);
    const stride = w * 4;

    // 横方向のぼかし
    for (let y = 0; y < h; y++) {
      const row = y * stride;
      for (let x = 0; x < w; x++) {
        const i = row + x * 4;
        const l = x > 0 ? i - 4 : i;
        const r = x < w - 1 ? i + 4 : i;
        tmp[i] = (data[l] + 2 * data[i] + data[r] + 2) >> 2;
        tmp[i + 1] = (data[l + 1] + 2 * data[i + 1] + data[r + 1] + 2) >> 2;
        tmp[i + 2] = (data[l + 2] + 2 * data[i + 2] + data[r + 2] + 2) >> 2;
      }
    }
    // 縦方向のぼかしと、元との差の加算（その場で data に書き込む。tmp は横ぼかし済みの値のまま）
    for (let y = 0; y < h; y++) {
      const up = (y > 0 ? y - 1 : y) * stride;
      const cur = y * stride;
      const dn = (y < h - 1 ? y + 1 : y) * stride;
      for (let x = 0; x < w; x++) {
        const o = x * 4;
        for (let c = 0; c < 3; c++) {
          const blur = (tmp[up + o + c] + 2 * tmp[cur + o + c] + tmp[dn + o + c] + 2) >> 2;
          const v = data[cur + o + c];
          data[cur + o + c] = v + (((v - blur) * amt) >> 8);   // Uint8ClampedArray: 0〜255に収まる
        }
      }
    }
    return data;
  }

  return { sharpen };
});
