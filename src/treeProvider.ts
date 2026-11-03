import * as path from 'node:path';
import * as vscode from 'vscode';
import { layerLabel, type LogicalSkill, type SkillUnit } from './skills.js';
import { RULES, totalOwnedTokens, type SkillWarning } from './rules.js';
import { renderTipSummary, tipCommandUri } from './tips.js';

export type NodeKind = 'skill' | 'file' | 'missing' | 'cycle' | 'orphanGroup' | 'orphan' | 'copy';

export class MapNode {
	kind: NodeKind;
	skill: LogicalSkill;
	unit: SkillUnit;
	filePath?: string;
	parent?: MapNode;
	children?: MapNode[];
	warnings: SkillWarning[] = [];
	/** 境界ノードか */
	boundary = false;
	/** 共有ファイル（複数の親から参照）か */
	shared = false;

	constructor(kind: NodeKind, skill: LogicalSkill, unit: SkillUnit) {
		this.kind = kind;
		this.skill = skill;
		this.unit = unit;
	}

	get ownTokens(): number {
		if (!this.filePath) {
			return 0;
		}
		return this.unit.files.get(this.filePath)?.tokens ?? 0;
	}

	/** 配下合計（同一ファイルは1回だけ数える） */
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

	/** ルート（SKILL.md）からこのノードまでの経路上のファイル一覧 */
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
	warnings = new Map<string, SkillWarning[]>();

	setData(skills: LogicalSkill[], warnings: Map<string, SkillWarning[]>): void {
		this.skills = skills;
		this.warnings = warnings;
	}
}

