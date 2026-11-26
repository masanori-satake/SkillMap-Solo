import * as path from 'node:path';
import * as vscode from 'vscode';
import { isTentativeMention, layerLabel, reachableTokens, rootLabels, sameNameLocationTag, type FileGraph, type LogicalSkill, type SkillUnit } from './skills.js';
import type { CopilotUnit, SpecUnit, SteeringUnit } from './contexts.js';
import { RULES, totalOwnedTokens, type SkillWarning } from './rules.js';
import { renderTipSummary, tipCommandUri } from './tips.js';
import { L } from './i18n.js';
import { escapeMarkdownText } from './markdown.js';
import type { CopyTreeNode } from './copyTree.js';

export type NodeKind =
	| 'section'
	| 'skill'
	| 'file'
	| 'missing'
	| 'cycle'
	| 'orphanGroup'
	| 'orphan'
	| 'steering'
	| 'spec'
	| 'copilot';

export type SectionId = 'skills' | 'steering' | 'specs' | 'copilot';

export class MapNode {
	kind: NodeKind;
	sectionId?: SectionId;
	skill?: LogicalSkill;
	unit?: SkillUnit;
	graph?: FileGraph;
	steeringUnit?: SteeringUnit;
	specUnit?: SpecUnit;
	copilotUnit?: CopilotUnit;
	filePath?: string;
	parent?: MapNode;
	children?: MapNode[];
	warnings: SkillWarning[] = [];
	boundary = false;
	shared = false;
	/** 未解決ノードが「ファイル名のみの言及」（R13）の場合に true */
	tentative = false;
	/** 参照元ファイル内での出現行（0始まり）。集約された重複言及の表示用 */
	mentionLines: number[] = [];
	labelOverride?: string;

	constructor(kind: NodeKind) {
		this.kind = kind;
	}

	get ownTokens(): number {
		if (this.kind === 'steering' && this.steeringUnit) {
			return this.steeringUnit.tokens;
		}
		if (this.kind === 'copilot' && this.copilotUnit) {
			return this.copilotUnit.tokens;
		}
		if (this.kind === 'spec' && this.specUnit) {
			return this.specUnit.totalTokens;
		}
		if (!this.filePath) {
			return 0;
		}
		if (this.graph) {
			return this.graph.files.get(this.filePath)?.tokens ?? 0;
		}
		if (this.unit) {
			return this.unit.files.get(this.filePath)?.tokens ?? 0;
		}
		return 0;
	}

	subtreeTokens(seen: Set<string> = new Set()): number {
		let total = 0;
		if (this.filePath && !seen.has(this.filePath)) {
			seen.add(this.filePath);
			total += this.ownTokens;
		}
		for (const child of this.children ?? []) {
			total += child.subtreeTokens(seen);
		}
		return total;
	}

	pathFiles(): MapNode[] {
		const chain: MapNode[] = [];
		let current: MapNode | undefined = this;
		while (current) {
			if (current.filePath) {
				chain.unshift(current);
			}
			current = current.parent;
		}
		return chain;
	}

	pathTokens(): number {
		return this.pathFiles().reduce((sum, n) => sum + n.ownTokens, 0);
	}

	allWarnings(): SkillWarning[] {
		// 同じ警告がファイルノードとその未解決プレースホルダーの両方に付くことが
		// あるため、集計では同一の警告を1回だけ数える（二重数えの防止）
		const seen = new Set<string>();
		const out: SkillWarning[] = [];
		const visit = (node: MapNode): void => {
			for (const w of node.warnings) {
				const key = `${w.ruleId}|${w.file}|${w.line ?? ''}|${w.target ?? ''}|${w.message}`;
				if (!seen.has(key)) {
					seen.add(key);
					out.push(w);
				}
			}
			for (const child of node.children ?? []) {
				visit(child);
			}
		};
		visit(this);
		return out;
	}

	/** ⚠バッジの件数（R7 / R13 は参考情報であり、件数には数えない） */
	badgeWarnings(): number {
		return this.allWarnings().filter((w) => w.ruleId !== 'R13' && w.ruleId !== 'R7').length;
	}
}

/** ⚠バッジの件数（配列版。R7 / R13 は数えない） */
function badgeCount(warnings: SkillWarning[]): number {
	return warnings.filter((w) => w.ruleId !== 'R13' && w.ruleId !== 'R7').length;
}

/**
 * boundary（基準ディレクトリ外）の基準が何か。
 * スキルのファイルノードではスキルが基準だが、Steering / Specs のグラフでも
 * boundary は立つ（基準は Steering ファイルや Spec の配置ディレクトリ）。
 * 表示を「スキル外」に決め打ちすると Steering から SKILL.md を参照したときに
 * 誤解を招くため、祖先を辿って基準を判定する。
 */
type BoundaryFrame = 'skill' | 'steering' | 'spec';

function boundaryFrame(node: MapNode): BoundaryFrame {
	let current: MapNode | undefined = node;
	while (current) {
		if (current.unit) {
			return 'skill';
		}
		if (current.steeringUnit) {
			return 'steering';
		}
		if (current.specUnit) {
			return 'spec';
		}
		current = current.parent;
	}
	return 'skill';
}

function boundaryBadge(frame: BoundaryFrame): string {
	switch (frame) {
		case 'steering':
			return L('Steering外', 'outside steering');
		case 'spec':
			return L('Spec外', 'outside spec');
		default:
			return L('スキル外', 'external');
	}
}

export class SkillMapModel {
	skills: LogicalSkill[] = [];
	skillWarnings = new Map<string, SkillWarning[]>();
	steering: SteeringUnit[] = [];
	steeringWarnings: SkillWarning[] = [];
	specs: SpecUnit[] = [];
	specWarnings: SkillWarning[] = [];
	copilot: CopilotUnit[] = [];
	betaSpecs = true;

	alwaysSteeringTokens(): number {
		// 未解析のファイルは適用条件が未確定なので常時ロードに数えない
		return this.steering
			.filter((s) => s.inclusion === 'always' && !s.unparsed)
			.reduce((sum, s) => sum + s.tokens, 0);
	}
}

