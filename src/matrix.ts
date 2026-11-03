import * as path from 'node:path';
import type { CopilotUnit, SpecUnit, SteeringUnit } from './contexts.js';
import type { LogicalSkill } from './skills.js';
import { totalOwnedTokens } from './rules.js';
import { L } from './i18n.js';

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
		L('| ファイル | Kiro | Copilot | 推定トークン |', '| File | Kiro | Copilot | Est. tokens |'),
		'|---|---|---|---:|',
	];
	const esc = (s: string) => s.replace(/\|/g, '\\|');
	const notLoaded = L('読まれない', 'Not loaded');
	for (const s of steering) {
		const when =
			s.inclusion === 'always'
				? L('常時', 'Always')
				: s.inclusion === 'fileMatch'
					? L(`条件一致時（${s.fileMatchPattern ?? 'パターンなし'}）`, `On match (${s.fileMatchPattern ?? 'no pattern'})`)
					: L('手動のみ', 'Manual only');
		lines.push(`| .kiro/steering/${esc(path.basename(s.filePath))} | ${when} | ${notLoaded} | ≈${s.tokens.toLocaleString()} |`);
	}
	for (const skill of skills) {
		for (const copy of skill.copies) {
			const rel = copy.dir.split(path.sep).join('/');
			const tool = rel.includes('/.kiro/') ? 'Kiro' : rel.includes('/.github/') ? 'Copilot' : null;
			if (tool) {
				const asSkill = L('スキルとして', 'As a skill');
				const kiroCell = tool === 'Kiro' ? asSkill : notLoaded;
				const copCell = tool === 'Copilot' ? asSkill : notLoaded;
				lines.push(
					`| ${esc(path.basename(copy.dir))}${L(`（複製: ${tool} 用）`, ` (replica for ${tool})`)} | ${kiroCell} | ${copCell} | ≈${totalOwnedTokens(copy).toLocaleString()} |`,
				);
			}
		}
		lines.push(
			`| ${esc(skill.name)}${L('（正本）', ' (canonical)')} | ${L('直接は読まれない（原本）', 'Not loaded directly (source)')} | ${L('直接は読まれない（原本）', 'Not loaded directly (source)')} | ≈${totalOwnedTokens(skill.canonical).toLocaleString()} |`,
		);
	}
	for (const c of copilot) {
		const when = c.mode === 'always' ? L('常時', 'Always') : L(`条件一致時（applyTo: ${c.applyTo ?? '未指定'}）`, `On match (applyTo: ${c.applyTo ?? 'not set'})`);
		lines.push(`| ${esc(c.name)} | ${notLoaded} | ${when} | ≈${c.tokens.toLocaleString()} |`);
	}
	for (const spec of specs) {
		lines.push(`| Spec: ${esc(spec.name)} | ${L('Spec 作業時', 'During spec work')} | ${notLoaded} | ≈${spec.totalTokens.toLocaleString()} |`);
	}
	lines.push(
		'',
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
		'',
	);
	return lines.join('\n');
}
