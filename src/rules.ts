import * as path from 'node:path';
import type { LogicalSkill, SkillUnit } from './skills.js';

export type Severity = 'error' | 'warn' | 'info';

export interface Tip {
	/** 原則（なぜこのルールがあるか）を1文で */
	principle: string;
	/** 具体的な直し方 */
	fix: string;
	good?: string;
	bad?: string;
}

export interface RuleDef {
	id: string;
	title: string;
	tip: Tip;
}

export const RULES: Record<string, RuleDef> = {
	R1: {
		id: 'R1',
		title: 'name の形式（仕様）',
		tip: {
			principle: 'name は AI と人がスキルを識別する鍵で、形式は Skills 仕様で決まっています。',
			fix: '64文字以内、小文字英数字とハイフンのみ、ディレクトリ名と一致させてください。',
			good: 'name: pdf-processing',
			bad: 'name: PDF_Processing_v2',
		},
	},
	R2: {
		id: 'R2',
		title: 'description の有無と長さ（仕様）',
		tip: {
			principle: 'description は常時コンテキストに載り、AI が「このスキルを使うべきか」を判断する唯一の材料です。',
			fix: '「何をするか」と「いつ使うか」を含め、1,024文字以内に収めてください。',
			good: 'description: PDFの表を抽出してCSV化する。表形式のPDFを渡されたときに使う。',
			bad: 'description: PDFを処理する。',
		},
	},
	R3: {
		id: 'R3',
		title: 'description に利用シーンがあるか',
		tip: {
			principle: '「何をするか」だけでは、AI は使う場面を判断できません。',
			fix: '「〜するとき」「〜の場合」のような利用シーンを一言足してください。',
		},
	},
	R4: {
		id: 'R4',
		title: 'SKILL.md 本文の行数',
		tip: {
			principle: 'SKILL.md はスキル起動時に丸ごと読まれます。長いほど毎回のコストとノイズが増えます。',
			fix: '詳細な手順や資料は references/ に切り出し、SKILL.md には骨格と参照だけを残してください（目安500行以内）。',
		},
	},
	R5: {
		id: 'R5',
		title: 'SKILL.md の推定トークン',
		tip: {
			principle: 'SKILL.md のトークン数は、そのスキルを使うたびに必ず払う固定費です。',
			fix: '大きな表や例は references/ に移し、SKILL.md 自体を痩せさせてください。',
		},
	},
	R6: {
		id: 'R6',
		title: '参照の深さ',
		tip: {
			principle: '参照が深くなるほど、AI が末端まで辿り着けない確率が上がります。',
			fix: 'よく使うファイルは SKILL.md から直接参照できる位置に置いてください。Steering 等の形式の境界の先は、このルールの対象外です。',
		},
	},
	R7: {
		id: 'R7',
		title: '参照切れ',
		tip: {
			principle: '参照切れは、AI が辿ろうとして行き止まりになる道です。',
			fix: 'ファイルの移動・改名に合わせて参照を直すか、不要になった参照を消してください。',
		},
	},
	R8: {
		id: 'R8',
		title: '循環参照',
		tip: {
			principle: '循環参照は、辿る側（AI と人）を混乱させます。',
			fix: '共通部分を第3のファイルに切り出し、双方から参照する形に変えてください。',
		},
	},
	R9: {
		id: 'R9',
		title: '未参照ファイル（孤立）',
		tip: {
			principle: 'どこからも参照されていないファイルは、AI からも見えない「死蔵」です。',
			fix: 'SKILL.md か references から参照を張るか、不要なら削除してください。',
		},
	},
	R10: {
		id: 'R10',
		title: 'スキル全体のトークン予算',
		tip: {
			principle: 'スキルの総量は、そのまま利用時の最大コストになります。予算を決めると設計判断がぶれません。',
			fix: '大きい references の分割・要約、重複ファイルの排除から手をつけてください。',
		},
	},
	R11: {
		id: 'R11',
		title: '正本と複製の乖離（ドリフト）',
		tip: {
			principle: '正本と複製の乖離は、「片方のツールでだけ精度が落ちる」事故の元です。',
			fix: '複製を再実行して正本に揃えてください。複製側を直接編集しても、次の複製で上書きされます。',
		},
	},
	S1: {
		id: 'S1',
		title: 'Steering の inclusion 未指定',
		tip: {
			principle: 'inclusion 未指定の Steering は暗黙に「常時ロード」扱いとなり、全セッションで固定費を払い続けます。',
			fix: 'frontmatter に inclusion を明示してください。特定ファイルでのみ必要なものは fileMatch、任意で読み込むものは manual が向きます。',
			good: 'inclusion: fileMatch\nfileMatchPattern: "src/**/*.tsx"',
			bad: '（frontmatter なし）',
		},
	},
	S2: {
		id: 'S2',
		title: 'fileMatchPattern が何にも一致しない',
		tip: {
			principle: '条件が実ファイルに一致しない Steering は「効いているつもり」で誰にも読まれません。',
			fix: 'パターンの書き間違い（拡張子、ディレクトリ名、** の位置）を確認してください。対象ファイルが消えたなら Steering 自体の棚卸しどきです。',
		},
	},
	S3: {
		id: 'S3',
		title: 'Steering 常時ロードの合計予算',
		tip: {
			principle: '常時ロードの合計は、Kiro を使う全セッションの固定費です。個別には小さくても合算で効いてきます。',
			fix: '使用頻度の低いものから fileMatch / manual へ移すか、内容を要約して薄くしてください。',
		},
	},
	S4: {
		id: 'S4',
		title: 'Spec の3点セットの欠け',
		tip: {
			principle: 'requirements（何を作るか）→ design（どう作るか）→ tasks（作業分解）の3点が揃って、仕様駆動の流れが保たれます。',
			fix: '欠けているファイルを作成してください。意図的に不要な段階を飛ばす場合は、その旨を残りのファイルに一言書いておくと読み手が迷いません。',
		},
	},
	S5: {
		id: 'S5',
		title: 'Steering の正本と複製の乖離',
		tip: {
			principle: 'Steering も正本と複製がずれれば、Kiro 側だけ古い方針で動き続けます。',
			fix: '複製を再実行して正本に揃えてください（R11 と同じ考え方です）。',
		},
	},
};