function countReferences(unit: SkillUnit): Map<string, number> {
	const perParent = new Map<string, Set<string>>();
	for (const info of unit.files.values()) {
		for (const edge of info.refs) {
			if (edge.exists && !edge.isDirectory) {
				const set = perParent.get(edge.target) ?? new Set<string>();
				set.add(info.absPath);
				perParent.set(edge.target, set);
			}
		}
	}
	const result = new Map<string, number>();
	for (const [target, set] of perParent) {
		result.set(target, set.size);
	}
	return result;
}

function sectionLabel(id: SectionId): string {
	switch (id) {
		case 'steering':
			return 'Steering (.kiro/steering)';
		case 'specs':
			return L('Specs（β）', 'Specs (Beta)');
		case 'copilot':
			return 'Copilot instructions';
		default:
			return 'Skills';
	}
}

/**
 * ツリー構築の総ノード数上限。表示側は経路単位でノードを作るため、ダイヤモンド型の
 * 共有参照が重なると経路数まで膨らむ（最大で指数的）。上限を超えた分は子を展開
 * しないプレースホルダに畳む。解析モデル（unit.files）自体は変えない、表示だけの制限
 */
const MAX_TREE_NODES = 5000;
/** ツリー構築の深さ上限（再帰の深さ＝コールスタックの深さになるため） */
const MAX_TREE_DEPTH = 200;

export class SkillTreeProvider implements vscode.TreeDataProvider<MapNode> {
	private _onDidChangeTreeData = new vscode.EventEmitter<MapNode | undefined | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	/** 構築中の残りノード予算（buildSections のたびにリセット） */
	private nodeBudget = MAX_TREE_NODES;
	/** 直近に構築したセクション（すべて展開の走査用） */
	private sections: MapNode[] = [];
	/** 利用者が手で開閉したノード（キー→展開状態）。再構築をまたいで保持する */
	private toggledExpansion = new Map<string, boolean>();

	constructor(private model: SkillMapModel) {}

	/**
	 * ノードの安定キー（親チェーン＋ノード識別子）。
	 * TreeItem.id に使うことで再構築後も VS Code が展開状態を復元でき、
	 * 「表示中のツリーをコピー」も実際の表示と一致させられる
	 */
	keyFor(node: MapNode): string {
		const segment = (n: MapNode): string => {
			switch (n.kind) {
				case 'section':
					return `section:${n.sectionId ?? ''}`;
				case 'skill':
					return `skill:${n.unit?.dir ?? n.skill?.unit.dir ?? ''}`;
				case 'steering':
					return `steering:${n.steeringUnit?.filePath ?? n.filePath ?? ''}`;
				case 'spec':
					return `spec:${n.specUnit?.dir ?? ''}`;
				case 'copilot':
					return `copilot:${n.copilotUnit?.filePath ?? n.filePath ?? ''}`;
				case 'orphanGroup':
					return 'orphanGroup';
				default:
					return `${n.kind}:${n.filePath ?? n.labelOverride ?? ''}`;
			}
		};
		const chain: string[] = [];
		let current: MapNode | undefined = node;
		while (current) {
			chain.unshift(segment(current));
			current = current.parent;
		}
		return chain.join('\n');
	}

	/** ツリーの開閉イベントを受けたときに呼ぶ（展開状態の記録） */
	noteExpansion(node: MapNode, expanded: boolean): void {
		this.toggledExpansion.set(this.keyFor(node), expanded);
	}

	/** 記録とデフォルト（Skills セクションは開いた状態で始まる）から見た展開状態 */
	private isExpanded(node: MapNode): boolean {
		const toggled = this.toggledExpansion.get(this.keyFor(node));
		if (toggled !== undefined) {
			return toggled;
		}
		return node.kind === 'section' && node.sectionId === 'skills';
	}

	/** コピー用に、表示ラベル・説明・展開状態つきの素のツリーへ変換する */
	buildCopyForest(): CopyTreeNode[] {
		const toCopy = (node: MapNode): CopyTreeNode => ({
			label: this.labelFor(node),
			description: this.descriptionFor(node) || undefined,
			expanded: this.isExpanded(node),
			children: (node.children ?? []).map(toCopy),
		});
		return this.getChildren().map(toCopy);
	}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	/** 「すべて展開」の対象（子を持つ全ノード、上位から順） */
	collectExpandable(): MapNode[] {
		const walk = (n: MapNode): MapNode[] => [n, ...(n.children ?? []).flatMap(walk)];
		return this.sections.flatMap(walk).filter((n) => (n.children?.length ?? 0) > 0);
	}

	/** 「すべて展開」: 子を持つ全ノードを上位から順に展開する（標準の「すべて折りたたむ」の対）。
	 * onProgress が渡された場合は進捗を通知し、token のキャンセルで中断する */
	async expandAll(
		treeView: vscode.TreeView<MapNode>,
		onProgress?: (done: number, total: number) => void,
		token?: vscode.CancellationToken,
	): Promise<void> {
		const expandable = this.collectExpandable();
		let done = 0;
		for (const n of expandable) {
			if (token?.isCancellationRequested) {
				break;
			}
			try {
				await treeView.reveal(n, { expand: true, select: false, focus: false });
			} catch {
				// 表示されていないノード等で失敗しても他を続行する
			}
			done++;
			onProgress?.(done, expandable.length);
		}
	}

	getTreeItem(node: MapNode): vscode.TreeItem {
		const item = new vscode.TreeItem(this.labelFor(node), this.collapsibleStateFor(node));
		item.id = this.keyFor(node);
		item.description = this.descriptionFor(node);
		item.iconPath = this.iconFor(node);
		item.contextValue = this.contextFor(node);
		item.tooltip = this.tooltipFor(node);
		if (node.filePath && node.kind !== 'section') {
			item.command = {
				command: 'skillmap.openFile',
				title: L('ファイルを開く', 'Open File'),
				arguments: [node],
			};
		}
		return item;
	}

