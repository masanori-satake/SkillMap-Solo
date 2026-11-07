import * as path from 'node:path';
import { isTentativeMention, type LogicalSkill, type SkillUnit } from './skills.js';
import { L } from './i18n.js';

export type Severity = 'error' | 'warn' | 'info';

interface TipDef {
	/** 原則（なぜこのルールがあるか）を1文で */
	principle: { ja: string; en: string };
	/** 具体的な直し方 */
	fix: { ja: string; en: string };
	good?: string;
	bad?: string;
}

export interface Tip {
	principle: string;
	fix: string;
	good?: string;
	bad?: string;
}

interface RuleDefStatic {
	id: string;
	title: { ja: string; en: string };
	tip: TipDef;
}

export interface RuleDef {
	id: string;
	title: string;
	tip: Tip;
}

const RULE_DEFS: Record<string, RuleDefStatic> = {
	R1: {
		id: 'R1',
		title: { ja: 'name の形式（仕様）', en: 'name format (spec)' },
		tip: {
			principle: {
				ja: 'name は AI と人がスキルを識別する鍵で、形式は Skills 仕様で決まっています。',
				en: 'The name is the key by which AI and humans identify a skill, and its format is fixed by the Skills spec.',
			},
			fix: {
				ja: '64文字以内、小文字英数字とハイフンのみ、ディレクトリ名と一致させてください。',
				en: 'Keep it within 64 characters, lowercase letters/digits/hyphens only, and matching the directory name.',
			},
			good: 'name: pdf-processing',
			bad: 'name: PDF_Processing_v2',
		},
	},
	R2: {
		id: 'R2',
		title: { ja: 'description の有無と長さ（仕様）', en: 'description presence and length (spec)' },
		tip: {
			principle: {
				ja: 'description は常時コンテキストに載り、AI が「このスキルを使うべきか」を判断する唯一の材料です。',
				en: 'The description is always in context and is the only material the AI has to decide whether to use this skill.',
			},
			fix: {
				ja: '「何をするか」と「いつ使うか」を含め、1,024文字以内に収めてください。',
				en: 'Include both what it does and when to use it, within 1,024 characters.',
			},
			good: 'description: PDFの表を抽出してCSV化する。表形式のPDFを渡されたときに使う。',
			bad: 'description: PDFを処理する。',
		},
	},
	R3: {
		id: 'R3',
		title: { ja: 'description に利用シーンがあるか', en: 'Description has a use-case cue' },
		tip: {
			principle: {
				ja: '「何をするか」だけでは、AI は使う場面を判断できません。',
				en: 'Saying only what it does does not tell the AI when it applies.',
			},
			fix: {
				ja: '「〜するとき」「〜の場合」のような利用シーンを一言足してください。',
				en: 'Add a use-case cue such as "Use when …" or "For …".',
			},
		},
	},
	R4: {
		id: 'R4',
		title: { ja: 'SKILL.md 本文の行数', en: 'SKILL.md body length (lines)' },
		tip: {
			principle: {
				ja: 'SKILL.md はスキル起動時に丸ごと読まれます。長いほど毎回のコストとノイズが増えます。',
				en: 'SKILL.md is read in full every time the skill triggers. The longer it is, the more cost and noise each run pays.',
			},
			fix: {
				ja: '詳細な手順や資料は references/ に切り出し、SKILL.md には骨格と参照だけを残してください（目安500行以内）。',
				en: 'Move detailed steps and material into references/ and keep only the skeleton and pointers in SKILL.md (around 500 lines).',
			},
		},
	},
	R5: {
		id: 'R5',
		title: { ja: 'SKILL.md の推定トークン', en: 'SKILL.md estimated tokens' },
		tip: {
			principle: {
				ja: 'SKILL.md のトークン数は、そのスキルを使うたびに毎回消費される分です。',
				en: 'The tokens of SKILL.md are consumed on every use of the skill.',
			},
			fix: {
				ja: '大きな表や例は references/ に移し、SKILL.md 自体を痩せさせてください。',
				en: 'Move large tables and examples into references/ and slim SKILL.md itself down.',
			},
		},
	},
	R6: {
		id: 'R6',
		title: { ja: '参照の深さ', en: 'Reference depth' },
		tip: {
			principle: {
				ja: '参照が深くなるほど、AI が末端まで辿り着けない確率が上がります。',
				en: 'The deeper the reference chain, the more likely the AI never reaches the far end.',
			},
			fix: {
				ja: 'よく使うファイルは SKILL.md から直接参照できる位置に置いてください。Steering 等のスキル外のファイルは、このルールの対象外です。',
				en: 'Place frequently used files where SKILL.md can reference them directly. Files outside the skill (such as steering) are out of scope for this rule.',
			},
		},
	},
	R7: {
		id: 'R7',
		title: { ja: '未解決の参照', en: 'Unresolved reference' },
		tip: {
			principle: {
				ja: '文書中のパスやファイル名は、離れた箇所の記述と組み合わせて初めて意味が通ることも多く、解決できないこと自体は不具合とは限りません。',
				en: 'A path or file name in the text often makes sense only together with passages elsewhere in the document, so an unresolved reference is not necessarily a defect.',
			},
			fix: {
				ja: '参照を意図している場合には、パスの起点や表記を確認してください（解決はスキルルート・フォルダ相対でも試みられます）。文脈で意味が通る書き方であれば、そのままで問題ありません。',
				en: 'If a reference was intended, check the base of the path and its spelling (resolution is also attempted from the skill root and the workspace folder). If the wording reads fine in context, no action is needed.',
			},
		},
	},
	R13: {
		id: 'R13',
		title: { ja: '要確認の言及', en: 'Mention to check' },
		tip: {
			principle: {
				ja: 'ファイル名だけの言及は、参照のつもりで書かれたとは限らず、構造の説明や、これから作るファイルの名前であることも多いものです。',
				en: 'A bare file name in the text is not necessarily meant as a reference — it may just describe structure, or name a file yet to be created.',
			},
			fix: {
				ja: '参照を意図している場合には、確認が必要です。ファイルを作成するか、表記（タイプミス等）を見直してください。説明や予定の名前であれば、そのままで問題ありません。',
				en: 'If a reference was intended, it needs a check — create the file or review the spelling. If it is a description or a planned name, no action is needed.',
			},
		},
	},
	R8: {
		id: 'R8',
		title: { ja: '循環参照', en: 'Reference cycle' },
		tip: {
			principle: {
				ja: '循環参照は、辿る側（AI と人）を混乱させます。',
				en: 'Cycles confuse whoever follows the trail — AI and humans alike.',
			},
			fix: {
				ja: '共通部分を第3のファイルに切り出し、双方から参照する形に変えてください。',
				en: 'Extract the shared part into a third file and have both sides reference that instead.',
			},
		},
	},
	R9: {
		id: 'R9',
		title: { ja: '未参照ファイル（孤立）', en: 'Unreferenced file (orphan)' },
		tip: {
			principle: {
				ja: 'どこからも参照されていないファイルは、AI からも見えない「死蔵」です。',
				en: 'A file referenced from nowhere is invisible to the AI as well — dead storage.',
			},
			fix: {
				ja: 'SKILL.md か references から参照を張るか、不要なら削除してください。',
				en: 'Reference it from SKILL.md or a reference file, or delete it if it is no longer needed.',
			},
		},
	},
	R10: {
		id: 'R10',
		title: { ja: 'スキル全体のトークン予算', en: 'Whole-skill token budget' },
		tip: {
			principle: {
				ja: 'スキルの総量は、そのまま利用時の最大コストになります。予算を決めると設計判断がぶれません。',
				en: 'The total size of a skill is its maximum cost per use. A budget keeps design decisions consistent.',
			},
			fix: {
				ja: '大きい references の分割・要約、重複ファイルの排除から手をつけてください。',
				en: 'Start by splitting or summarising large references and removing duplicated files.',
			},
		},
	},
	R11: {
		id: 'R11',
		title: { ja: '正本と複製の乖離（ドリフト）', en: 'Canonical vs replica drift' },
		tip: {
			principle: {
				ja: '正本と複製の乖離は、「片方のツールでだけ精度が落ちる」事故の元です。',
				en: 'Drift between the canonical source and its copies is how "quality dropped in one tool only" incidents happen.',
			},
			fix: {
				ja: '複製を再実行して正本に揃えてください。複製側を直接編集しても、次の複製で上書きされます。',
				en: 'Re-run the copy step to realign the replicas with the canonical source. Editing a copy directly is lost on the next copy.',
			},
		},
	},
	S1: {
		id: 'S1',
		title: { ja: 'Steering の inclusion 未指定', en: 'Steering inclusion not specified' },
		tip: {
			principle: {
				ja: 'inclusion 未指定の Steering は暗黙に「常時ロード」扱いとなり、全セッションでトークンを消費し続けます。',
				en: 'A steering file without an inclusion setting is implicitly "always loaded", so its tokens are consumed in every session.',
			},
			fix: {
				ja: 'frontmatter に inclusion を明示してください。特定ファイルでのみ必要なものは fileMatch、任意で読み込むものは manual が向きます。',
				en: 'Set inclusion explicitly in the frontmatter. Use fileMatch for files needed only in specific contexts, and manual for on-demand ones.',
			},
			good: 'inclusion: fileMatch\nfileMatchPattern: "src/**/*.tsx"',
			bad: '（frontmatter なし）',
		},
	},
	S2: {
		id: 'S2',
		title: { ja: 'fileMatchPattern が何にも一致しない', en: 'fileMatchPattern matches nothing' },
		tip: {
			principle: {
				ja: '条件が実ファイルに一致しない Steering は「効いているつもり」で誰にも読まれません。',
				en: 'A steering file whose pattern matches no real file is never read by anyone, while everyone assumes it works.',
			},
			fix: {
				ja: 'パターンの書き間違い（拡張子、ディレクトリ名、** の位置）を確認してください。対象ファイルが消えたなら Steering 自体の棚卸しどきです。',
				en: 'Check the pattern for typos (extension, directory name, ** placement). If the target files are gone, it is time to retire the steering file itself.',
			},
		},
	},
	S3: {
		id: 'S3',
		title: { ja: 'Steering 常時ロードの合計予算', en: 'Always-loaded steering total budget' },
		tip: {
			principle: {
				ja: '常時ロードの合計は、Kiro を使う全セッションで毎回消費されるトークンです。個別には小さくても合算で効いてきます。',
				en: 'The always-loaded total is consumed in every Kiro session. Small files add up.',
			},
			fix: {
				ja: '使用頻度の低いものから fileMatch / manual へ移すか、内容を要約して薄くしてください。',
				en: 'Move rarely needed files to fileMatch or manual, or summarise them thinner.',
			},
		},
	},
	S4: {
		id: 'S4',
		title: { ja: 'Spec の3点セットの欠け', en: 'Incomplete Spec trio' },
		tip: {
			principle: {
				ja: 'requirements（何を作るか）→ design（どう作るか）→ tasks（作業分解）の3点が揃って、仕様駆動の流れが保たれます。',
				en: 'The spec-driven flow holds when requirements (what) → design (how) → tasks (breakdown) are all present.',
			},
			fix: {
				ja: '欠けているファイルを作成してください。意図的に不要な段階を飛ばす場合は、その旨を残りのファイルに一言書いておくと読み手が迷いません。',
				en: 'Create the missing file. If a stage is intentionally skipped, leave a one-line note in the remaining files so readers are not left guessing.',
			},
		},
	},
	S5: {
		id: 'S5',
		title: { ja: 'Steering の正本と複製の乖離', en: 'Steering canonical vs replica drift' },
		tip: {
			principle: {
				ja: 'Steering も正本と複製がずれれば、Kiro 側だけ古い方針で動き続けます。',
				en: 'If steering copies drift from the canonical source, Kiro keeps following the outdated policy.',
			},
			fix: {
				ja: '複製を再実行して正本に揃えてください（R11 と同じ考え方です）。',
				en: 'Re-run the copy step to realign with the canonical source (same idea as R11).',
			},
		},
	},
	R12: {
		id: 'R12',
		title: { ja: 'frontmatter の任意フィールド（compatibility 等）', en: 'Optional frontmatter fields (compatibility, etc.)' },
		tip: {
			principle: {
				ja: 'compatibility のような任意フィールドにも仕様上の上限があります。上限を超えるとツール側で無視・切り捨てされることがあります。',
				en: 'Optional fields such as compatibility also have spec limits. Beyond the limit, tools may ignore or truncate them.',
			},
			fix: {
				ja: 'compatibility は500文字以内に収めてください。環境要件は要点だけを書き、詳細は references に逃がすのが安全です。',
				en: 'Keep compatibility within 500 characters. State only the essential environment requirements and move details into references.',
			},
		},
	},
	S6: {
		id: 'S6',
		title: { ja: 'inclusion の値が想定外', en: 'Unexpected inclusion value' },
		tip: {
			principle: {
				ja: 'inclusion は always / fileMatch / manual の3値だけです。綴り間違いは黙って「常時ロード」に化け、全セッションで意図せずトークンを消費し続けます。',
				en: 'inclusion accepts only always / fileMatch / manual. A typo silently degrades into "always loaded", consuming tokens in every session without anyone noticing.',
			},
			fix: {
				ja: 'frontmatter の inclusion の綴りを確認してください（例: alwyas → always）。',
				en: 'Check the spelling of inclusion in the frontmatter (e.g. alwyas → always).',
			},
		},
	},
};