export interface RuleSettings {
	skillBodyMaxLines: number;
	skillBodyMaxTokens: number;
	descriptionMaxLength: number;
	maxReferenceDepth: number;
	skillTotalTokenBudget: number;
	orphanFiles: 'off' | 'info' | 'warn';
	steeringAlwaysTokenBudget: number;
}

export const DEFAULT_RULE_SETTINGS: RuleSettings = {
	skillBodyMaxLines: 500,
	skillBodyMaxTokens: 5000,
	descriptionMaxLength: 1024,
	maxReferenceDepth: 2,
	skillTotalTokenBudget: 0,
	orphanFiles: 'info',
	steeringAlwaysTokenBudget: 0,
};

export interface SkillWarning {
	ruleId: string;
	severity: Severity;
	message: string;
	/** 警告の対象ファイル（絶対パス） */
	file: string;
	/** 対象行（0始まり、任意） */
	line?: number;
	/** 複製に対する警告の場合、その複製ユニット */
	copyDir?: string;
}

const WHEN_KEYWORDS = [
	'when', 'use this', 'whenever', 'if you', 'trigger',
	'とき', '時', '場合', '使', 'たら', 'れば', 'シーン', 'ため',
];

export function totalOwnedTokens(unit: SkillUnit): number {
	let total = 0;
	for (const p of unit.reachableOwned) {
		total += unit.files.get(p)?.tokens ?? 0;
	}
	return total;
}

export interface Drift {
	missing: string[];
	extra: string[];
	differing: string[];
}

export function driftBetween(canonical: SkillUnit, copy: SkillUnit): Drift {
	const missing: string[] = [];
	const differing: string[] = [];
	for (const [rel, hash] of canonical.fileHashes) {
		const copyHash = copy.fileHashes.get(rel);
		if (copyHash === undefined) {
			missing.push(rel);
		} else if (copyHash !== hash) {
			differing.push(rel);
		}
	}
	const extra: string[] = [];
	for (const rel of copy.fileHashes.keys()) {
		if (!canonical.fileHashes.has(rel)) {
			extra.push(rel);
		}
	}
	return { missing: missing.sort(), extra: extra.sort(), differing: differing.sort() };
}

function findCycles(unit: SkillUnit): Array<{ from: string; line: number; to: string }> {
	const cycles: Array<{ from: string; line: number; to: string }> = [];
	const visited = new Set<string>();
	const stack: string[] = [];
	const dfs = (current: string) => {
		visited.add(current);
		stack.push(current);
		const info = unit.files.get(current);
		if (info) {
			for (const edge of info.refs) {
				if (!edge.exists || edge.isDirectory) {
					continue;
				}
				if (stack.includes(edge.target)) {
					cycles.push({ from: current, line: edge.line, to: edge.target });
				} else if (!visited.has(edge.target)) {
					dfs(edge.target);
				}
			}
		}
		stack.pop();
	};
	dfs(unit.skillMdPath);
	return cycles;
}

