/**
 * README.md のページ内リンク（目次・言語切り替え）を検証するスクリプト。
 *
 * VS Code の拡張機能詳細ページでは、見出しから自動生成される ID（絵文字・日本語を含む）や
 * `<a name="...">` ではページ内ジャンプが機能しない場合があるため、本プロジェクトでは
 * 見出しの直前に ASCII の `<a id="..."></a>` を明示的に置く規約としている。
 *
 * 検証内容:
 *   1. `##` / `###` 見出しの直前の行に `<a id="..."></a>` があること（付け忘れ防止）
 *   2. `<a id="...">` の ID が ASCII（英小文字・数字・ハイフン）で、重複していないこと
 *   3. ページ内リンク `](#xxx)` / `href="#xxx"` のリンク先が明示的な ID として存在すること
 *
 * Usage: node scripts/check-readme-anchors.js [README.md のパス]
 */
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
// 引数はカレントディレクトリ基準、省略時はリポジトリ直下の README.md
const readmePath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(rootDir, 'README.md');

// ID の付与を必須とする見出しレベル（`##` と `###`）
const REQUIRED_HEADING = /^#{2,3}\s/;
const ANCHOR_LINE = /^<a id="([^"]+)"><\/a>\s*$/;
const VALID_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// フェンス行（CommonMark 準拠: 最大 3 スペースのインデント + 3 個以上の ` または ~）
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
// コードスパン（開始と終了のバッククォート列の長さが一致するもの）
const CODE_SPAN = /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g;
// 独立した id 属性（`data-id` などは除外するため、直前に空白を要求する）
const ANCHOR_ID = /<a\s(?:[^>]*\s)?id="([^"]+)"/g;
// ページ内リンク: Markdown `](#xxx)` / `](#xxx "タイトル")` と HTML `href="#xxx"`
const PAGE_LINK = /\]\(\s*#([^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)|href="#([^"]+)"/g;

const lines = fs.readFileSync(readmePath, 'utf8').split(/\r?\n/);
const errors = [];
const ids = new Map(); // id -> 行番号
const links = []; // { id, line }

let fence = null; // フェンス内の場合は { char, length }
lines.forEach((line, index) => {
  const lineNo = index + 1;
  const fenceMatch = line.match(FENCE_LINE);

  // フェンスドコードブロック内は検証対象外。
  // 開始時と同じ記号で、同じ長さ以上、かつ記号の後が空白のみの行でだけ閉じる
  if (fence) {
    if (
      fenceMatch &&
      fenceMatch[1][0] === fence.char &&
      fenceMatch[1].length >= fence.length &&
      fenceMatch[2].trim() === ''
    ) {
      fence = null;
    }
    return;
  }
  // バッククォートのフェンスは情報文字列にバッククォートを含められない（CommonMark）
  if (fenceMatch && !(fenceMatch[1][0] === '`' && fenceMatch[2].includes('`'))) {
    fence = { char: fenceMatch[1][0], length: fenceMatch[1].length };
    return;
  }

  // インラインコード内の記述は説明文として扱い、検証対象外とする
  const text = line.replace(CODE_SPAN, '');

  for (const match of text.matchAll(ANCHOR_ID)) {
    const id = match[1];
    if (!VALID_ID.test(id)) {
      errors.push(`L${lineNo}: ID "${id}" は ASCII の英小文字・数字・ハイフンのみで記述してください`);
    }
    if (ids.has(id)) {
      errors.push(`L${lineNo}: ID "${id}" が重複しています（初出: L${ids.get(id)}）`);
    } else {
      ids.set(id, lineNo);
    }
  }

  for (const match of text.matchAll(PAGE_LINK)) {
    links.push({ id: match[1] || match[2], line: lineNo });
  }

  if (REQUIRED_HEADING.test(line)) {
    const prev = index > 0 ? lines[index - 1] : '';
    if (!ANCHOR_LINE.test(prev)) {
      errors.push(`L${lineNo}: 見出し "${line.trim()}" の直前に <a id="..."></a> がありません`);
    }
  }
});

for (const link of links) {
  if (!ids.has(link.id)) {
    errors.push(`L${link.line}: リンク先 "#${link.id}" に対応する <a id="${link.id}"> がありません`);
  }
}

const relPath = path.relative(rootDir, readmePath);
const summary = errors.length === 0
  ? `### README アンカーチェック: 成功\n\n\`${relPath}\`: ${links.length} 件のリンク、${ids.size} 件の ID を検証しました。\n`
  : `### README アンカーチェック: 失敗\n\n${errors.map((e) => `- ${e}`).join('\n')}\n`;

// GitHub Actions 上では実行結果をジョブサマリーにも出力する
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`, 'utf8');
}

if (errors.length > 0) {
  console.error(`README anchor check FAILED (${relPath}):`);
  errors.forEach((e) => console.error(`  ${e}`));
  process.exit(1);
}
console.log(`README anchor check PASSED (${relPath}): ${links.length} links, ${ids.size} ids.`);
