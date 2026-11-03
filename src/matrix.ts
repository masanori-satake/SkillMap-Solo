import * as path from 'node:path';
import type { CopilotUnit, SpecUnit, SteeringUnit } from './contexts.js';
import type { LogicalSkill } from './skills.js';
import { totalOwnedTokens } from './rules.js';

/** ツール別ロードマトリクスを Markdown で組み立てる（表示層から分離） */
export function renderLoadMatrix(
	skills: LogicalSkill[],
	steering: SteeringUnit[],
	specs: SpecUnit[],
	copilot: CopilotUnit[],
): string {
	const lines: string[] = [
		'# SkillMap — ツール別ロードマトリクス',
		'',
		'どのファイルが・どのツールで・いつ読まれるかの一覧です。読み込みモデルは各ツールの公開仕様に基づく目安であり、β機能として提供します。',
		'',
		'| ファイル | Kiro | Copilot | 推定トークン |',
		'|---|---|---|---:|',
	];
	const esc = (s: string) => s.replace(/\|/g, '\\|');
	for (const s of steering) {
		const when =
			s.inclusion === 'always'
				? '常時'
				: s.inclusion === 'fileMatch'
					? `条件一致時（${s.fileMatchPattern ?? 'パターンなし'}）`
					: '手動のみ';
		lines.push(`| .kiro/steering/${esc(path.basename(s.filePath))} | ${when} | 読まれない | ≈${s.tokens.toLocaleString()} |`);
	}
	for (const skill of skills) {
		for (const copy of skill.copies) {
			const rel = copy.dir.split(path.sep).join('/');
			const tool = rel.includes('/.kiro/') ? 'Kiro' : rel.includes('/.github/') ? 'Copilot' : null;
			if (tool) {
				const other = tool === 'Kiro' ? 'Copilot' : 'Kiro';
				lines.push(
					`| ${esc(path.basename(copy.dir))}（複製: ${tool} 用） | ${tool === 'Kiro' ? 'スキルとして' : '読まれない'} | ${other === 'Copilot' ? 'スキルとして' : '読まれない'} | ≈${totalOwnedTokens(copy).toLocaleString()} |`,
				);
			}
		}
		lines.push(
			`| ${esc(skill.name)}（正本） | 直接は読まれない（原本） | 直接は読まれない（原本） | ≈${totalOwnedTokens(skill.canonical).toLocaleString()} |`,
		);
	}
	for (const c of copilot) {
		const when = c.mode === 'always' ? '常時' : `条件一致時（applyTo: ${c.applyTo ?? '未指定'}）`;
		lines.push(`| ${esc(c.name)} | 読まれない | ${when} | ≈${c.tokens.toLocaleString()} |`);
	}
	for (const spec of specs) {
		lines.push(`| Spec: ${esc(spec.name)} | Spec 作業時 | 読まれない | ≈${spec.totalTokens.toLocaleString()} |`);
	}
	lines.push(
		'',
		'## 読み方',
		'',
		'- 「常時」は、そのツールを使う全セッションで読み込まれる固定費です',
		'- 「条件一致時」は、開いているファイルがパターンに一致したときだけ読み込まれます（ロードシミュレーションβで現在の対象を確認できます）',
		'- Kiro と Copilot で読み込み範囲が違うこと自体は正常です。意図せず片方だけに寄っていないかを確認するのがこの表の目的です',
		'',
	);
	return lines.join('\n');
}
