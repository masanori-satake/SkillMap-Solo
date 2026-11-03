import { RULES, type SkillWarning } from './rules.js';

/** Tips 全文を Markdown 文字列として組み立てる（表示層から分離したデータ駆動の生成） */
export function renderTipMarkdown(ruleId: string, warningMessage?: string): string {
	const rule = RULES[ruleId];
	if (!rule) {
		return `# SkillMap Tips\n\n不明なルールです: ${ruleId}\n`;
	}
	const lines: string[] = [
		`# 💡 SkillMap Tips — ${rule.id}: ${rule.title}`,
		'',
	];
	if (warningMessage) {
		lines.push(`> ⚠ ${warningMessage}`, '');
	}
	lines.push('## 原則', '', rule.tip.principle, '', '## 直し方', '', rule.tip.fix, '');
	if (rule.tip.good || rule.tip.bad) {
		lines.push('## 例', '');
		if (rule.tip.bad) {
			lines.push('悪い例:', '', '```', rule.tip.bad, '```', '');
		}
		if (rule.tip.good) {
			lines.push('良い例:', '', '```', rule.tip.good, '```', '');
		}
	}
	lines.push('---', '', 'しきい値や警告レベルは settings.json の `skillmap.rules.*` で調整できます。', '');
	return lines.join('\n');
}

/** ホバー用の短い Tips（原則のみ＋全文への導線） */
export function renderTipSummary(ruleId: string): string {
	const rule = RULES[ruleId];
	if (!rule) {
		return '';
	}
	return rule.tip.principle;
}

export function tipCommandUri(ruleId: string, warningMessage?: string): string {
	const args = encodeURIComponent(JSON.stringify([{ ruleId, warningMessage }]));
	return `command:skillmap.openTip?${args}`;
}

export function warningsForFile(warnings: SkillWarning[], file: string): SkillWarning[] {
	return warnings.filter((w) => w.file === file);
}
