import * as path from 'node:path';
import * as vscode from 'vscode';
import { layerLabel, rootLabels, type FileGraph, type LogicalSkill, type SkillUnit } from './skills.js';
import type { CopilotUnit, SpecUnit, SteeringUnit } from './contexts.js';
import { RULES, totalOwnedTokens, type SkillWarning } from './rules.js';
import { renderTipSummary, tipCommandUri } from './tips.js';
import { L } from './i18n.js';

export type NodeKind =
	| 'section'
	| 'skill'
	| 'file'
	| 'missing'
	| 'cycle'
	| 'orphanGroup'
	| 'orphan'
	| 'copy'
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
		const out = [...this.warnings];
		for (const child of this.children ?? []) {
			out.push(...child.allWarnings());
		}
		return out;
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
		return this.steering
			.filter((s) => s.inclusion === 'always')
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

export class SkillTreeProvider implements vscode.TreeDataProvider<MapNode> {
	private _onDidChangeTreeData = new vscode.EventEmitter<MapNode | undefined | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	/** 直近に構築したセクション（すべて展開の走査用） */
	private sections: MapNode[] = [];

	constructor(private model: SkillMapModel) {}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	/** 「すべて展開」: 子を持つ全ノードを上位から順に展開する（標準の「すべて折りたたむ」の対） */
	async expandAll(treeView: vscode.TreeView<MapNode>): Promise<void> {
		const walk = (n: MapNode): MapNode[] => [n, ...(n.children ?? []).flatMap(walk)];
		const expandable = this.sections.flatMap(walk).filter((n) => (n.children?.length ?? 0) > 0);
		for (const n of expandable) {
			try {
				await treeView.reveal(n, { expand: true, select: false, focus: false });
			} catch {
				// 表示されていないノード等で失敗しても他を続行する
			}
		}
	}

	getTreeItem(node: MapNode): vscode.TreeItem {
		const item = new vscode.TreeItem(this.labelFor(node), this.collapsibleStateFor(node));
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
		root.unit = skill.canonical;
		const warnings = this.model.skillWarnings.get(skill.key) ?? [];
		root.warnings = warnings.filter((w) => w.file === skill.canonical.skillMdPath && w.ruleId === 'R10');
		const children: MapNode[] = [];
		children.push(this.buildFileNode(skill, skill.canonical, skill.canonical.skillMdPath, root, []));
		if (skill.canonical.orphans.length > 0) {
			const group = new MapNode('orphanGroup');
			group.skill = skill;
			group.unit = skill.canonical;
			group.parent = root;
			group.children = skill.canonical.orphans.map((orphanPath) => {
				const orphan = new MapNode('orphan');
				orphan.skill = skill;
				orphan.unit = skill.canonical;
				orphan.filePath = orphanPath;
				orphan.parent = group;
				orphan.warnings = warnings.filter((w) => w.file === orphanPath);
				return orphan;
			});
			children.push(group);
		}
		for (const copy of skill.copies) {
			const copyNode = new MapNode('copy');
			copyNode.skill = skill;
			copyNode.unit = copy;
			copyNode.parent = root;
			copyNode.warnings = warnings.filter((w) => w.copyDir === copy.dir);
			copyNode.children = [this.buildFileNode(skill, copy, copy.skillMdPath, copyNode, [])];
			children.push(copyNode);
		}
		root.children = children;
		return root;
	}

