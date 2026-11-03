import { RULES, type SkillWarning } from './rules.js';
import { L } from './i18n.js';

/** Tips 全文を Markdown 文字列として組み立てる（表示層から分離したデータ駆動の生成） */
export function renderTipMarkdown(ruleId: string, warningMessage?: string): string {
	const rule = RULES[ruleId];
	if (!rule) {
		return `# SkillMap Tips\n\n${L(`不明なルールです: ${ruleId}`, `Unknown rule: ${ruleId}`)}\n`;
	}
	const lines: string[] = [
		`# 💡 SkillMap Tips — ${rule.id}: ${rule.title}`,
		'',
	];
	if (warningMessage) {
		lines.push(`> ⚠ ${warningMessage}`, '');
	}
	lines.push(`## ${L('原則', 'Principle')}`, '', rule.tip.principle, '', `## ${L('直し方', 'How to fix')}`, '', rule.tip.fix, '');
	if (rule.tip.good || rule.tip.bad) {
		lines.push(`## ${L('例', 'Examples')}`, '');
		if (rule.tip.bad) {
			lines.push(`${L('悪い例:', 'Bad:')}`, '', '```', rule.tip.bad, '```', '');
		}
		if (rule.tip.good) {
			lines.push(`${L('良い例:', 'Good:')}`, '', '```', rule.tip.good, '```', '');
		}
	}
	lines.push(
		'---',
		'',
		L(
			'しきい値や警告レベルは settings.json の `skillmap.rules.*` で調整できます。',
			'Thresholds and severities can be tuned via `skillmap.rules.*` in settings.json.',
		),
		'',
	);
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
