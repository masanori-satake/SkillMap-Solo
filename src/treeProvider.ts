import * as path from 'node:path';
import * as vscode from 'vscode';
import { layerLabel, type FileGraph, type LogicalSkill, type SkillUnit } from './skills.js';
import type { CopilotUnit, SpecUnit, SteeringUnit } from './contexts.js';
import { RULES, totalOwnedTokens, type SkillWarning } from './rules.js';
import { renderTipSummary, tipCommandUri } from './tips.js';

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

	get steeringDir(): string | undefined {
		return this.steering[0] ? path.dirname(this.steering[0].filePath) : undefined;
	}

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

const SECTION_LABELS: Record<SectionId, string> = {
	skills: 'Skills',
	steering: 'Steering (.kiro/steering)',
	specs: 'Specs（β）',
	copilot: 'Copilot instructions',
};

export class SkillTreeProvider implements vscode.TreeDataProvider<MapNode> {
	private _onDidChangeTreeData = new vscode.EventEmitter<MapNode | undefined | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(private model: SkillMapModel) {}

	refresh(): void {
		this._onDidChangeTreeData.fire();
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
				title: 'ファイルを開く',
				arguments: [node],
			};
		}
		return item;
	}

	getChildren(node?: MapNode): MapNode[] {
		if (!node) {
			return this.buildSections();
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
			const dir = this.model.steeringDir;
			const sectionWarnings = this.model.steeringWarnings.filter((w) => w.file === dir);
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
				missing.labelOverride = `${f.fileName}（欠落）`;
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
				return SECTION_LABELS[node.sectionId ?? 'skills'];
			case 'skill':
				return node.skill?.name ?? '';
			case 'orphanGroup':
				return '未参照ファイル';
			case 'copy': {
				const rel = copyRootLabel(node.unit?.dir ?? '');
				return `複製（${rel}）`;
			}
			case 'steering':
				return path.basename(node.filePath ?? '');
			case 'spec':
				return node.specUnit?.name ?? '';
			case 'copilot':
				return node.copilotUnit?.name ?? '';
			case 'missing':
				return `${path.basename(node.filePath ?? '')} （参照切れ）`;
			case 'cycle':
				return `${path.basename(node.filePath ?? '')} （循環）`;
			default:
				return path.basename(node.filePath ?? '');
		}
	}

	private descriptionFor(node: MapNode): string | undefined {
		const warn = (n: number) => (n > 0 ? ` ⚠${n}` : '');
		switch (node.kind) {
			case 'section': {
				if (node.sectionId === 'steering') {
					const always = this.model.alwaysSteeringTokens();
					return `常時ロード合計 ≈${always.toLocaleString()} tok${warn(node.allWarnings().length)}`;
				}
				if (node.sectionId === 'skills') {
					return `${this.model.skills.length}件${warn(node.allWarnings().length)}`;
				}
				if (node.sectionId === 'specs') {
					return `${this.model.specs.length}件${warn(node.allWarnings().length)}`;
				}
				if (node.sectionId === 'copilot') {
					const total = this.model.copilot.reduce((s, c) => s + c.tokens, 0);
					return `≈${total.toLocaleString()} tok`;
				}
				return undefined;
			}
			case 'skill': {
				const total = node.skill ? totalOwnedTokens(node.skill.canonical) : 0;
				return `合計 ≈${total.toLocaleString()} tok${warn(node.allWarnings().length)}`;
			}
			case 'copy':
				return node.warnings.length > 0 ? `正本と乖離${warn(node.warnings.length)}` : '正本と一致';
			case 'orphanGroup':
				return `${node.children?.length ?? 0}件`;
			case 'steering': {
				const u = node.steeringUnit!;
				const badge = u.inclusion === 'always' ? '常時' : u.inclusion === 'fileMatch' ? '条件' : '手動';
				return `${badge} · ≈${u.tokens.toLocaleString()} tok${warn(node.warnings.length)}`;
			}
			case 'spec': {
				const missing = node.specUnit?.files.filter((f) => !f.present).length ?? 0;
				return `≈${node.ownTokens.toLocaleString()} tok${missing > 0 ? ` · 欠落${missing}` : ''}${warn(node.warnings.length)}`;
			}
			case 'copilot': {
				const u = node.copilotUnit!;
				const mode = u.mode === 'always' ? '常時' : `applyTo: ${u.applyTo ?? '(未指定)'}`;
				return `${mode} · ≈${u.tokens.toLocaleString()} tok`;
			}
			case 'missing':
				return node.specUnit ? '未作成' : '存在しません';
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
					parts.push('共有');
				}
				if (node.boundary) {
					parts.push('境界');
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
				md.appendMarkdown(`- 常時ロード合計（inclusion: always）: ≈${this.model.alwaysSteeringTokens().toLocaleString()} tok\n`);
				md.appendMarkdown('- Kiro が inclusion 設定に従って自動で読み込むファイルです。Copilot は読みません\n');
			} else if (node.sectionId === 'copilot') {
				md.appendMarkdown('**Copilot instructions**\n\n');
				md.appendMarkdown('- GitHub Copilot が読み込む指示ファイルです（表示専用。ルール適用はしません）\n');
				md.appendMarkdown('- Kiro は読みません\n');
			} else if (node.sectionId === 'specs') {
				md.appendMarkdown('**Specs（β）**\n\n');
				md.appendMarkdown('- .kiro/specs 配下の仕様駆動開発の3点セットです\n');
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
			md.appendMarkdown(`- 合計（重複排除）: ≈${total.toLocaleString()} tok\n`);
			md.appendMarkdown(`- L1（name + description）: ≈${unit.l1Tokens.toLocaleString()} tok\n`);
			md.appendMarkdown(`- L2（SKILL.md 本文）: ≈${unit.skillMdBodyTokens.toLocaleString()} tok\n`);
			if (unit.steeringAlwaysTokens > 0) {
				md.appendMarkdown(`- うち .kiro/steering の常時ロード分（inclusion: always）: ≈${unit.steeringAlwaysTokens.toLocaleString()} tok\n`);
			}
			if (!node.skill.canonicalExplicit && node.skill.copies.length > 0) {
				md.appendMarkdown('- 正本の自動判定: canonicalRoots に一致する配置が無いため、先頭の配置を代表としています\n');
			}
			this.appendWarnings(md, node.allWarnings().filter((w) => w.copyDir === undefined).slice(0, 10));
			return md;
		}
		if (node.kind === 'copy') {
			md.appendMarkdown(`**複製**: ${node.unit?.dir ?? ''}\n\n`);
			md.appendMarkdown('警告ルールは正本にのみ適用されます。複製にはドリフトチェック（R11）のみが適用されます。\n');
			this.appendWarnings(md, node.warnings);
			return md;
		}
		if (node.kind === 'steering' && node.steeringUnit) {
			const u = node.steeringUnit;
			md.appendMarkdown(`**${u.filePath}**\n\n`);
			md.appendMarkdown(`- inclusion: ${u.inclusion}${u.inclusionExplicit ? '' : '（未指定＝常時扱い）'}\n`);
			if (u.fileMatchPattern) {
				md.appendMarkdown(`- fileMatchPattern: \`${u.fileMatchPattern}\`\n`);
			}
			md.appendMarkdown(`- 推定トークン: ≈${u.tokens.toLocaleString()} tok\n`);
			md.appendMarkdown('- Kiro: inclusion に従って自動ロード ／ Copilot: 読まれない\n');
			if (u.canonicalCounterpart) {
				md.appendMarkdown(`- 正本: ${u.canonicalCounterpart}\n`);
			}
			this.appendWarnings(md, node.warnings);
			return md;
		}
		if (node.kind === 'spec' && node.specUnit) {
			md.appendMarkdown(`**Spec: ${node.specUnit.name}**\n\n`);
			for (const f of node.specUnit.files) {
				md.appendMarkdown(`- ${f.fileName}: ${f.present ? `≈${f.tokens.toLocaleString()} tok` : '欠落'}\n`);
			}
			this.appendWarnings(md, node.warnings);
			return md;
		}
		if (node.kind === 'copilot' && node.copilotUnit) {
			const u = node.copilotUnit;
			md.appendMarkdown(`**${u.filePath}**\n\n`);
			md.appendMarkdown(`- 読み込み: ${u.mode === 'always' ? '常時（Copilot）' : `applyTo: ${u.applyTo ?? '(未指定)'}`}\n`);
			md.appendMarkdown(`- 推定トークン: ≈${u.tokens.toLocaleString()} tok\n`);
			md.appendMarkdown('- Copilot: 読み込む ／ Kiro: 読まれない\n');
			return md;
		}
		if (node.kind === 'orphanGroup') {
			md.appendMarkdown('スキル内に存在しますが、どこからも参照されていないファイルです。\n');
			return md;
		}
		md.appendMarkdown(`**${node.filePath}**\n\n`);
		const own = node.ownTokens;
		const subtree = node.subtreeTokens();
		const pathFiles = node.pathFiles();
		md.appendMarkdown(`- このファイル: ≈${own.toLocaleString()} tok\n`);
		if (subtree !== own) {
			md.appendMarkdown(`- 配下合計（重複排除）: ≈${subtree.toLocaleString()} tok\n`);
		}
		if (pathFiles.length > 1) {
			md.appendMarkdown(`- 経路合計: ≈${node.pathTokens().toLocaleString()} tok（${pathFiles.length}ファイル）\n`);
		}
		if (node.shared) {
			md.appendMarkdown('- 共有: 複数のファイルから参照されています\n');
		}
		if (node.boundary) {
			md.appendMarkdown('- 境界: 配置ディレクトリの外のファイルです。表示と構造チェックのみ対象です\n');
		}
		this.appendWarnings(md, node.warnings);
		return md;
	}

	private appendWarnings(md: vscode.MarkdownString, warnings: SkillWarning[]): void {
		if (warnings.length === 0) {
			return;
		}
		md.appendMarkdown('\n**警告**\n\n');
		for (const w of warnings) {
			const icon = w.severity === 'error' ? '🔴' : w.severity === 'warn' ? '🟡' : '🔵';
			md.appendMarkdown(`${icon} **${w.ruleId}** ${w.message}\n`);
			const summary = renderTipSummary(w.ruleId);
			if (summary) {
				md.appendMarkdown(`　💡 ${summary} [Tips全文](${tipCommandUri(w.ruleId, w.message)})\n`);
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