	getChildren(node?: MapNode): MapNode[] {
		if (!node) {
			this.sections = this.buildSections();
			return this.sections;
		}
		return node.children ?? [];
	}

	getParent(node: MapNode): MapNode | undefined {
		return node.parent;
	}

	// ---- セクション ----

	private buildSections(): MapNode[] {
		this.nodeBudget = MAX_TREE_NODES;
		const sections: MapNode[] = [];
		const make = (id: SectionId, children: MapNode[], warnings: SkillWarning[] = []): MapNode => {
			const section = new MapNode('section');
			section.sectionId = id;
			section.children = children;
			section.warnings = warnings;
			for (const child of children) {
				child.parent = section;
			}
			return section;
		};
		if (this.model.skills.length > 0) {
			sections.push(make('skills', this.model.skills.map((s) => this.buildSkillRoot(s))));
		}
		if (this.model.steering.length > 0) {
			// S3 はフォルダごとに生成される（file = 各フォルダの steering ディレクトリ）。
			// Diagnostics には出さない警告のため、全フォルダ分をここで集めないと見えなくなる
			const sectionWarnings = this.model.steeringWarnings.filter((w) => w.ruleId === 'S3');
			sections.push(make('steering', this.model.steering.map((s) => this.buildSteeringNode(s)), sectionWarnings));
		}
		if (this.model.betaSpecs && this.model.specs.length > 0) {
			sections.push(make('specs', this.model.specs.map((s) => this.buildSpecNode(s))));
		}
		if (this.model.copilot.length > 0) {
			sections.push(make('copilot', this.model.copilot.map((c) => this.buildCopilotNode(c))));
		}
		return sections;
	}

	// ---- Skills ----

	private buildSkillRoot(skill: LogicalSkill): MapNode {
		const root = new MapNode('skill');
		root.skill = skill;
		root.unit = skill.unit;
		const warnings = this.model.skillWarnings.get(skill.key) ?? [];
		root.warnings = warnings.filter((w) => w.file === skill.unit.skillMdPath && w.ruleId === 'R10');
		const children: MapNode[] = [];
		children.push(this.buildFileNode(skill, skill.unit, skill.unit.skillMdPath, root, []));
		if (skill.unit.orphans.length > 0) {
			const group = new MapNode('orphanGroup');
			group.skill = skill;
			group.unit = skill.unit;
			group.parent = root;
			// 未参照ファイルも共有予算を消費する。予算を消費しない経路があると、
			// 参照されていないファイルが大量にあるスキルで総ノード数の上限が
			// 成立しない。予算到達後は残りを個別には作らず、省略を1ノードにまとめる
			const orphanChildren: MapNode[] = [];
			for (const orphanPath of skill.unit.orphans) {
				if (this.nodeBudget <= 0) {
					orphanChildren.push(this.makeOmittedNode(group, skill, skill.unit));
					break;
				}
				this.nodeBudget--;
				const orphan = new MapNode('orphan');
				orphan.skill = skill;
				orphan.unit = skill.unit;
				orphan.filePath = orphanPath;
				orphan.parent = group;
				orphan.warnings = warnings.filter((w) => w.file === orphanPath);
				orphanChildren.push(orphan);
			}
			group.children = orphanChildren;
			children.push(group);
		}
		root.children = children;
		return root;
	}

	/** 予算到達後に残りの兄弟をまとめて省略したことを示すプレースホルダ。
	 * 兄弟を1件ずつプレースホルダ化すると上限自体が意味を失うため、
	 * 省略は親ごとに1ノードだけにし、「参照がない」場合と区別できるようにする */
	private makeOmittedNode(parent: MapNode, skill?: LogicalSkill, unit?: SkillUnit, graph?: FileGraph): MapNode {
		const node = new MapNode('file');
		node.skill = skill;
		node.unit = unit;
		node.graph = graph;
		node.parent = parent;
		node.labelOverride = L('（表示上限で省略）', '(omitted at display limit)');
		node.children = [];
		return node;
	}

