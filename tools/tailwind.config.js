/** Tailwind CSS v3 設定（HTMLとJSを走査して、使われているクラスだけのCSSを作ります） */
module.exports = {
  // relative: true にすると、実行した場所ではなくこの設定ファイルからの相対パスになります
  content: { relative: true, files: ['../src/index.html', '../src/foldertree.js', '../src/display.js'] },
  theme: { extend: {} },
  plugins: [],
};
