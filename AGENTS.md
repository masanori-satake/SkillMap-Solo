# SkillMap-Solo

AI コンテキストファイル（Agent Skills）の参照関係を可視化し、ベストプラクティス警告と Tips で保守を支える VS Code 拡張機能。

## 設計原則

- 100% ローカル処理、トラッキングなし、実行時依存ゼロ
- 形式ごとの差異はアダプタ（skills.ts の発見・グラフ構築）に分離し、ルールと表示は形式非依存に保つ
- 純粋モジュール（tokens / frontmatter / skills / rules）は `vscode` に依存させない（単体テスト可能に保つ）
- 推定トークンは概算であることを UI で明示する

## 仕様

正本は `~/workspace/projects/skillmap-solo/mvp-spec.md`（Muse との議論で確定した MVP 仕様）。
スコープ: MVP は Agent Skills のみ。将来は Kiro Steering/Specs（案B）、汎用 AI コンテキストファイル（案C）へ拡張する。