	private buildFileNode(
		skill: LogicalSkill,
		unit: SkillUnit,
		filePath: string,
		parent: MapNode,
		ancestorChain: string[],
	): MapNode {
		const info = unit.files.get(filePath);
		const node = new MapNode('file');
		node.skill = skill;
		node.unit = unit;
		node.filePath = filePath;
		node.parent = parent;
		node.boundary = info?.boundary ?? false;
		const refCounts = countReferences(unit);
		node.shared = (refCounts.get(filePath) ?? 0) > 1 && filePath !== unit.skillMdPath;
		if (unit === skill.canonical) {
			const warnings = this.model.skillWarnings.get(skill.key) ?? [];
			node.warnings = warnings.filter((w) => w.file === filePath && w.copyDir === undefined);
		}
		const chain = [...ancestorChain, filePath];
		const children: MapNode[] = [];
		if (info && !info.isDirectory) {
			for (const edge of info.refs) {
				if (edge.isDirectory) {
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
					const missing = new MapNode('missing');
					missing.skill = skill;
					missing.unit = unit;
					missing.filePath = edge.target;
					missing.parent = node;
					if (unit === skill.canonical) {
						const warnings = this.model.skillWarnings.get(skill.key) ?? [];
						missing.warnings = warnings.filter((w) => w.ruleId === 'R7' && w.file === filePath && w.line === edge.line);
					}
					children.push(missing);
					continue;
				}
				if (chain.includes(edge.target)) {
					const cycle = new MapNode('cycle');
					cycle.skill = skill;
					cycle.unit = unit;
					cycle.filePath = edge.target;
					cycle.parent = node;
					if (unit === skill.canonical) {
						const warnings = this.model.skillWarnings.get(skill.key) ?? [];
						cycle.warnings = warnings.filter((w) => w.ruleId === 'R8' && w.file === filePath && w.line === edge.line);
					}
					children.push(cycle);
					continue;
				}
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
			if (!edge.exists) {
				const missing = new MapNode('missing');
				missing.graph = graph;
				missing.filePath = edge.target;
				missing.parent = parent;
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
			child.children = this.buildGraphChildren(graph, edge.target, child, [...chain, edge.target]);
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
			case 'copy': {
				const rel = copyRootLabel(node.unit?.dir ?? '');
				return L(`複製（${rel}）`, `Replica (${rel})`);
			}
			case 'steering':
				return path.basename(node.filePath ?? '');
			case 'spec':
				return node.specUnit?.name ?? '';
			case 'copilot':
				return node.copilotUnit?.name ?? '';
			case 'missing':
				return `${path.basename(node.filePath ?? '')} ${L('（参照切れ）', '(broken reference)')}`;
			case 'cycle':
				return `${path.basename(node.filePath ?? '')} ${L('（循環）', '(cycle)')}`;
			default:
				return path.basename(node.filePath ?? '');
		}
	}

	private descriptionFor(node: MapNode): string | undefined {
		const warn = (n: number) => (n > 0 ? ` ⚠${n}` : '');
		// マルチルートで同名が複数あるときだけ、所属フォルダの表示名を付けて見分けられるようにする
		const folderTag = (name: string, root: string, items: Array<{ name: string; root: string }>): string => {
			const same = items.filter((x) => x.name === name);
			if (!root || same.length <= 1) {
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
						return L(`${this.model.steering.length}件`, `${this.model.steering.length}`) + warn(node.allWarnings().length);
					}
					const always = this.model.alwaysSteeringTokens();
					return `${L('常時ロード合計', 'Always-loaded total')} ≈${always.toLocaleString()} tok${warn(node.allWarnings().length)}`;
				}
				if (node.sectionId === 'skills') {
					return L(`${this.model.skills.length}件`, `${this.model.skills.length}`) + warn(node.allWarnings().length);
				}
				if (node.sectionId === 'specs') {
					return L(`${this.model.specs.length}件`, `${this.model.specs.length}`) + warn(node.allWarnings().length);
				}
				if (node.sectionId === 'copilot') {
					const total = this.model.copilot.reduce((s, c) => s + c.tokens, 0);
					return `≈${total.toLocaleString()} tok`;
				}
				return undefined;
			}
			case 'skill': {
				const total = node.skill ? totalOwnedTokens(node.skill.canonical) : 0;
				const tag = node.skill ? folderTag(node.skill.name, node.skill.canonical.sourceRoot, this.model.skills.map((s) => ({ name: s.name, root: s.canonical.sourceRoot }))) : '';
				return `${L('合計', 'Total')} ≈${total.toLocaleString()} tok${warn(node.allWarnings().length)}${tag}`;
			}
			case 'copy':
				return node.warnings.length > 0 ? L('正本と乖離', 'Drifted from canonical') + warn(node.warnings.length) : L('正本と一致', 'Matches canonical');
			case 'orphanGroup':
				return L(`${node.children?.length ?? 0}件`, `${node.children?.length ?? 0}`);
			case 'steering': {
				const u = node.steeringUnit!;
				const badge = u.inclusion === 'always' ? L('常時', 'always') : u.inclusion === 'fileMatch' ? L('条件', 'conditional') : L('手動', 'manual');
				return `${badge} · ≈${u.tokens.toLocaleString()} tok${warn(node.warnings.length)}${folderTag(u.name, u.workspaceRoot, this.model.steering.map((x) => ({ name: x.name, root: x.workspaceRoot })))}`;
			}
			case 'spec': {
				const missing = node.specUnit?.files.filter((f) => !f.present).length ?? 0;
				const tag = node.specUnit ? folderTag(node.specUnit.name, node.specUnit.workspaceRoot, this.model.specs.map((x) => ({ name: x.name, root: x.workspaceRoot }))) : '';
				return `≈${node.ownTokens.toLocaleString()} tok${missing > 0 ? L(` · 欠落${missing}`, ` · ${missing} missing`) : ''}${warn(node.warnings.length)}${tag}`;
			}
			case 'copilot': {
				const u = node.copilotUnit!;
				const mode = u.mode === 'always' ? L('常時', 'always') : `applyTo: ${u.applyTo ?? L('(未指定)', '(not set)')}`;
				return `${mode} · ≈${u.tokens.toLocaleString()} tok${folderTag(u.name, u.workspaceRoot, this.model.copilot.map((x) => ({ name: x.name, root: x.workspaceRoot })))}`;
			}
			case 'missing':
				return node.specUnit ? L('未作成', 'not created') : L('存在しません', 'does not exist');
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
					parts.push(L('境界', 'boundary'));
				}
				return parts.join(' · ') + warn(node.warnings.length);
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
			case 'copy':
				return new vscode.ThemeIcon('files');
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
				return new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
			case 'cycle':
				return new vscode.ThemeIcon('sync', new vscode.ThemeColor('editorWarning.foreground'));
			case 'orphan':
				return new vscode.ThemeIcon('file', new vscode.ThemeColor('disabledForeground'));
			default:
				if (node.warnings.length > 0) {
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
		if (node.warnings.length > 0 || node.allWarnings().length > 0) {
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
		md.isTrusted = true;
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
						md.appendMarkdown(`- ${labels.get(root) ?? path.basename(root)}: ${L('常時ロード合計', 'Always-loaded total')} ≈${total.toLocaleString()} tok\n`);
					}
				} else {
					md.appendMarkdown(L(`- 常時ロード合計（inclusion: always）: ≈${this.model.alwaysSteeringTokens().toLocaleString()} tok\n`, `- Always-loaded total (inclusion: always): ≈${this.model.alwaysSteeringTokens().toLocaleString()} tok\n`));
				}
				md.appendMarkdown(L('- Kiro が inclusion 設定に従って自動で読み込むファイルです。Copilot は読みません\n', '- Files Kiro loads automatically according to their inclusion settings. Copilot does not read them.\n'));
			} else if (node.sectionId === 'copilot') {
				md.appendMarkdown('**Copilot instructions**\n\n');
				md.appendMarkdown(L('- GitHub Copilot が読み込む指示ファイルです（表示専用。ルール適用はしません）\n', '- Instruction files read by GitHub Copilot (display only; no rules are applied).\n'));
				md.appendMarkdown(L('- Kiro は読みません\n', '- Kiro does not read them.\n'));
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
			const unit = node.skill.canonical;
			const total = totalOwnedTokens(unit);
			md.appendMarkdown(`**${node.skill.name}**\n\n`);
			md.appendMarkdown(L(`- 合計（重複排除）: ≈${total.toLocaleString()} tok\n`, `- Total (de-duplicated): ≈${total.toLocaleString()} tok\n`));
			md.appendMarkdown(`- L1 (name + description): ≈${unit.l1Tokens.toLocaleString()} tok\n`);
			md.appendMarkdown(L(`- L2（SKILL.md 本文）: ≈${unit.skillMdBodyTokens.toLocaleString()} tok\n`, `- L2 (SKILL.md body): ≈${unit.skillMdBodyTokens.toLocaleString()} tok\n`));
			if (unit.steeringAlwaysTokens > 0) {
				md.appendMarkdown(L(`- うち .kiro/steering の常時ロード分（inclusion: always）: ≈${unit.steeringAlwaysTokens.toLocaleString()} tok\n`, `- of which always-loaded .kiro/steering (inclusion: always): ≈${unit.steeringAlwaysTokens.toLocaleString()} tok\n`));
			}
			if (!node.skill.canonicalExplicit && node.skill.copies.length > 0) {
				md.appendMarkdown(L('- 正本の自動判定: canonicalRoots に一致する配置が無いため、先頭の配置を代表としています\n', '- Canonical auto-detection: no location matches canonicalRoots, so the first location is treated as the representative.\n'));
			}
			this.appendWarnings(md, node.allWarnings().filter((w) => w.copyDir === undefined).slice(0, 10));
			return md;
		}
		if (node.kind === 'copy') {
			md.appendMarkdown(`**${L('複製', 'Replica')}**: ${escapeMarkdownText(node.unit?.dir ?? '')}\n\n`);
			md.appendMarkdown(L('警告ルールは正本にのみ適用されます。複製にはドリフトチェック（R11）のみが適用されます。\n', 'Warning rules apply to the canonical source only. Replicas get the drift check (R11) only.\n'));
			this.appendWarnings(md, node.warnings);
			return md;
		}
		if (node.kind === 'steering' && node.steeringUnit) {
			const u = node.steeringUnit;
			md.appendMarkdown(`**${escapeMarkdownText(u.filePath)}**\n\n`);
			md.appendMarkdown(`- inclusion: ${u.inclusion}${u.inclusionExplicit ? '' : L('（未指定＝常時扱い）', ' (not specified = treated as always)')}\n`);
			if (u.fileMatchPattern) {
				md.appendMarkdown(`- fileMatchPattern: \`${u.fileMatchPattern}\`\n`);
			}
			md.appendMarkdown(L(`- 推定トークン: ≈${u.tokens.toLocaleString()} tok\n`, `- Estimated tokens: ≈${u.tokens.toLocaleString()} tok\n`));
			md.appendMarkdown(L('- Kiro: inclusion に従って自動ロード ／ Copilot: 読まれない\n', '- Kiro: auto-loaded per inclusion / Copilot: not loaded\n'));
			if (u.canonicalCounterpart) {
				md.appendMarkdown(`- ${L('正本', 'Canonical')}: ${escapeMarkdownText(u.canonicalCounterpart)}\n`);
			}
			this.appendWarnings(md, node.warnings);
			return md;
		}
		if (node.kind === 'spec' && node.specUnit) {
			md.appendMarkdown(`**Spec: ${node.specUnit.name}**\n\n`);
			for (const f of node.specUnit.files) {
				md.appendMarkdown(`- ${f.fileName}: ${f.present ? `≈${f.tokens.toLocaleString()} tok` : L('欠落', 'missing')}\n`);
			}
			this.appendWarnings(md, node.warnings);
			return md;
		}
		if (node.kind === 'copilot' && node.copilotUnit) {
			const u = node.copilotUnit;
			md.appendMarkdown(`**${escapeMarkdownText(u.filePath)}**\n\n`);
			md.appendMarkdown(L(`- 読み込み: ${u.mode === 'always' ? '常時（Copilot）' : `applyTo: ${u.applyTo ?? '(未指定)'}`}\n`, `- Loading: ${u.mode === 'always' ? 'always (Copilot)' : `applyTo: ${u.applyTo ?? '(not set)'}`}\n`));
			md.appendMarkdown(L(`- 推定トークン: ≈${u.tokens.toLocaleString()} tok\n`, `- Estimated tokens: ≈${u.tokens.toLocaleString()} tok\n`));
			md.appendMarkdown(L('- Copilot: 読み込む ／ Kiro: 読まれない\n', '- Copilot: loaded / Kiro: not loaded\n'));
			return md;
		}
		if (node.kind === 'orphanGroup') {
			md.appendMarkdown(L('スキル内に存在しますが、どこからも参照されていないファイルです。\n', 'Files that exist inside the skill but are not referenced from anywhere.\n'));
			return md;
		}
		md.appendMarkdown(`**${escapeMarkdownText(node.filePath ?? '')}**\n\n`);
		const own = node.ownTokens;
		const subtree = node.subtreeTokens();
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
			md.appendMarkdown(L('- 境界: 配置ディレクトリの外のファイルです。表示と構造チェックのみ対象です\n', '- Boundary: a file outside the owning directory. Display and structural checks only.\n'));
		}
		this.appendWarnings(md, node.warnings);
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

function copyRootLabel(dir: string): string {
	const segments = dir.split(path.sep).join('/').split('/');
	const known = segments.filter((s) => ['.agents', '.kiro', '.github', '.claude'].includes(s));
	if (known.length > 0) {
		return known[0];
	}
	const parts = dir.split(path.sep).filter(Boolean);
	return parts.length >= 2 ? parts[parts.length - 2] : path.basename(dir);
}

/**
 * Markdown テキストへ埋め込む文字列の `\` を二重化する。
 * Windows パスでは `\` の直後が句読点（例: `\.`）だと Markdown のエスケープとして
 * 消費されて区切りが消えて表示される（例: `OmniView-Solo\.kiro` → `OmniView-Solo.kiro`）。
 */
function escapeMarkdownText(text: string): string {
	return text.replace(/\\/g, '\\\\');
}