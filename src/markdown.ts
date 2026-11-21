/**
 * Markdown テキストへ埋め込む文字列をエスケープする。
 * - `\` の二重化: Windows パスでは `\` の直後が句読点（例: `\.`）だと Markdown の
 *   エスケープとして消費されて区切りが消えて表示される（例: `OmniView-Solo\.kiro`
 *   → `OmniView-Solo.kiro`）ため。
 * - リンク構文を壊す文字（`[`、`]`、`<`、`>`、バッククォート）のエスケープ:
 *   埋め込む文字列が `[表示文](https://…)` の形を作れると、リンク注入による
 *   クリック誘導が可能になる。スキル名・Spec 名・fileMatchPattern・applyTo・
 *   警告文など、リポジトリ側が書ける文字列はすべてここを通してから埋め込むこと。
 */
export function escapeMarkdownText(text: string): string {
	return text.replace(/\\/g, '\\\\').replace(/([[\]<>`])/g, '\\$1');
}