/** 現在の表示言語で解決済みのルール定義を返す */
export const RULES: Record<string, RuleDef> = new Proxy({} as Record<string, RuleDef>, {
	get(_target, prop: string) {
		const def = RULE_DEFS[prop];
		if (!def) {
			return undefined;
		}
		return {
			id: def.id,
			title: L(def.title.ja, def.title.en),
			tip: {
				principle: L(def.tip.principle.ja, def.tip.principle.en),
				fix: L(def.tip.fix.ja, def.tip.fix.en),
				good: def.tip.good,
				bad: def.tip.bad,
			},
		};
	},
	ownKeys() {
		return Reflect.ownKeys(RULE_DEFS);
	},
	getOwnPropertyDescriptor(_target, prop: string) {
		if (prop in RULE_DEFS) {
			return { enumerable: true, configurable: true };
		}
		return undefined;
	},
});

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
	/** 参照系ルール（R7/R13）の場合、解決先の絶対パス。同じ行に複数の未解決参照が
	 * あっても、ツリーのノードと警告を正しく対応付けるために使う */
	target?: string;
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
		push({ ruleId: 'R1', severity: 'error', message: L('frontmatter に name がありません', 'No name in the frontmatter'), file: unit.skillMdPath, line: 0 });
	} else {
		if (name.length > 64) {
			push({ ruleId: 'R1', severity: 'error', message: L(`name が64文字を超えています（${name.length}文字）`, `The name exceeds 64 characters (${name.length})`), file: unit.skillMdPath, line: fm.nameLine });
		}
		if (!/^[a-z0-9-]+$/.test(name)) {
			push({ ruleId: 'R1', severity: 'error', message: L('name は小文字英数字とハイフンのみで書いてください', 'Use only lowercase letters, digits and hyphens for the name'), file: unit.skillMdPath, line: fm.nameLine });
		}
		if (name.startsWith('-') || name.endsWith('-')) {
			push({ ruleId: 'R1', severity: 'error', message: L('name の先頭・末尾にハイフンは使えません', 'The name must not start or end with a hyphen'), file: unit.skillMdPath, line: fm.nameLine });
		}
		if (name.includes('--')) {
			push({ ruleId: 'R1', severity: 'error', message: L('name に連続するハイフン（--）は使えません', 'The name must not contain consecutive hyphens (--)'), file: unit.skillMdPath, line: fm.nameLine });
		}
		if (name !== path.basename(unit.dir)) {
			push({ ruleId: 'R1', severity: 'error', message: L(`name（${name}）とディレクトリ名（${path.basename(unit.dir)}）が一致しません`, `The name (${name}) does not match the directory name (${path.basename(unit.dir)})`), file: unit.skillMdPath, line: fm.nameLine });
		}
	}

	// R2: description
	const description = (fm.description ?? '').trim();
	if (settings.descriptionMaxLength > 0) {
		if (!description) {
			push({ ruleId: 'R2', severity: 'error', message: L('frontmatter に description がありません', 'No description in the frontmatter'), file: unit.skillMdPath, line: 0 });
		} else if (description.length > settings.descriptionMaxLength) {
			push({ ruleId: 'R2', severity: 'error', message: L(`description が${settings.descriptionMaxLength}文字を超えています（${description.length}文字）`, `The description exceeds ${settings.descriptionMaxLength} characters (${description.length})`), file: unit.skillMdPath, line: fm.descriptionLine });
		}
	}

	// R12: frontmatter 任意フィールドの上限（compatibility は仕様で 1〜500 文字）
	const compatibility = (fm.values['compatibility'] ?? '').trim();
	if (compatibility.length > 500) {
		push({
			ruleId: 'R12',
			severity: 'warn',
			message: L(
				`compatibility が500文字を超えています（${compatibility.length}文字）`,
				`compatibility exceeds 500 characters (${compatibility.length})`,
			),
			file: unit.skillMdPath,
			line: 0,
		});
	}

	// R3: 利用シーンの手がかり
	if (description) {		const lower = description.toLowerCase();
		const hasWhen = WHEN_KEYWORDS.some((k) => lower.includes(k));
		if (!hasWhen) {
			push({ ruleId: 'R3', severity: 'info', message: L('description に「いつ使うか」の手がかりが見当たりません', 'The description has no cue about when to use this skill'), file: unit.skillMdPath, line: fm.descriptionLine });
		}
	}

	// R4: 本文行数
	if (settings.skillBodyMaxLines > 0 && unit.bodyLines > settings.skillBodyMaxLines) {
		push({ ruleId: 'R4', severity: 'warn', message: L(`SKILL.md 本文が${settings.skillBodyMaxLines}行を超えています（${unit.bodyLines}行）`, `The SKILL.md body exceeds ${settings.skillBodyMaxLines} lines (${unit.bodyLines} lines)`), file: unit.skillMdPath, line: fm.bodyStartLine });
	}

	// R5: SKILL.md トークン
	if (settings.skillBodyMaxTokens > 0 && unit.skillMdTokens > settings.skillBodyMaxTokens) {
		push({ ruleId: 'R5', severity: 'warn', message: L(`SKILL.md の推定トークンが上限を超えています（約${unit.skillMdTokens.toLocaleString()} / 上限 約${settings.skillBodyMaxTokens.toLocaleString()}）`, `SKILL.md estimated tokens exceed the limit (approx. ${unit.skillMdTokens.toLocaleString()} / limit approx. ${settings.skillBodyMaxTokens.toLocaleString()})`), file: unit.skillMdPath, line: 0 });
	}

	// R6: 参照の深さ（スキル所有ファイル内のみ）
	if (settings.maxReferenceDepth > 0) {
		for (const [p, depth] of unit.depthOwned) {
			if (p !== unit.skillMdPath && depth > settings.maxReferenceDepth) {
				push({ ruleId: 'R6', severity: 'warn', message: L(`参照の深さが上限を超えています（深さ${depth} / 上限 ${settings.maxReferenceDepth}）`, `Reference depth exceeds the limit (depth ${depth} / limit ${settings.maxReferenceDepth})`), file: p, line: 0 });
			}
		}
	}

	// R7: 参照切れ（スキル外の構造チェック含む）
	// リンク記法・パス付きの表記は参照の意図が明示的と考え、存在しなければ警告する。
	// R13: コードスパンのファイル名のみの言及は参照の意図と断定できないため、
	// 「参照切れ」とはせず、意図と合っているかの確認を促す注記（info）にする。
	for (const [from, info] of unit.files) {
		for (const edge of info.refs) {
			if (edge.exists) {
				continue;
			}
			if (isTentativeMention(edge)) {
				push({ ruleId: 'R13', severity: 'info', message: L(`同名のファイルが見つかりません: ${edge.raw}`, `No file with this name was found: ${edge.raw}`), file: from, line: edge.line, target: edge.target });
			} else {
				push({ ruleId: 'R7', severity: 'info', message: L(`参照先が見つかりません: ${edge.raw}`, `Reference target was not found: ${edge.raw}`), file: from, line: edge.line, target: edge.target });
			}
		}
	}

	// R8: 循環参照
	for (const cycle of findCycles(unit)) {
		push({ ruleId: 'R8', severity: 'warn', message: L(`循環参照があります: ${path.basename(cycle.from)} → ${path.basename(cycle.to)}`, `Reference cycle: ${path.basename(cycle.from)} → ${path.basename(cycle.to)}`), file: cycle.from, line: cycle.line });
	}

	// R9: 孤立ファイル
	if (settings.orphanFiles !== 'off') {
		for (const orphan of unit.orphans) {
			push({ ruleId: 'R9', severity: settings.orphanFiles, message: L('どこからも参照されていません', 'Not referenced from anywhere'), file: orphan });
		}
	}

	// R10: 全体予算
	if (settings.skillTotalTokenBudget > 0) {
		const total = totalOwnedTokens(unit);
		if (total > settings.skillTotalTokenBudget) {
			push({ ruleId: 'R10', severity: 'warn', message: L(`スキル全体の推定トークンが予算を超えています（約${total.toLocaleString()} / 予算 約${settings.skillTotalTokenBudget.toLocaleString()}）`, `Whole-skill estimated tokens exceed the budget (approx. ${total.toLocaleString()} / budget approx. ${settings.skillTotalTokenBudget.toLocaleString()})`), file: unit.skillMdPath, line: 0 });
		}
	}

	// R11: 複製ドリフト
	for (const copy of skill.copies) {
		const drift = driftBetween(unit, copy);
		const total = drift.missing.length + drift.extra.length + drift.differing.length;
		if (total > 0) {
			const parts: string[] = [];
			if (drift.missing.length > 0) {
				parts.push(L(`不足 ${drift.missing.length}件`, `${drift.missing.length} missing`));
			}
			if (drift.differing.length > 0) {
				parts.push(L(`不一致 ${drift.differing.length}件`, `${drift.differing.length} differing`));
			}
			if (drift.extra.length > 0) {
				parts.push(L(`余分 ${drift.extra.length}件`, `${drift.extra.length} extra`));
			}
			push({
				ruleId: 'R11',
				severity: 'warn',
				message: L(`正本との乖離があります（${parts.join(L('、', ', '))}）`, `Drift from the canonical source (${parts.join(', ')})`),
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
	relPathsByRoot: ReadonlyMap<string, string[]>,
	settings: RuleSettings,
): SkillWarning[] {
	const warnings: SkillWarning[] = [];
	for (const unit of units) {
		// S6: inclusion の想定外の値（綴り間違いは常時ロードにフォールバックする）
		if (unit.inclusionExplicit && unit.inclusionRaw !== undefined && !['always', 'fileMatch', 'manual'].includes(unit.inclusionRaw)) {
			warnings.push({
				ruleId: 'S6',
				severity: 'warn',
				message: L(
					`inclusion の値「${unit.inclusionRaw}」は想定外です（always / fileMatch / manual のいずれか）`,
					`inclusion value "${unit.inclusionRaw}" is not one of always / fileMatch / manual`,
				),
				file: unit.filePath,
				line: 0,
			});
		}
		// S1: inclusion 未指定
		// ただし Kiro が自動生成する予約 Steering（.kiro/steering 直下の product/structure/tech）は
		// 常時ロードが前提の設計で inclusion を書かないのが正規の形のため、警告から除外する
		const isKiroReserved =
			['product.md', 'structure.md', 'tech.md'].includes(path.basename(unit.filePath)) &&
			path.basename(path.dirname(unit.filePath)) === 'steering';
		if (!unit.inclusionExplicit && !isKiroReserved) {
			warnings.push({
				ruleId: 'S1',
				severity: 'info',
				message: L('inclusion が未指定です（暗黙に常時ロード扱いになります）', 'inclusion is not specified (implicitly treated as always loaded)'),
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
					message: L('inclusion: fileMatch ですが fileMatchPattern がありません', 'inclusion is fileMatch but fileMatchPattern is missing'),
					file: unit.filePath,
					line: 0,
				});
			} else if (!patternMatchesAny(unit.fileMatchPattern, relPathsByRoot.get(unit.workspaceRoot) ?? [])) {
				// S2 の照合は所属フォルダ内のファイルだけを対象にする（マルチルートで
				// 別フォルダの同名パスに誤って一致させない）
				warnings.push({
					ruleId: 'S2',
					severity: 'warn',
					message: L(`fileMatchPattern「${unit.fileMatchPattern}」に一致するファイルがワークスペース内にありません`, `fileMatchPattern "${unit.fileMatchPattern}" matches no file in the workspace`),
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
				message: L('正本（.agents 配下）と内容が乖離しています', 'Content differs from the canonical source (under .agents)'),
				file: unit.filePath,
				line: 0,
			});
		}
	}
	// S3: 常時ロード合計の予算
	// S3: 常時ロード合計の予算（フォルダごとに集計する。別リポジトリの分は合算しない）
	if (settings.steeringAlwaysTokenBudget > 0 && units.length > 0) {
		const byRoot = new Map<string, SteeringUnit[]>();
		for (const u of units) {
			const arr = byRoot.get(u.workspaceRoot) ?? [];
			arr.push(u);
			byRoot.set(u.workspaceRoot, arr);
		}
		for (const rootUnits of byRoot.values()) {
			const alwaysUnits = rootUnits.filter((u) => u.inclusion === 'always');
			const total = alwaysUnits.reduce((s, u) => s + u.tokens, 0);
			if (total > settings.steeringAlwaysTokenBudget) {
				warnings.push({
					ruleId: 'S3',
					severity: 'warn',
					message: L(`Steering 常時ロードの合計が予算を超えています（約${total.toLocaleString()} / 予算 約${settings.steeringAlwaysTokenBudget.toLocaleString()}）`, `Total always-loaded steering tokens exceed the budget (approx. ${total.toLocaleString()} / budget approx. ${settings.steeringAlwaysTokenBudget.toLocaleString()})`),
					file: path.dirname(rootUnits[0].filePath),
				});
			}
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
					message: L(`Spec「${unit.name}」に ${f.fileName} がありません`, `Spec "${unit.name}" is missing ${f.fileName}`),
					file: unit.dir,
				});
			}
		}
	}
	return warnings;
}
