# SkillMap-Solo

**Agent Skills の「関係性」と「読み込みコスト」を見える化する VS Code 拡張機能**

![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)

SKILL.md から参照されるファイル群（references / scripts / Steering など）は、ディレクトリ階層ではなく**参照の関係**でつながっています。SkillMap-Solo はその関係をエクスプローラーにツリー表示し、各ファイルの推定トークン数と、ベストプラクティスから外れた箇所への警告（Tips 付き）を知らせます。

100% ローカル処理・トラッキングなし・依存ゼロ。外部送信は一切しません。

## なぜ作ったか

AI 関連ファイル（Skills / Steering / Specs）は書き慣れない形式のため、保守がおろそかになりがちです。症状は「壊れた」ではなく「**なぜか精度が落ちてきた**」という形で現れます。

- 参照したつもりのファイルが、実はどこからも辿れない（死蔵）
- SKILL.md が肥大化し、毎回の読み込みコストが膨らんでいる
- 正本と複製（Copilot 用 / Kiro 用）がいつの間にか乖離している

SkillMap-Solo は、こうした「静かな劣化」にフィードバックを返すための道具です。

## 主な機能

### 参照関係ツリー（Explorer の「SkillMap」ビュー）

- ルートはスキル単位。親子はディレクトリではなく**参照**で組みます
- ノードに推定トークン数を表示。ホバーで「配下合計」、選択するとステータスバーに「SKILL.md からそのノードまでの**経路合計**」を表示
- ルートにはスキル全体の合計（重複排除後）と、L1/L2/L3… の階層別内訳
- 複数箇所から参照されるファイルには「共有」バッジ
- 循環参照・参照切れ・未参照ファイル（孤立）をそれぞれ専用の見た目で表示
- スキルディレクトリの外（例: `.kiro/steering/`）への参照は「境界」バッジ付きでたどります（現場の「references の先に Steering」構成に対応）

### 正本と複製（`.agents/` 運用対応）

`.agents/` に正本を作り、`.kiro/` と `.github/` へ自動複製する運用を前提に設計しています。

- 同一スキルは1つにグルーピングし、正本を代表表示、複製は配下にまとめます
- 警告ルールは正本にのみ適用（複製は直しても上書きされるため）
- 代わりに、正本と複製の**乖離（ドリフト）**を検出します（ファイルの不足・不一致・余分）

### 警告と Tips（実践しながら理解する）

警告には必ず Tips が付きます。ホバーで原則を1文で示し、クリックで全文（原則・直し方・良／悪例）を開きます。

| # | ルール | 既定 |
|---|---|---|
| R1 | name の形式（64文字・小文字英数とハイフン・ディレクトリ名と一致） | 仕様 |
| R2 | description の有無と長さ（1,024文字以内） | 仕様 |
| R3 | description に「いつ使うか」の手がかりがあるか | info |
| R4 | SKILL.md 本文の行数（500行以内） | warn |
| R5 | SKILL.md の推定トークン（5,000 以内） | warn |
| R6 | 参照の深さ（スキル内は2まで。境界でカウント停止） | warn |
| R7 | 参照切れ | error |
| R8 | 循環参照 | warn |
| R9 | 未参照ファイル（孤立） | info |
| R10 | スキル全体のトークン予算 | 任意（既定 off） |
| R11 | 正本と複製の乖離（ドリフト） | warn |

一部の警告は Problems パネルにも表示されます（R9 を除く）。

## 設定（settings.json）

```jsonc
{
  "skillmap.canonicalRoots": [".agents"],   // 正本とみなす配置（優先順）
  "skillmap.skillsRoots": [],               // 追加で探索するディレクトリ
  "skillmap.rules.skillBodyMaxLines": 500,
  "skillmap.rules.skillBodyMaxTokens": 5000,
  "skillmap.rules.descriptionMaxLength": 1024,
  "skillmap.rules.maxReferenceDepth": 2,
  "skillmap.rules.skillTotalTokenBudget": 0, // 0 = R10 無効
  "skillmap.rules.orphanFiles": "info"       // off / info / warn
}
```

## 仕様メモ

- 探索範囲はワークスペース内のみ（個人用ディレクトリは将来対応予定）
- 推定トークンは文字数ベースの概算です（日本語 ≒ 1文字1トークン、英数字 ≒ 4文字1トークン）。「推定」と割り切って設計判断の目安に使ってください
- 参照として辿るのは Markdown リンクと、実在ファイルに解決できるコードスパン中のパスです
- ディレクトリへの参照は末端として扱い、中身は展開しません

## ロードマップ

- v2: Kiro Steering / Specs 対応（inclusion の可視化、ツール別ロード範囲の表示）
- 将来: Copilot instructions、AGENTS.md 等の汎用 AI コンテキストファイル対応、Tips の Webview 表示

## 開発

```bash
npm install
npm run compile   # 型チェック + バンドル
npm test          # 純粋モジュールの単体テスト（Extension Host 不要）
```

## License

MIT © Masanori Satake

---

## English (summary)

SkillMap-Solo visualizes Agent Skills as a **reference-relationship tree** in the VS Code Explorer — not by directory layout, but by how files actually reference each other (SKILL.md → references → steering documents and beyond). Each node shows an estimated token count; selecting a node shows the cumulative token cost along the path from SKILL.md. Best-practice violations (name/description spec checks, oversized SKILL.md, deep nesting, broken or circular references, orphaned files, and drift between a canonical skill and its auto-copied replicas for Copilot/Kiro) are surfaced as warnings, each with a Tip that explains the principle and how to fix it, so you learn while you practise. 100% local, no tracking, zero runtime dependencies.