	private buildFileNode(
		skill: LogicalSkill,
		unit: SkillUnit,
		filePath: string,
		parent: MapNode,
		ancestorChain: string[],
	): MapNode {
		if (this.nodeBudget <= 0 || ancestorChain.length >= MAX_TREE_DEPTH) {
			// 上限超過分は子を展開しないプレースホルダに畳む（ファイル自体は開ける）。
			// プレースホルダも予算を消費する（深さ上限到達後の一親からの大量の
			// 参照で、予算を消費しないプレースホルダが際限なく増えないように）。
			// 自分自身の警告は保持する（親のバッジ集計から消えないように）
			this.nodeBudget--;
			const node = new MapNode('file');
			node.skill = skill;
			node.unit = unit;
			node.filePath = filePath;
			node.parent = parent;
			node.labelOverride = `${path.basename(filePath)} ${L('（表示上限）', '(display limit)')}`;
			node.boundary = unit.files.get(filePath)?.boundary ?? false;
			if (unit === skill.unit) {
				const warnings = this.model.skillWarnings.get(skill.key) ?? [];
				node.warnings = warnings.filter((w) => w.file === filePath);
			}
			node.children = [];
			return node;
		}
		this.nodeBudget--;
		const info = unit.files.get(filePath);
		const node = new MapNode('file');
		node.skill = skill;
		node.unit = unit;
		node.filePath = filePath;
		node.parent = parent;
		node.boundary = info?.boundary ?? false;
		const refCounts = countReferences(unit);
		node.shared = (refCounts.get(filePath) ?? 0) > 1 && filePath !== unit.skillMdPath;
		if (unit === skill.unit) {
			const warnings = this.model.skillWarnings.get(skill.key) ?? [];
			node.warnings = warnings.filter((w) => w.file === filePath);
		}
		const chain = [...ancestorChain, filePath];
		const children: MapNode[] = [];
		if (info && !info.isDirectory) {
			for (const edge of info.refs) {
				// 子ノードは生成経路（ディレクトリ・未解決・循環・通常）によらず
				// すべて共有予算を消費する。予算到達後は残りの兄弟を個別には
				// 作らず、省略を1ノードにまとめて打ち切る
				if (this.nodeBudget <= 0) {
					children.push(this.makeOmittedNode(node, skill, unit));
					break;
				}
				if (edge.isDirectory) {
					this.nodeBudget--;
					const dirNode = new MapNode('file');
					dirNode.skill = skill;
					dirNode.unit = unit;
					dirNode.filePath = edge.target;
					dirNode.parent = node;
					dirNode.boundary = unit.files.get(edge.target)?.boundary ?? false;
					children.push(dirNode);
					continue;
				}
				if (!edge.exists) {
					this.nodeBudget--;
					const missing = new MapNode('missing');
					missing.skill = skill;
					missing.unit = unit;
					missing.filePath = edge.target;
					missing.parent = node;
					missing.tentative = isTentativeMention(edge);
					missing.mentionLines = edge.lines;
					if (unit === skill.unit) {
						const warnings = this.model.skillWarnings.get(skill.key) ?? [];
						missing.warnings = warnings.filter((w) => (w.ruleId === 'R7' || w.ruleId === 'R13') && w.file === filePath && w.line === edge.line && w.target === edge.target);
					}
					children.push(missing);
					continue;
				}
				if (chain.includes(edge.target)) {
					this.nodeBudget--;
					const cycle = new MapNode('cycle');
					cycle.skill = skill;
					cycle.unit = unit;
					cycle.filePath = edge.target;
					cycle.parent = node;
					if (unit === skill.unit) {
						const warnings = this.model.skillWarnings.get(skill.key) ?? [];
						cycle.warnings = warnings.filter((w) => w.ruleId === 'R8' && w.file === filePath && w.line === edge.line);
					}
					children.push(cycle);
					continue;
				}
				// 通常の子は buildFileNode の入口で予算を消費する（入口の
				// プレースホルダ判定が、予算切れの再帰を1件で止める）
				children.push(this.buildFileNode(skill, unit, edge.target, node, chain));
			}
		}
		node.children = children;
		return node;
	}

	// ---- Steering / Specs / Copilot ----

	private buildSteeringNode(unit: SteeringUnit): MapNode {
		const node = new MapNode('steering');
		node.steeringUnit = unit;
		node.filePath = unit.filePath;
		node.warnings = this.model.steeringWarnings.filter((w) => w.file === unit.filePath);
		node.children = this.buildGraphChildren(unit.graph, unit.filePath, node, [unit.filePath]);
		return node;
	}

	private buildGraphChildren(graph: FileGraph, filePath: string, parent: MapNode, chain: string[]): MapNode[] {
		const info = graph.files.get(filePath);
		const children: MapNode[] = [];
		if (!info || info.isDirectory) {
			return children;
		}
		for (const edge of info.refs) {
			if (edge.isDirectory) {
				continue;
			}
			if (this.nodeBudget <= 0) {
				// 総ノード数上限に達したら、残りの兄弟は個別には作らず省略を
				// 1ノードにまとめる（「参照がない」場合と区別できるように。
				// 先行セクションが予算を使い切った場合も同様）
				children.push(this.makeOmittedNode(parent, undefined, undefined, graph));
				break;
			}
			this.nodeBudget--;
			if (!edge.exists) {
				const missing = new MapNode('missing');
				missing.graph = graph;
				missing.filePath = edge.target;
				missing.parent = parent;
				missing.tentative = isTentativeMention(edge);
				missing.mentionLines = edge.lines;
				children.push(missing);
				continue;
			}
			if (chain.includes(edge.target)) {
				const cycle = new MapNode('cycle');
				cycle.graph = graph;
				cycle.filePath = edge.target;
				cycle.parent = parent;
				children.push(cycle);
				continue;
			}
			const child = new MapNode('file');
			child.graph = graph;
			child.filePath = edge.target;
			child.parent = parent;
			child.boundary = graph.files.get(edge.target)?.boundary ?? false;
			// 深さ上限に達したら子は展開しない（プレースホルダとして畳む）
			child.children =
				chain.length >= MAX_TREE_DEPTH
					? []
					: this.buildGraphChildren(graph, edge.target, child, [...chain, edge.target]);
			if (chain.length >= MAX_TREE_DEPTH) {
				child.labelOverride = `${path.basename(edge.target)} ${L('（表示上限）', '(display limit)')}`;
			}
			children.push(child);
		}
		return children;
	}

	private buildSpecNode(unit: SpecUnit): MapNode {
		const node = new MapNode('spec');
		node.specUnit = unit;
		node.warnings = this.model.specWarnings.filter((w) => w.file === unit.dir);
		node.children = unit.files.map((f) => {
			if (!f.present) {
				const missing = new MapNode('missing');
				missing.specUnit = unit;
				missing.filePath = f.filePath;
				missing.labelOverride = `${f.fileName}${L('（欠落）', ' (missing)')}`;
				missing.parent = node;
				missing.warnings = this.model.specWarnings.filter((w) => w.file === unit.dir && w.message.includes(f.fileName));
				return missing;
			}
			const child = new MapNode('file');
			child.specUnit = unit;
			child.graph = f.graph;
			child.filePath = f.filePath;
			child.parent = node;
			child.children = f.graph ? this.buildGraphChildren(f.graph, f.filePath, child, [f.filePath]) : [];
			return child;
		});
		return node;
	}

	private buildCopilotNode(unit: CopilotUnit): MapNode {
		const node = new MapNode('copilot');
		node.copilotUnit = unit;
		node.filePath = unit.filePath;
		node.children = [];
		return node;
	}

	// ---- 表示 ----