export function evaluateSkill(skill: LogicalSkill, settings: RuleSettings): SkillWarning[] {
	const warnings: SkillWarning[] = [];
	const unit = skill.canonical;
	const fm = unit.frontmatter;
	const push = (w: SkillWarning) => warnings.push(w);

	// R1: name の形式
	const name = (fm.name ?? '').trim();
	if (!name) {
		push({ ruleId: 'R1', severity: 'error', message: 'frontmatter に name がありません', file: unit.skillMdPath, line: 0 });
	} else {
		if (name.length > 64) {
			push({ ruleId: 'R1', severity: 'error', message: `name が64文字を超えています（${name.length}文字）`, file: unit.skillMdPath, line: fm.nameLine });
		}
		if (!/^[a-z0-9-]+$/.test(name)) {
			push({ ruleId: 'R1', severity: 'error', message: 'name は小文字英数字とハイフンのみで書いてください', file: unit.skillMdPath, line: fm.nameLine });
		}
		if (name !== path.basename(unit.dir)) {
			push({ ruleId: 'R1', severity: 'error', message: `name（${name}）とディレクトリ名（${path.basename(unit.dir)}）が一致しません`, file: unit.skillMdPath, line: fm.nameLine });
		}
	}

	// R2: description
	const description = (fm.description ?? '').trim();
	if (settings.descriptionMaxLength > 0) {
		if (!description) {
			push({ ruleId: 'R2', severity: 'error', message: 'frontmatter に description がありません', file: unit.skillMdPath, line: 0 });
		} else if (description.length > settings.descriptionMaxLength) {
			push({ ruleId: 'R2', severity: 'error', message: `description が${settings.descriptionMaxLength}文字を超えています（${description.length}文字）`, file: unit.skillMdPath, line: fm.descriptionLine });
		}
	}

	// R3: 利用シーンの手がかり
	if (description) {
		const lower = description.toLowerCase();
		const hasWhen = WHEN_KEYWORDS.some((k) => lower.includes(k));
		if (!hasWhen) {
			push({ ruleId: 'R3', severity: 'info', message: 'description に「いつ使うか」の手がかりが見当たりません', file: unit.skillMdPath, line: fm.descriptionLine });
		}
	}

	// R4: 本文行数
	if (settings.skillBodyMaxLines > 0 && unit.bodyLines > settings.skillBodyMaxLines) {
		push({ ruleId: 'R4', severity: 'warn', message: `SKILL.md 本文が${settings.skillBodyMaxLines}行を超えています（${unit.bodyLines}行）`, file: unit.skillMdPath, line: fm.bodyStartLine });
	}

	// R5: SKILL.md トークン
	if (settings.skillBodyMaxTokens > 0 && unit.skillMdTokens > settings.skillBodyMaxTokens) {
		push({ ruleId: 'R5', severity: 'warn', message: `SKILL.md の推定トークンが上限を超えています（約${unit.skillMdTokens.toLocaleString()} / 上限 約${settings.skillBodyMaxTokens.toLocaleString()}）`, file: unit.skillMdPath, line: 0 });
	}

	// R6: 参照の深さ（スキル所有ファイル内のみ）
	if (settings.maxReferenceDepth > 0) {
		for (const [p, depth] of unit.depthOwned) {
			if (p !== unit.skillMdPath && depth > settings.maxReferenceDepth) {
				push({ ruleId: 'R6', severity: 'warn', message: `参照の深さが上限を超えています（深さ${depth} / 上限 ${settings.maxReferenceDepth}）`, file: p, line: 0 });
			}
		}
	}

	// R7: 参照切れ（境界の先の構造チェック含む）
	for (const [from, info] of unit.files) {
		for (const edge of info.refs) {
			if (!edge.exists) {
				push({ ruleId: 'R7', severity: 'error', message: `参照先が存在しません: ${edge.raw}`, file: from, line: edge.line });
			}
		}
	}

	// R8: 循環参照
	for (const cycle of findCycles(unit)) {
		push({ ruleId: 'R8', severity: 'warn', message: `循環参照があります: ${path.basename(cycle.from)} → ${path.basename(cycle.to)}`, file: cycle.from, line: cycle.line });
	}

	// R9: 孤立ファイル
	if (settings.orphanFiles !== 'off') {
		for (const orphan of unit.orphans) {
			push({ ruleId: 'R9', severity: settings.orphanFiles, message: 'どこからも参照されていません', file: orphan });
		}
	}

	// R10: 全体予算
	if (settings.skillTotalTokenBudget > 0) {
		const total = totalOwnedTokens(unit);
		if (total > settings.skillTotalTokenBudget) {
			push({ ruleId: 'R10', severity: 'warn', message: `スキル全体の推定トークンが予算を超えています（約${total.toLocaleString()} / 予算 約${settings.skillTotalTokenBudget.toLocaleString()}）`, file: unit.skillMdPath, line: 0 });
		}
	}

	// R11: 複製ドリフト
	for (const copy of skill.copies) {
		const drift = driftBetween(unit, copy);
		const total = drift.missing.length + drift.extra.length + drift.differing.length;
		if (total > 0) {
			const parts: string[] = [];
			if (drift.missing.length > 0) {
				parts.push(`不足 ${drift.missing.length}件`);
			}
			if (drift.differing.length > 0) {
				parts.push(`不一致 ${drift.differing.length}件`);
			}
			if (drift.extra.length > 0) {
				parts.push(`余分 ${drift.extra.length}件`);
			}
			push({
				ruleId: 'R11',
				severity: 'warn',
				message: `正本との乖離があります（${parts.join('、')}）`,
				file: copy.skillMdPath,
				copyDir: copy.dir,
			});
		}
	}

	return warnings;
}

