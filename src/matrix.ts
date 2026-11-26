import * as path from 'node:path';
import type { CopilotUnit, SpecUnit, SteeringUnit } from './contexts.js';
import { locationLabelOf, rootLabels, skillLocationOf, type LogicalSkill } from './skills.js';
import { totalOwnedTokens } from './rules.js';
import { L } from './i18n.js';
import { escapeMarkdownText } from './markdown.js';

/** ツール別ロードマトリクスを Markdown で組み立てる（表示層から分離） */
export function renderLoadMatrix(
	skills: LogicalSkill[],
	steering: SteeringUnit[],
	specs: SpecUnit[],
	copilot: CopilotUnit[],
): string {
	const lines: string[] = [
		L('# SkillMap — ツール別ロードマトリクス', '# SkillMap — Load Matrix (per tool)'),
		'',
		L(
			'どのファイルが・どのツールで・いつ読まれるかの一覧です。読み込みモデルは各ツールの公開仕様に基づく目安であり、β機能として提供します。',
			'Which files are loaded by which tool, and when. The loading model follows each tool\'s public documentation and is provided as a beta feature.',
		),
		'',
	];
	const skillRows: string[] = [];
	const fileRows: string[] = [];
	// テーブルセル用: 共通エスケープ（リンク構文を壊す文字・バックスラッシュ）に
	// 加えて、セル区切りの `|` も逃がす
	const esc = (s: string) => escapeMarkdownText(s).replace(/\|/g, '\\|');
	const available = L('利用可能', 'Available');
	const unavailable = L('利用不可', 'Unavailable');
	// マルチルートでは同名ファイル（AGENTS.md 等）が並んで判別できないため、
	// そのカテゴリが複数フォルダにまたがる場合は行にフォルダ名を付ける
	const labelsFor = (roots: string[]): Map<string, string> | null => {
		const unique = [...new Set(roots)];
		return unique.length > 1 ? rootLabels(unique) : null;
	};
	const tagFor = (labels: Map<string, string> | null, root: string): string =>
		labels ? ` · ${labels.get(root) ?? path.basename(root)}` : '';
	const steeringLabels = labelsFor(steering.map((s) => s.workspaceRoot));
	const skillLabels = labelsFor(skills.map((s) => s.unit.sourceRoot));
	const copilotLabels = labelsFor(copilot.map((c) => c.workspaceRoot));
	const specLabels = labelsFor(specs.map((s) => s.workspaceRoot));
	for (const s of steering) {
		const when = s.unparsed
			? L('未解析（内容を読み取れませんでした）', 'Not parsed (contents could not be read)')
			: s.inclusion === 'always'
				? L('常時', 'Always')
				: s.inclusion === 'fileMatch'
					? L(`条件一致時（${esc(s.fileMatchPattern ?? 'パターンなし')}）`, `On match (${esc(s.fileMatchPattern ?? 'no pattern')})`)
					: L('手動のみ', 'Manual only');
		fileRows.push(`| .kiro/steering/${esc(path.basename(s.filePath))}${tagFor(steeringLabels, s.workspaceRoot)} | ${unavailable} | ${when} | ≈${s.tokens.toLocaleString()} |`);
	}
	for (const skill of skills) {
		// スキルは配置場所ごとに独立。配置場所と、その場所のツールで利用できるかを
		// そのまま示す（同名スキルが複数並んでも場所で見分けられるようにする）
		const loc = skillLocationOf(skill.unit.dir);
		const copCell = loc === '.github' || loc === '.agents' ? available : unavailable;
		const kiroCell = loc === '.kiro' ? available : unavailable;
		// 標準の配置場所はその名前、それ以外は相対パスで示し、同名行を見分けられるようにする。
		// 相対パスには表の区切り文字が含まれうるため、名前と同じくエスケープする
		const locSuffix = ` (${esc(locationLabelOf(skill.unit))})`;
		skillRows.push(
			`| ${esc(skill.name)}${locSuffix}${tagFor(skillLabels, skill.unit.sourceRoot)} | ${copCell} | ${kiroCell} | ≈${totalOwnedTokens(skill.unit).toLocaleString()} |`,
		);
	}
	for (const c of copilot) {
		const when = c.mode === 'always' ? L('常時', 'Always') : L(`条件一致時（applyTo: ${esc(c.applyTo ?? '未指定')}）`, `On match (applyTo: ${esc(c.applyTo ?? 'not set')})`);
		fileRows.push(`| ${esc(c.name)}${tagFor(copilotLabels, c.workspaceRoot)} | ${when} | ${unavailable} | ≈${c.tokens.toLocaleString()} |`);
	}
	for (const spec of specs) {
		fileRows.push(`| Spec: ${esc(spec.name)}${tagFor(specLabels, spec.workspaceRoot)} | ${unavailable} | ${L('Spec 作業時', 'During spec work')} | ≈${spec.totalTokens.toLocaleString()} |`);
	}
	if (skillRows.length > 0) {
		lines.push(
			L('## スキル', '## Skills'),
			'',
			L('| スキル | Copilot | Kiro | 推定トークン |', '| Skill | Copilot | Kiro | Est. tokens |'),
			'|---|---|---|---:|',
			...skillRows,
			'',
		);
	}
	if (fileRows.length > 0) {
		lines.push(
			L('## ファイル', '## Files'),
			'',
			L('| ファイル | Copilot | Kiro | 推定トークン |', '| File | Copilot | Kiro | Est. tokens |'),
			'|---|---|---|---:|',
			...fileRows,
			'',
		);
	}
	lines.push(
		L('## 読み方', '## How to read this'),
		'',
		L(
			'- 「常時」は、そのツールを使う全セッションで毎回読み込まれる分です',
			'- "Always" is loaded — and its tokens consumed — in every session with that tool.',
		),
		L(
			'- 「条件一致時」は、開いているファイルがパターンに一致したときだけ読み込まれます（ロードシミュレーションβで現在の対象を確認できます）',
			'- "On match" loads only when the open file matches the pattern (see the load simulation β for the current file).',
		),
		L(
			'- Kiro と Copilot で読み込み範囲が違うこと自体は正常です。意図せず片方だけに寄っていないかを確認するのがこの表の目的です',
			'- Different coverage between Kiro and Copilot is normal. This table exists so you can check the difference is intentional.',
		),
		L(
			'- 名前の後に配置場所（.kiro など）が付いた行は、その配置場所にあるスキルです。同名のスキルが複数の場所にあっても、それぞれ独立したスキルとして扱います。.github と .agents のスキルは Copilot で、.kiro のスキルは Kiro で利用できます',
			'- A row whose name is followed by a location (such as .kiro) is the skill at that location. Same-named skills in different locations are treated as independent skills. Skills in .github and .agents are available in Copilot; skills in .kiro are available in Kiro.',
		),
		'',
	);
	return lines.join('\n');
}