	private labelFor(node: MapNode): string {
		if (node.labelOverride) {
			return node.labelOverride;
		}
		switch (node.kind) {
			case 'section':
				return sectionLabel(node.sectionId ?? 'skills');
			case 'skill':
				return node.skill?.name ?? '';
			case 'orphanGroup':
				return L('未参照ファイル', 'Unreferenced files');
			case 'steering':
				return path.basename(node.filePath ?? '');
			case 'spec':
				return node.specUnit?.name ?? '';
			case 'copilot':
				return node.copilotUnit?.name ?? '';
			case 'missing':
				// ラベルはファイル名のみ。状態は説明（1語）とホバーが担う（§10.1）
				return path.basename(node.filePath ?? '');
			case 'cycle':
				return `${path.basename(node.filePath ?? '')} ${L('（循環）', '(cycle)')}`;
			default:
				return path.basename(node.filePath ?? '');
		}
	}

	/**
	 * セクション／スキル単位の警告集計は、表示木ではなく解析モデルから取る。
	 * 表示木は深さ・総ノード数の上限で切り詰められ、上限の先にある警告
	 * （深い場所の R8 等）がバッジやホバーから消えてしまうため。表示だけを
	 * 変えて対象（集計結果）を変えない、という原則に基づく。
	 * 対象外のノードでは undefined を返し、呼び出し側は表示木の集計に倒す
	 */
	private aggregateWarnings(node: MapNode): SkillWarning[] | undefined {
		if (node.kind === 'skill' && node.skill) {
			return this.model.skillWarnings.get(node.skill.key) ?? [];
		}
		if (node.kind === 'section') {
			switch (node.sectionId) {
				case 'skills':
					return this.model.skills.flatMap((s) => this.model.skillWarnings.get(s.key) ?? []);
				case 'steering':
					return this.model.steeringWarnings;
				case 'specs':
					return this.model.specWarnings;
				default:
					return undefined;
			}
		}
		return undefined;
	}

	/**
	 * 警告の取得（Tips 操作など、ツリー表示以外からの利用向け）。集計対象
	 * ノードはモデルから、それ以外は表示木から返す。contextFor / tooltipFor
	 * と同じ倒し方に揃え、表示上限の先にある警告も Tips から辿れるようにする
	 */
	warningsFor(node: MapNode): SkillWarning[] {
		return this.aggregateWarnings(node) ?? node.allWarnings();
	}

	/** バッジ用の警告件数（集計対象ノードはモデルから、それ以外は表示木から） */
	private badgeOf(node: MapNode): number {
		const agg = this.aggregateWarnings(node);
		return agg ? badgeCount(agg) : node.badgeWarnings();
	}

	private descriptionFor(node: MapNode): string | undefined {
		const warn = (n: number) => (n > 0 ? ` ⚠${n}` : '');
		// マルチルートで同名が複数あるときだけ、所属フォルダの表示名を付けて見分けられるようにする
		const folderTag = (name: string, root: string, items: Array<{ name: string; root: string }>): string => {
			const same = items.filter((x) => x.name === name);
			// 同名が複数でも全て同じルート内なら、フォルダ名は見分けにならない
			// （スキルの配置場所タグ側で見分ける）
			if (!root || same.length <= 1 || new Set(same.map((x) => x.root)).size <= 1) {
				return '';
			}
			const labels = rootLabels(same.map((x) => x.root));
			return ` · ${labels.get(root) ?? path.basename(root)}`;
		};
		switch (node.kind) {
			case 'section': {
				if (node.sectionId === 'steering') {
					// 複数フォルダにまたがる場合は常時ロード合計が意味を持たないため件数表示にする
					const roots = new Set(this.model.steering.map((u) => u.workspaceRoot));
					if (roots.size > 1) {
						return L(`${this.model.steering.length}件`, `${this.model.steering.length}`) + warn(this.badgeOf(node));
					}
					const always = this.model.alwaysSteeringTokens();
					return `${L('常時ロード合計', 'Always-loaded total')} ≈${always.toLocaleString()} tok${warn(this.badgeOf(node))}`;
				}
				if (node.sectionId === 'skills') {
					return L(`${this.model.skills.length}件`, `${this.model.skills.length}`) + warn(this.badgeOf(node));
				}
				if (node.sectionId === 'specs') {
					return L(`${this.model.specs.length}件`, `${this.model.specs.length}`) + warn(this.badgeOf(node));
				}
				if (node.sectionId === 'copilot') {
					const total = this.model.copilot.reduce((s, c) => s + c.tokens, 0);
					return `≈${total.toLocaleString()} tok`;
				}
				return undefined;
			}
			case 'skill': {
				const total = node.skill ? totalOwnedTokens(node.skill.unit) : 0;
				const tag = node.skill ? folderTag(node.skill.name, node.skill.unit.sourceRoot, this.model.skills.map((s) => ({ name: s.name, root: s.unit.sourceRoot }))) : '';
				const locTag = node.skill ? sameNameLocationTag(this.model.skills, node.skill) : '';
				return `${L('合計', 'Total')} ≈${total.toLocaleString()} tok${warn(this.badgeOf(node))}${locTag}${tag}`;
			}
			case 'orphanGroup': {
				// 件数は表示木の子数ではなく解析モデルから取る。表示木は総ノード数
				// 上限で未参照ファイルを省略ノードに畳むため、子数だと省略の有無で
				// 件数が変わってしまう（表示だけを変えて対象を変えない、という原則）
				const count = node.unit?.orphans.length ?? node.children?.length ?? 0;
				return L(`${count}件`, `${count}`);
			}
			case 'steering': {
				const u = node.steeringUnit!;
				const badge = u.unparsed
					? L('未解析', 'unparsed')
					: u.inclusion === 'always'
						? L('常時', 'always')
						: u.inclusion === 'fileMatch'
							? L('条件', 'conditional')
							: L('手動', 'manual');
				return `${badge} · ≈${u.tokens.toLocaleString()} tok${warn(badgeCount(node.warnings))}${folderTag(u.name, u.workspaceRoot, this.model.steering.map((x) => ({ name: x.name, root: x.workspaceRoot })))}`;
			}
			case 'spec': {
				const missing = node.specUnit?.files.filter((f) => !f.present).length ?? 0;
				let tag = '';
				if (node.specUnit) {
					const roots = [...new Set(this.model.specs.map((x) => x.workspaceRoot))];
					if (roots.length > 1) {
						// マルチルートでは同名でなくても、どのフォルダ（リポジトリ）の
						// Spec かを判別できるよう、常時フォルダ名を付ける
						const labels = rootLabels(roots);
						tag = ` · ${labels.get(node.specUnit.workspaceRoot) ?? path.basename(node.specUnit.workspaceRoot)}`;
					} else {
						tag = folderTag(node.specUnit.name, node.specUnit.workspaceRoot, this.model.specs.map((x) => ({ name: x.name, root: x.workspaceRoot })));
					}
				}
				return `≈${node.ownTokens.toLocaleString()} tok${missing > 0 ? L(` · 欠落${missing}`, ` · ${missing} missing`) : ''}${warn(badgeCount(node.warnings))}${tag}`;
			}
			case 'copilot': {
				const u = node.copilotUnit!;
				const mode = u.mode === 'always' ? L('常時', 'always') : `applyTo: ${u.applyTo ?? L('(未指定)', '(not set)')}`;
				return `${mode} · ≈${u.tokens.toLocaleString()} tok${folderTag(u.name, u.workspaceRoot, this.model.copilot.map((x) => ({ name: x.name, root: x.workspaceRoot })))}`;
			}
			case 'missing':
				if (node.specUnit) {
					return L('未作成', 'not created');
				}
				return node.tentative ? L('要確認', 'needs checking') : L('未解決', 'unresolved');
			case 'file':
			case 'orphan':
			case 'cycle': {
				const parts: string[] = [];
				parts.push(`≈${node.ownTokens.toLocaleString()} tok`);
				const depth = node.unit?.depthDisplay.get(node.filePath ?? '') ?? node.graph?.depthDisplay.get(node.filePath ?? '');
				if (depth !== undefined && node.unit && node.filePath !== node.unit.skillMdPath) {
					parts.push(layerLabel(depth));
				}
				if (node.shared) {
					parts.push(L('共有', 'shared'));
				}
				if (node.boundary) {
					parts.push(boundaryBadge(boundaryFrame(node)));
				}
				return parts.join(' · ') + warn(badgeCount(node.warnings));
			}
		}
		return undefined;
	}

