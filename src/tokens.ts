// 推定トークン数の簡易推定（依存ゼロ）
// 日本語文字は約1文字=1トークン、英数字などは約4文字=1トークンとして合算する。
// あくまで概算であり、UI上も「推定」と明記する前提の式。

function isJapaneseChar(code: number): boolean {
	return (
		(code >= 0x3000 && code <= 0x30ff) || // 句読点・ひらがな・カタカナ
		(code >= 0x3400 && code <= 0x4dbf) || // CJK統合漢字拡張A
		(code >= 0x4e00 && code <= 0x9fff) || // CJK統合漢字
		(code >= 0xf900 && code <= 0xfaff) || // CJK互換漢字
		(code >= 0xff01 && code <= 0xff60) // 全角英数・記号
	);
}

export function estimateTokens(text: string): number {
	let tokens = 0;
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		tokens += isJapaneseChar(code) ? 1 : 0.25;
	}
	return Math.ceil(tokens);
}
