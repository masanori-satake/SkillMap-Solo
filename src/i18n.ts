// 表示言語の管理（MeetDock-Solo の i18n.ts と同じ流儀: vscode.env.language で判定）
// 純粋モジュールからも使えるよう、言語はここに保持し extension.ts が起動時に設定する。

export type Lang = 'ja' | 'en';

let current: Lang = 'ja';

export function setLanguage(lang: Lang): void {
	current = lang;
}

export function language(): Lang {
	return current;
}

export function isJapanese(): boolean {
	return current === 'ja';
}

/** 現在の言語に応じて文字列を選ぶ */
export function L(ja: string, en: string): string {
	return current === 'ja' ? ja : en;
}