	private iconFor(node: MapNode): vscode.ThemeIcon {
		switch (node.kind) {
			case 'section':
				return new vscode.ThemeIcon(
					node.sectionId === 'skills'
						? 'library'
						: node.sectionId === 'steering'
							? 'compass'
							: node.sectionId === 'specs'
								? 'checklist'
								: 'hubot',
				);
			case 'skill':
				return new vscode.ThemeIcon('library');
			case 'steering':
				return new vscode.ThemeIcon(
					node.warnings.length > 0 ? 'warning' : 'file',
					node.warnings.length > 0 ? new vscode.ThemeColor('editorWarning.foreground') : undefined,
				);
			case 'spec':
				return new vscode.ThemeIcon('notebook');
			case 'copilot':
				return new vscode.ThemeIcon('file');
			case 'orphanGroup':
				return new vscode.ThemeIcon('archive');
			case 'missing':
				// Spec の未作成ファイルは「作るべきものの欠落」なのでエラー表示を維持する
				if (node.specUnit) {
					return new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
				}
				// 未解決の参照は不具合と断定しないため、R7 / R13 ともに中立色のファイルアイコンにする
				return new vscode.ThemeIcon('file', new vscode.ThemeColor('disabledForeground'));
			case 'cycle':
				return new vscode.ThemeIcon('sync', new vscode.ThemeColor('editorWarning.foreground'));
			case 'orphan':
				return new vscode.ThemeIcon('file', new vscode.ThemeColor('disabledForeground'));
			default:
				// 警告アイコンは error / warn のときだけ。info（参考情報）だけでは切り替えない
				if (node.warnings.some((w) => w.severity !== 'info')) {
					return new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'));
				}
				return new vscode.ThemeIcon(node.boundary ? 'file-symlink-file' : 'file');
		}
	}

	private contextFor(node: MapNode): string {
		const parts: string[] = [node.kind];
		if (node.filePath) {
			parts.push('openable');
		}
		// セクション／スキル単位では表示木ではなくモデルの集計で判定する
		// （表示上限の先にある警告でも hasWarnings を落とさないため）
		const aggregated = this.aggregateWarnings(node);
		if (node.warnings.length > 0 || (aggregated ?? node.allWarnings()).length > 0) {
			parts.push('hasWarnings');
		}
		return parts.join(' ');
	}

	private collapsibleStateFor(node: MapNode): vscode.TreeItemCollapsibleState {
		if (node.kind === 'section') {
			return node.sectionId === 'skills'
				? vscode.TreeItemCollapsibleState.Expanded
				: vscode.TreeItemCollapsibleState.Collapsed;
		}
		if (node.children && node.children.length > 0) {
			return vscode.TreeItemCollapsibleState.Collapsed;
		}
		return vscode.TreeItemCollapsibleState.None;
	}