function countReferences(unit: SkillUnit): Map<string, number> {
	const counts = new Map<string, number>();
	for (const info of unit.files.values()) {
		const parents = new Set<string>();
		for (const edge of info.refs) {
			if (edge.exists && !edge.isDirectory) {
				parents.add(info.absPath + '->' + edge.target);
			}
		}
		for (const key of parents) {
			const target = key.split('->')[1];
			counts.set(target, (counts.get(target) ?? 0) + 1);
		}
	}
	// 親ファイル単位で数え直す（同一親からの重複参照は1つとみなす）
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
		if (node.filePath && (node.kind === 'file' || node.kind === 'orphan' || node.kind === 'cycle')) {
			item.command = {
				command: 'skillmap.openFile',
				title: 'ファイルを開く',
				arguments: [node],
			};
		}
		if (node.kind === 'missing') {
			item.command = {
				command: 'skillmap.openFile',
				title: '参照元のファイルを開く',
				arguments: [node],
			};
		}
		return item;
	}

	getChildren(node?: MapNode): MapNode[] {
		if (!node) {
			return this.model.skills.map((skill) => this.buildSkillRoot(skill));
		}
		return node.children ?? [];
	}

	getParent(node: MapNode): MapNode | undefined {
		return node.parent;
	}

	// ---- ノード構築 ----

	private buildSkillRoot(skill: LogicalSkill): MapNode {
		const root = new MapNode('skill', skill, skill.canonical);
		const warnings = this.model.warnings.get(skill.key) ?? [];
		root.warnings = warnings.filter((w) => w.file === skill.canonical.skillMdPath && (w.ruleId === 'R10'));
		const children: MapNode[] = [];
		children.push(this.buildFileNode(skill, skill.canonical, skill.canonical.skillMdPath, root, []));
		if (skill.canonical.orphans.length > 0) {
			const group = new MapNode('orphanGroup', skill, skill.canonical);
			group.parent = root;
			group.children = skill.canonical.orphans.map((orphanPath) => {
				const orphan = new MapNode('orphan', skill, skill.canonical);
				orphan.filePath = orphanPath;
				orphan.parent = group;
				orphan.warnings = warnings.filter((w) => w.file === orphanPath);
				return orphan;
			});
			children.push(group);
		}
		for (const copy of skill.copies) {
			const copyNode = new MapNode('copy', skill, copy);
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
		const node = new MapNode('file', skill, unit);
		node.filePath = filePath;
		node.parent = parent;
		node.boundary = info?.boundary ?? false;
		const refCounts = countReferences(unit);
		node.shared = (refCounts.get(filePath) ?? 0) > 1 && filePath !== unit.skillMdPath;
		if (unit === skill.canonical) {
			const warnings = this.model.warnings.get(skill.key) ?? [];
			node.warnings = warnings.filter((w) => w.file === filePath && w.copyDir === undefined);
		}
		const chain = [...ancestorChain, filePath];
		const children: MapNode[] = [];
		if (info && !info.isDirectory) {
			for (const edge of info.refs) {
				if (edge.isDirectory) {
					const dirNode = new MapNode('file', skill, unit);
					dirNode.filePath = edge.target;
					dirNode.parent = node;
					dirNode.boundary = unit.files.get(edge.target)?.boundary ?? false;
					children.push(dirNode);
					continue;
				}
				if (!edge.exists) {
					const missing = new MapNode('missing', skill, unit);
					missing.filePath = edge.target;
					missing.parent = node;
					if (unit === skill.canonical) {
						const warnings = this.model.warnings.get(skill.key) ?? [];
						missing.warnings = warnings.filter((w) => w.ruleId === 'R7' && w.file === filePath && w.line === edge.line);
					}
					children.push(missing);
					continue;
				}
				if (chain.includes(edge.target)) {
					const cycle = new MapNode('cycle', skill, unit);
					cycle.filePath = edge.target;
					cycle.parent = node;
					if (unit === skill.canonical) {
						const warnings = this.model.warnings.get(skill.key) ?? [];
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

	// ---- 表示 ----

	private labelFor(node: MapNode): string {
		switch (node.kind) {
			case 'skill':
				return node.skill.name;
			case 'orphanGroup':
				return '未参照ファイル';
			case 'copy': {
				const rel = copyRootLabel(node.unit.dir);
				return `複製（${rel}）`;
			}
			case 'missing':
				return `${path.basename(node.filePath ?? '')} （参照切れ）`;
			case 'cycle':
				return `${path.basename(node.filePath ?? '')} （循環）`;
			default:
				return path.basename(node.filePath ?? '');
		}
	}

	private descriptionFor(node: MapNode): string | undefined {
		const warnCount = node.kind === 'skill' || node.kind === 'copy'
			? node.allWarnings().length
			: node.warnings.length;
		const warn = warnCount > 0 ? ` ⚠${warnCount}` : '';
		switch (node.kind) {
			case 'skill': {
				const total = totalOwnedTokens(node.skill.canonical);
				return `合計 ≈${total.toLocaleString()} tok${warn}`;
			}
			case 'copy':
				return node.warnings.length > 0 ? `正本と乖離${warn}` : '正本と一致';
			case 'orphanGroup':
				return `${node.children?.length ?? 0}件`;
			case 'missing':
				return '存在しません';
			case 'file':
			case 'orphan':
			case 'cycle': {
				const parts: string[] = [];
				parts.push(`≈${node.ownTokens.toLocaleString()} tok`);
				const depth = node.unit.depthDisplay.get(node.filePath ?? '');
				if (depth !== undefined && node.filePath !== node.unit.skillMdPath) {
					parts.push(layerLabel(depth));
				}
				if (node.shared) {
					parts.push('共有');
				}
				if (node.boundary) {
					parts.push('境界');
				}
				return parts.join(' · ') + warn;
			}
		}
		return undefined;
	}

	private iconFor(node: MapNode): vscode.ThemeIcon {
		const hasError = node.warnings.some((w) => w.severity === 'error')
			|| (node.kind === 'skill' && node.allWarnings().some((w) => w.severity === 'error'));
		switch (node.kind) {
			case 'skill':
				return new vscode.ThemeIcon(hasError ? 'library' : 'library');
			case 'copy':
				return new vscode.ThemeIcon('files');
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
		if (node.kind === 'skill' || node.kind === 'copy' || node.kind === 'orphanGroup') {
			return vscode.TreeItemCollapsibleState.Collapsed;
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
		if (node.kind === 'skill') {
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
				md.appendMarkdown(`- 正本の自動判定: canonicalRoots に一致する配置が無いため、先頭の配置を代表としています\n`);
			}
			this.appendWarnings(md, node.allWarnings().filter((w) => w.copyDir === undefined).slice(0, 10));
			return md;
		}
		if (node.kind === 'copy') {
			md.appendMarkdown(`**複製**: ${node.unit.dir}\n\n`);
			md.appendMarkdown('警告ルールは正本にのみ適用されます。複製にはドリフトチェック（R11）のみが適用されます。\n');
			this.appendWarnings(md, node.warnings);
			return md;
		}
		if (node.kind === 'orphanGroup') {
			md.appendMarkdown('スキル内に存在しますが、どこからも参照されていないファイルです。\n');
			return md;
		}
		// ファイル系ノード
		md.appendMarkdown(`**${node.filePath}**\n\n`);
		const own = node.ownTokens;
		const subtree = node.subtreeTokens();
		const pathFiles = node.pathFiles();
		md.appendMarkdown(`- このファイル: ≈${own.toLocaleString()} tok\n`);
		if (subtree !== own) {
			md.appendMarkdown(`- 配下合計（重複排除）: ≈${subtree.toLocaleString()} tok\n`);
		}
		if (pathFiles.length > 1) {
			md.appendMarkdown(`- 経路合計（SKILL.mdから）: ≈${node.pathTokens().toLocaleString()} tok（${pathFiles.length}ファイル）\n`);
		}
		if (node.shared) {
			md.appendMarkdown('- 共有: 複数のファイルから参照されています\n');
		}
		if (node.boundary) {
			md.appendMarkdown('- 境界: スキルディレクトリの外のファイルです。表示と構造チェックのみ対象です\n');
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