import {
	filesEqual,
	patternMatchesAny,
	type SpecUnit,
	type SteeringUnit,
} from './contexts.js';

export function evaluateSteering(
	units: SteeringUnit[],
	workspaceRelPaths: string[],
	settings: RuleSettings,
): SkillWarning[] {
	const warnings: SkillWarning[] = [];
	for (const unit of units) {
		// S1: inclusion 未指定
		if (!unit.inclusionExplicit) {
			warnings.push({
				ruleId: 'S1',
				severity: 'info',
				message: 'inclusion が未指定です（暗黙に常時ロード扱いになります）',
				file: unit.filePath,
				line: 0,
			});
		}
		// S2: fileMatch の死パターン
		if (unit.inclusion === 'fileMatch') {
			if (!unit.fileMatchPattern) {
				warnings.push({
					ruleId: 'S2',
					severity: 'warn',
					message: 'inclusion: fileMatch ですが fileMatchPattern がありません',
					file: unit.filePath,
					line: 0,
				});
			} else if (!patternMatchesAny(unit.fileMatchPattern, workspaceRelPaths)) {
				warnings.push({
					ruleId: 'S2',
					severity: 'warn',
					message: `fileMatchPattern「${unit.fileMatchPattern}」に一致するファイルがワークスペース内にありません`,
					file: unit.filePath,
					line: 0,
				});
			}
		}
		// S5: 正本との乖離
		if (unit.canonicalCounterpart && !filesEqual(unit.canonicalCounterpart, unit.filePath)) {
			warnings.push({
				ruleId: 'S5',
				severity: 'warn',
				message: '正本（.agents 配下）と内容が乖離しています',
				file: unit.filePath,
				line: 0,
			});
		}
	}
	// S3: 常時ロード合計の予算
	if (settings.steeringAlwaysTokenBudget > 0 && units.length > 0) {
		const alwaysUnits = units.filter((u) => u.inclusion === 'always');
		const total = alwaysUnits.reduce((s, u) => s + u.tokens, 0);
		if (total > settings.steeringAlwaysTokenBudget) {
			warnings.push({
				ruleId: 'S3',
				severity: 'warn',
				message: `Steering 常時ロードの合計が予算を超えています（約${total.toLocaleString()} / 予算 約${settings.steeringAlwaysTokenBudget.toLocaleString()}）`,
				file: path.dirname(units[0].filePath),
			});
		}
	}
	return warnings;
}

export function evaluateSpecs(units: SpecUnit[]): SkillWarning[] {
	const warnings: SkillWarning[] = [];
	for (const unit of units) {
		for (const f of unit.files) {
			if (!f.present) {
				warnings.push({
					ruleId: 'S4',
					severity: 'info',
					message: `Spec「${unit.name}」に ${f.fileName} がありません`,
					file: unit.dir,
				});
			}
		}
	}
	return warnings;
}
