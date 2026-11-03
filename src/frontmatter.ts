// 最小限の YAML frontmatter パーサ（依存ゼロ）
// Skills の frontmatter で必要な name / description の取得に用途を絞る。
// 対応: 単一行の値、引用符、ブロック (| / >) の簡易継続行。

export interface Frontmatter {
	name?: string;
	description?: string;
	/** frontmatter 終了位置（本文の開始行インデックス、0始まり） */
	bodyStartLine: number;
	/** frontmatter が存在したか */
	present: boolean;
	/** name が書かれた行（0始まり、無ければ -1） */
	nameLine: number;
	/** description が書かれた行（0始まり、無ければ -1） */
	descriptionLine: number;
	/** 取得できた全トップレベルキー（name/description 以外の参照用） */
	values: Record<string, string>;
}

function unquote(value: string): string {
	const v = value.trim();
	if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
		return v.slice(1, -1);
	}
	return v;
}

export function parseFrontmatter(content: string): Frontmatter {
	const lines = content.split(/\r?\n/);
	const result: Frontmatter = {
		bodyStartLine: 0,
		present: false,
		nameLine: -1,
		descriptionLine: -1,
		values: {},
	};
	if (lines.length === 0 || lines[0].trim() !== '---') {
		return result;
	}
	result.present = true;
	let end = -1;
	let currentKey: 'name' | 'description' | undefined;
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim() === '---' || line.trim() === '...') {
			end = i;
			break;
		}
		const keyMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (keyMatch) {
			const key = keyMatch[1];
			const rawValue = keyMatch[2];
			result.values[key] = unquote(rawValue === '|' || rawValue === '>' ? '' : rawValue);
			if (key === 'name' || key === 'description') {
				currentKey = key;
				if (key === 'name') {
					result.nameLine = i;
					result.name = unquote(rawValue === '|' || rawValue === '>' ? '' : rawValue);
				} else {
					result.descriptionLine = i;
					result.description = unquote(rawValue === '|' || rawValue === '>' ? '' : rawValue);
				}
			} else {
				currentKey = undefined;
			}
			continue;
		}
		// 継続行（インデントされた行）は現在のキーの値に連結する
		if (currentKey && /^\s+\S/.test(line)) {
			const extra = line.trim();
			if (currentKey === 'name' && result.name !== undefined) {
				result.name = (result.name + ' ' + extra).trim();
			}
			if (currentKey === 'description' && result.description !== undefined) {
				result.description = (result.description + ' ' + extra).trim();
			}
		}
	}
	result.bodyStartLine = end >= 0 ? end + 1 : lines.length;
	return result;
}

export function bodyOf(content: string, fm: Frontmatter): string {
	if (!fm.present) {
		return content;
	}
	return content.split(/\r?\n/).slice(fm.bodyStartLine).join('\n');
}

export function countLines(text: string): number {
	if (text.length === 0) {
		return 0;
	}
	return text.split(/\r?\n/).length;
}
