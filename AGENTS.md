# AGENTS.md

このファイルは、本リポジトリで作業を行うAIエージェント（Jules等）向けの開発・運用ガイドラインです。

## 📌 バージョン更新およびリリースルール（必須）

本プロジェクトでは、コードやドキュメント（VSIXに含まれる全ファイル）に修正・機能拡張・不具合修正を行う際、**必ず適切なバージョン昇格（インクリメント）を行うこと**が義務付けられています。
pre-commit フックおよび CI にてバージョン更新チェックが実行されます。

### 1. バージョン選択基準 (SemVer)
修正内容に応じて、以下の規則でバージョンを更新してください：

- **マイナーバージョン (`X.Y.Z` -> `X.(Y+1).0`)**:
  - 新機能の追加、既存機能の拡張、仕様変更などの場合
- **パッチバージョン (`X.Y.Z` -> `X.Y.(Z+1)`)**:
  - 不具合修正（バグフィックス）、軽微なUI調整、`README.md` などのパッケージ包含ドキュメントの更新の場合

※例外：`.vscode/`, `.vscode-test/`, `.github/`, `docs/`, `scripts/`, `.gitignore`, `tsconfig.json` 等のVSIXパッケージ外の開発用設定・ドキュメントのみの更新の場合はバージョン昇格不要です。

### 2. バージョン更新手順
コードまたはドキュメントを修正したら、提出前（コミット前）に以下の関連ファイルのバージョンを一括して更新してください（`npm run update-version <X.Y.Z>` で自動化されています）：
- `package.json` (`"version"`)
- `package-lock.json` (`"version"` および `"packages[''].version"`)
- `README.md` (バッジおよび本文のバージョン表記)
- `CHANGELOG.md` (`## [X.Y.Z]` 形式のヘッダー追加)

### 3. CHANGELOG.md の記述
バージョン更新後、`CHANGELOG.md` に新しいリリース項目（`## [X.Y.Z]`）を追加し、行った変更内容の概要を**日本語**でわかりやすく記述・更新してください。

## 🔒 設計原則（変更不可）

- **100%ローカル処理**： ネットワーク通信を行わない。解析はすべてユーザーのマシン内で完結する。
- **トラッキングなし**： テレメトリ・解析送信を一切行わない。
- **依存ゼロ志向**： 実行時依存パッケージを持たない（devDependencies のみ）。標準ライブラリと VS Code API で実装する。
- **推定値の明示**： トークン数は文字種ベースの推定であり、表示では必ず「≈（推定）」と分かる形にする。実測値のように見せない。
- **読み取り専用**： ユーザーのファイルを変更しない。編集支援は将来機能であり、明示的な指示なしに実装しない。
- **アダプタ分離**： 形式ごとの発見・参照抽出・ルールはアダプタとして分離し、ツリー表示・警告・Tips のコアは形式に依存しない。

## 🏗️ プロジェクト構成

- `src/extension.ts` — 拡張機能のエントリポイント（モデル構築、Problems 連携、ステータスバー、監視）
- `src/skills.ts` — Skills の発見・グルーピング（正本/複製）・参照グラフ構築
- `src/contexts.ts` — Steering / Specs / Copilot instructions の発見とロードシミュレーション
- `src/glob.ts` — 簡易 glob マッチャ（`**` / `*` / `?` / ブレース展開）
- `src/rules.ts` — 警告ルール（R1–R11 / S1–S5）と Tips データ
- `src/tips.ts` — Tips の Markdown 生成とホバー用要約
- `src/matrix.ts` — ツール別ロードマトリクスの Markdown 生成
- `src/treeProvider.ts` — エクスプローラーのツリー表示（セクション制）
- `src/tokens.ts` — トークン推定（文字種ベース、依存ゼロ）
- `src/frontmatter.ts` — frontmatter の最小パーサ
- `src/test/` — 純粋モジュールの単体テスト（node:test）

## ⚙️ 開発コマンド

```bash
npm install
npm test            # compile（型チェック・Lint・アンカーチェック込みの下準備は compile-tests 経由）＋単体テスト
npm run compile     # check-version + check-types + lint + esbuild
npm run package     # 本番ビルド
npm run update-version <X.Y.Z>  # 4点一括のバージョン更新
```

## 📝 コーディング規約

- 言語は TypeScript（strict）。ビルドは esbuild、出力は `dist/extension.js`。
- 純粋モジュール（tokens / frontmatter / skills / contexts / glob / rules / tips / matrix）は `vscode` に依存させない（単体テスト可能に保つ）。
- README / CHANGELOG の体裁は Solo シリーズ共通の型に従う（英語→日本語、見出し直前の `<a id>` アンカー、Keep a Changelog 式の見出し）。README を編集したら `npm run check-readme-anchors` が通ることを確認する。
- 警告ルールを追加する場合は、必ず Tips（原則1文＋具体的な直し方）をセットで追加する。警告だけのルールは作らない。