	private tooltipFor(node: MapNode): vscode.MarkdownString {
		const md = new vscode.MarkdownString();
		// セキュリティ上の懸念: 全コマンド実行の許可 (isTrusted = true) による意図しない任意コマンド実行を防ぐため、
		// ツールチップ内のリンクで実際に必要な `skillmap.openTip` のみに実行権限を限定する（最小権限の原則）
		md.isTrusted = { enabledCommands: ['skillmap.openTip'] };
		md.supportHtml = false;
		if (node.kind === 'section') {
			if (node.sectionId === 'steering') {
				md.appendMarkdown('**Steering (.kiro/steering)**\n\n');
				const roots = new Set(this.model.steering.map((u) => u.workspaceRoot));
				if (roots.size > 1) {
					// マルチルート時はフォルダごとの常時ロード合計を示す
					const labels = rootLabels([...roots]);
					for (const root of roots) {
						const total = this.model.steering
							.filter((u) => u.workspaceRoot === root && u.inclusion === 'always')
							.reduce((s, u) => s + u.tokens, 0);
						md.appendMarkdown(`- ${escapeMarkdownText(labels.get(root) ?? path.basename(root))}: ${L('常時ロード合計', 'Always-loaded total')} ≈${total.toLocaleString()} tok\n`);
					}
				} else {
					md.appendMarkdown(L(`- 常時ロード合計（inclusion: always）: ≈${this.model.alwaysSteeringTokens().toLocaleString()} tok\n`, `- Always-loaded total (inclusion: always): ≈${this.model.alwaysSteeringTokens().toLocaleString()} tok\n`));
				}
				md.appendMarkdown(L('- Kiro が inclusion 設定に従って自動で読み込むファイルです。Copilot では利用できません\n', '- Files Kiro loads automatically according to their inclusion settings. Not available in Copilot.\n'));
			} else if (node.sectionId === 'copilot') {
				md.appendMarkdown('**Copilot instructions**\n\n');
				md.appendMarkdown(L('- GitHub Copilot で利用できる指示ファイルです（表示専用。ルール適用はしません）\n', '- Instruction files available in GitHub Copilot (display only; no rules are applied).\n'));
				md.appendMarkdown(L('- Kiro では利用できません\n', '- Not available in Kiro.\n'));
			} else if (node.sectionId === 'specs') {
				md.appendMarkdown(L('**Specs（β）**\n\n', '**Specs (Beta)**\n\n'));
				md.appendMarkdown(L('- .kiro/specs 配下の仕様駆動開発の3点セットです\n', '- Spec-driven development trios under .kiro/specs.\n'));
			} else {
				md.appendMarkdown('**Skills**\n');
			}
			this.appendWarnings(md, node.warnings);
			return md;
		}
		if (node.kind === 'skill' && node.skill) {
			const unit = node.skill.unit;
			const total = totalOwnedTokens(unit);
			md.appendMarkdown(`**${escapeMarkdownText(node.skill.name)}**\n\n`);
			md.appendMarkdown(L(`- 合計（重複排除）: ≈${total.toLocaleString()} tok\n`, `- Total (de-duplicated): ≈${total.toLocaleString()} tok\n`));
			md.appendMarkdown(`- L1 (name + description): ≈${unit.l1Tokens.toLocaleString()} tok\n`);
			md.appendMarkdown(L(`- L2（SKILL.md 本文）: ≈${unit.skillMdBodyTokens.toLocaleString()} tok\n`, `- L2 (SKILL.md body): ≈${unit.skillMdBodyTokens.toLocaleString()} tok\n`));
			if (unit.steeringAlwaysTokens > 0) {
				md.appendMarkdown(L(`- うち .kiro/steering の常時ロード分（inclusion: always）: ≈${unit.steeringAlwaysTokens.toLocaleString()} tok\n`, `- of which always-loaded .kiro/steering (inclusion: always): ≈${unit.steeringAlwaysTokens.toLocaleString()} tok\n`));
			}
			// 警告一覧も表示木ではなくモデルから取る（表示上限の先の警告も含める）
			this.appendWarnings(md, (this.aggregateWarnings(node) ?? node.allWarnings()).slice(0, 10));
			return md;
		}
		if (node.kind === 'steering' && node.steeringUnit) {
			const u = node.steeringUnit;
			md.appendMarkdown(`**${escapeMarkdownText(u.filePath)}**\n\n`);
			if (u.unparsed) {
				md.appendMarkdown(
					L(
						'- inclusion: 未解析（内容を読み取れませんでした。常時ロードかどうかは未確定です）\n',
						'- inclusion: not parsed (its contents could not be read; whether it is always loaded is unknown)\n',
					),
				);
			} else {
				md.appendMarkdown(`- inclusion: ${u.inclusion}${u.inclusionExplicit ? '' : L('（未指定＝常時扱い）', ' (not specified = treated as always)')}\n`);
			}
			if (u.fileMatchPattern) {
				md.appendMarkdown(`- fileMatchPattern: ${markdownCodeSpan(u.fileMatchPattern)}\n`);
			}
			md.appendMarkdown(L(`- 推定トークン: ≈${u.tokens.toLocaleString()} tok\n`, `- Estimated tokens: ≈${u.tokens.toLocaleString()} tok\n`));
			md.appendMarkdown(L('- Kiro: 利用可能（inclusion に従って自動ロード）／ Copilot: 利用不可\n', '- Kiro: Available (auto-loaded per inclusion) / Copilot: Unavailable\n'));
			this.appendWarnings(md, node.warnings);
			return md;
		}
		if (node.kind === 'spec' && node.specUnit) {
			md.appendMarkdown(`**Spec: ${escapeMarkdownText(node.specUnit.name)}**\n\n`);
			if (new Set(this.model.specs.map((x) => x.workspaceRoot)).size > 1) {
				md.appendMarkdown(`- ${L('フォルダ', 'Folder')}: ${escapeMarkdownText(node.specUnit.workspaceRoot)}\n`);
			}
			for (const f of node.specUnit.files) {
				md.appendMarkdown(`- ${f.fileName}: ${f.present ? `≈${f.tokens.toLocaleString()} tok` : L('欠落', 'missing')}\n`);
			}
			this.appendWarnings(md, node.warnings);
			return md;
		}
		if (node.kind === 'copilot' && node.copilotUnit) {
			const u = node.copilotUnit;
			md.appendMarkdown(`**${escapeMarkdownText(u.filePath)}**\n\n`);
			md.appendMarkdown(L(`- 読み込み: ${u.mode === 'always' ? '常時（Copilot）' : `applyTo: ${escapeMarkdownText(u.applyTo ?? '(未指定)')}`}\n`, `- Loading: ${u.mode === 'always' ? 'always (Copilot)' : `applyTo: ${escapeMarkdownText(u.applyTo ?? '(not set)')}`}\n`));
			md.appendMarkdown(L(`- 推定トークン: ≈${u.tokens.toLocaleString()} tok\n`, `- Estimated tokens: ≈${u.tokens.toLocaleString()} tok\n`));
			md.appendMarkdown(L('- Copilot: 利用可能 ／ Kiro: 利用不可\n', '- Copilot: Available / Kiro: Unavailable\n'));
			return md;
		}
		if (node.kind === 'orphanGroup') {
			md.appendMarkdown(L('スキル内に存在しますが、明示的には参照されていないファイルです。\n', 'Files that exist inside the skill but are not explicitly referenced.\n'));
			return md;
		}
		md.appendMarkdown(`**${escapeMarkdownText(node.filePath ?? '')}**\n\n`);
		const own = node.ownTokens;
		// 配下合計は表示木からではなく解析モデルから計算する。表示木は深さ・
		// 総ノード数の上限で切り詰められるため、表示木を走査すると上限の先の
		// ファイルが漏れ、上限未満のときと合計が変わってしまう（表示だけを
		// 変えて対象を変えない、という原則）。モデルが無いノードだけ表示木に倒す
		const modelFiles = node.unit?.files ?? node.graph?.files;
		const subtree = modelFiles && node.filePath ? reachableTokens(modelFiles, node.filePath) : node.subtreeTokens();
		const pathFiles = node.pathFiles();
		md.appendMarkdown(L(`- このファイル: ≈${own.toLocaleString()} tok\n`, `- This file: ≈${own.toLocaleString()} tok\n`));
		if (subtree !== own) {
			md.appendMarkdown(L(`- 配下合計（重複排除）: ≈${subtree.toLocaleString()} tok\n`, `- Subtree total (de-duplicated): ≈${subtree.toLocaleString()} tok\n`));
		}
		if (pathFiles.length > 1) {
			md.appendMarkdown(L(`- 経路合計: ≈${node.pathTokens().toLocaleString()} tok（${pathFiles.length}ファイル）\n`, `- Path total: ≈${node.pathTokens().toLocaleString()} tok (${pathFiles.length} files)\n`));
		}
		if (node.shared) {
			md.appendMarkdown(L('- 共有: 複数のファイルから参照されています\n', '- Shared: referenced from multiple files.\n'));
		}
		if (node.boundary) {
			switch (boundaryFrame(node)) {
				case 'steering':
					md.appendMarkdown(L('- Steering外: Steering ファイルの配置ディレクトリの外にあるファイルです\n', '- Outside steering: a file outside the directory that contains the steering file.\n'));
					break;
				case 'spec':
					md.appendMarkdown(L('- Spec外: Spec の配置ディレクトリの外にあるファイルです\n', '- Outside spec: a file outside the spec directory.\n'));
					break;
				default:
					md.appendMarkdown(L('- スキル外: スキルの配置ディレクトリの外にあるファイルです。表示と構造チェックのみ対象です\n', '- External: a file outside the skill directory. Display and structural checks only.\n'));
			}
		}
		if (node.kind === 'missing' && node.mentionLines.length > 1) {
			const lines = node.mentionLines.map((l) => l + 1).join(', ');
			md.appendMarkdown(L(`- ${node.mentionLines.length}箇所で言及（行 ${lines}）\n`, `- Mentioned in ${node.mentionLines.length} places (lines ${lines})\n`));
		}
		this.appendWarnings(md, node.warnings);
		// Steering / Specs のグラフ内ノードには警告が付かないため、要確認の言及は
		// ここで直接 Tips への導線を出す（気づきの提示）
		if (node.kind === 'missing' && node.tentative && node.warnings.length === 0) {
			const summary = renderTipSummary('R13');
			if (summary) {
				md.appendMarkdown(`\n💡 ${escapeMarkdownText(summary)} [${L('Tips全文', 'Full Tip')}](${tipCommandUri('R13')})\n`);
			}
		}
		return md;
	}

