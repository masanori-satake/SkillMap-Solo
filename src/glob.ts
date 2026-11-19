// 簡易 glob マッチャ（依存ゼロ）
// 対応: ** （0階層以上のディレクトリ）, * （/ を含まない任意）, ? （1文字）
// カンマ区切りの複数パターン、{a,b} の展開も扱う。完全互換ではない（β機能の前提）。
//
// パターンの出所は frontmatter（fileMatchPattern / applyTo）であり、リポジトリ側が
// 書ける信頼できない入力。そのため長さ・ブレースグループ数・展開後件数に上限を
// 設け、超過したパターンは「一致なし」として扱う（上限なしの再帰展開はグループ
// ごとに結果が倍増し、{a,b} を20個連結しただけで数十秒かかる指数爆発になる）。
// また展開＋RegExp 化はパターン文字列単位でキャッシュし、パスごとの再コンパイルを
// 避ける（S2 評価では最大 30,000 パスと照合するため、良性パターンでも効く）。

/** 1パターンの長さ上限（文字数） */
const MAX_PATTERN_LENGTH = 512;
/** 1パターンに許すブレースグループ数の上限 */
const MAX_BRACE_GROUPS = 8;
/** ブレース展開後のパターン数の上限 */
const MAX_EXPANDED_PATTERNS = 64;
/** コンパイル結果キャッシュの保持件数（超えたら全消去する簡易方式） */
const COMPILED_CACHE_LIMIT = 200;

const compiledCache = new Map<string, RegExp[]>();

/** ブレース展開する。上限を超えたら null（パターン全体を一致なしとして扱う） */
function expandBraces(pattern: string): string[] | null {
	const match = pattern.match(/\{([^{}]*)\}/);
	if (!match) {
		return [pattern];
	}
	const [whole, inner] = match;
	const idx = pattern.indexOf(whole);
	const before = pattern.slice(0, idx);
	const after = pattern.slice(idx + whole.length);
	const rests = expandBraces(after);
	if (rests === null) {
		return null;
	}
	const results: string[] = [];
	for (const alt of inner.split(',')) {
		for (const rest of rests) {
			results.push(before + alt.trim() + rest);
			if (results.length > MAX_EXPANDED_PATTERNS) {
				return null;
			}
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

/** パターン文字列を展開済み RegExp の列にコンパイルする（上限超過のパターンは除く） */
function compilePatterns(patterns: string): RegExp[] {
	const cached = compiledCache.get(patterns);
	if (cached) {
		return cached;
	}
	const regexes: RegExp[] = [];
	for (const raw of splitPatterns(patterns)) {
		const pattern = raw.trim().replace(/^\.\//, '');
		if (!pattern || pattern.length > MAX_PATTERN_LENGTH) {
			continue;
		}
		if ((pattern.match(/\{/g) ?? []).length > MAX_BRACE_GROUPS) {
			continue;
		}
		const expanded = expandBraces(pattern);
		if (expanded === null) {
			continue;
		}
		for (const e of expanded) {
			regexes.push(globToRegExp(e));
		}
	}
	if (compiledCache.size >= COMPILED_CACHE_LIMIT) {
		compiledCache.clear();
	}
	compiledCache.set(patterns, regexes);
	return regexes;
}

/**
 * パターン（カンマ区切り可）が、ワークスペース相対パス（/ 区切り）に一致するか。
 */
export function matchesAnyPattern(patterns: string, relPathPosix: string): boolean {
	const rel = relPathPosix.replace(/^\.\//, '');
	return compilePatterns(patterns).some((re) => re.test(rel));
}
