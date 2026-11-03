# Changelog

## 0.1.0 (2026-11-03)

初回リリース。

- Agent Skills の参照関係ツリーを Explorer に表示（参照ベース、多階層・境界対応）
- 推定トークン数の3層表示（ノード／経路合計／スキル全体・階層別内訳）
- 警告ルール R1–R11（各ルールに Tips を同梱、ホバー要約＋Markdown 全文）
- 正本（`.agents/`）と複製（`.kiro/` / `.github/`）のグルーピングとドリフト検出
- `.kiro/steering`（inclusion: always）の常時ロード分の併記
- settings.json によるしきい値・深刻度の調整