	private appendWarnings(md: vscode.MarkdownString, warnings: SkillWarning[]): void {
		if (warnings.length === 0) {
			return;
		}
		md.appendMarkdown(L('\n**警告**\n', '\n**Warnings**\n'));
		for (const w of warnings) {
			const icon = w.severity === 'error' ? '🔴' : w.severity === 'warn' ? '🟡' : '🔵';
			// Markdown のホバーでは単一改行が段落区切りにならないため、
			// 警告ごと・Tips ごとに空行を入れて段落として分ける
			md.appendMarkdown(`\n${icon} **${w.ruleId}** ${escapeMarkdownText(w.message)}\n`);
			const summary = renderTipSummary(w.ruleId);
			if (summary) {
				md.appendMarkdown(`\n　💡 ${escapeMarkdownText(summary)} [${L('Tips全文', 'Full Tip')}](${tipCommandUri(w.ruleId, w.message)})\n`);
			}
			void RULES;
		}
	}
}

// escapeMarkdownText は src/markdown.ts の共通実装を使う（ツールチップは
// isTrusted（許可コマンド限定）なので、埋め込む文字列が `[表示文](command:...)`
// の形を作れると任意コマンドのリンクになりうる。対策水準を生成系と揃えるため、
// ロード行列・Tips と同じ関数を通すこと）

/**
 * 文字列を Markdown のコードスパンとして埋め込む。
 * コードスパン内ではバックスラッシュエスケープが効かない（ `\` はそのまま
 * 表示される）ため、通常テキスト用の escapeMarkdownText を適用すると
 * `src/[ab].ts` が `src/\[ab\].ts` と表示されてしまう。代わりに、入力に
 * 含まれる最長のバッククォート列より長いフェンスで囲み、入力中の
 * バッククォートでスパンが途中で閉じないようにする（内容自体は無加工）。
 */
function markdownCodeSpan(text: string): string {
	const longest = (text.match(/`+/g) ?? []).reduce((m, r) => Math.max(m, r.length), 0);
	if (longest === 0) {
		return `\`${text}\``;
	}
	const fence = '`'.repeat(longest + 1);
	return `${fence} ${text} ${fence}`;
}
