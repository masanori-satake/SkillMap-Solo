// 簡易 glob マッチャ（依存ゼロ）
// 対応: ** （0階層以上のディレクトリ）, * （/ を含まない任意）, ? （1文字）
// カンマ区切りの複数パターン、{a,b} の展開も扱う。完全互換ではない（β機能の前提）。

function expandBraces(pattern: string): string[] {
	const match = pattern.match(/\{([^{}]*)\}/);
	if (!match) {
		return [pattern];
	}
	const [whole, inner] = match;
	const idx = pattern.indexOf(whole);
	const before = pattern.slice(0, idx);
	const after = pattern.slice(idx + whole.length);
	const results: string[] = [];
	for (const alt of inner.split(',')) {
		for (const rest of expandBraces(after)) {
			results.push(before + alt.trim() + rest);
		}
	}
	return results;
}

function globToRegExp(glob: string): RegExp {
	let re = '';
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i];
		if (ch === '*') {
			if (glob[i + 1] === '*') {
				// **/ は0階層以上、単独 ** は残り全部
				if (glob[i + 2] === '/') {
					re += '(?:.*/)?';
					i += 2;
				} else {
					re += '.*';
					i += 1;
				}
			} else {
				re += '[^/]*';
			}
		} else if (ch === '?') {
			re += '[^/]';
		} else if ('.+^${}()|[]\\'.includes(ch)) {
			re += '\\' + ch;
		} else {
			re += ch;
		}
	}
	return new RegExp('^' + re + '$');
}

/** ブレース内を除くトップレベルのカンマで分割する */
export function splitPatterns(patterns: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let current = '';
	for (const ch of patterns) {
		if (ch === '{') {
			depth++;
		} else if (ch === '}') {
			depth = Math.max(0, depth - 1);
		}
		if (ch === ',' && depth === 0) {
			parts.push(current);
			current = '';
		} else {
			current += ch;
		}
	}
	parts.push(current);
	return parts;
}

/**
 * パターン（カンマ区切り可）が、ワークスペース相対パス（/ 区切り）に一致するか。
 */
export function matchesAnyPattern(patterns: string, relPathPosix: string): boolean {
	const rel = relPathPosix.replace(/^\.\//, '');
	for (const raw of splitPatterns(patterns)) {
		const pattern = raw.trim().replace(/^\.\//, '');
		if (!pattern) {
			continue;
		}
		for (const expanded of expandBraces(pattern)) {
			if (globToRegExp(expanded).test(rel)) {
				return true;
			}
		}
	}
	return false;
}
