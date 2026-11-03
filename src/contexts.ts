import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseFrontmatter } from './frontmatter.js';
import { estimateTokens } from './tokens.js';
import {
	buildFileGraph,
	listFilesRecursive,
	readFileInfo,
	type FileGraph,
} from './skills.js';
import { matchesAnyPattern } from './glob.js';
import { L } from './i18n.js';

export type Inclusion = 'always' | 'fileMatch' | 'manual';

export interface SteeringUnit {
	kind: 'steering';
	filePath: string;
	/** 所属するワークスペースフォルダ（マルチルート判定用） */
	workspaceRoot: string;
	name: string;
	inclusion: Inclusion;
	/** inclusion が frontmatter に明示されていたか */
	inclusionExplicit: boolean;
	/** frontmatter に書かれた inclusion の生値（検証用） */
	inclusionRaw?: string;
	fileMatchPattern?: string;
	tokens: number;
	graph: FileGraph;
	/** 正本（.agents 配下）の対応ファイルがあればそのパス */
	canonicalCounterpart?: string;
}

export interface SpecUnit {
	kind: 'spec';
	name: string;
	/** 所属するワークスペースフォルダ（マルチルート判定用） */
	workspaceRoot: string;
	dir: string;
	files: Array<{
		role: 'requirements' | 'design' | 'tasks';
		fileName: string;
		present: boolean;
		filePath: string;
		tokens: number;
		graph?: FileGraph;
	}>;
	totalTokens: number;
}

export interface CopilotUnit {
	kind: 'copilot';
	filePath: string;
	/** 所属するワークスペースフォルダ（マルチルート判定用） */
	workspaceRoot: string;
	name: string;
	/** 'always' = copilot-instructions.md / AGENTS.md, 'applyTo' = instructions ファイル */
	mode: 'always' | 'applyTo';
	applyTo?: string;
	tokens: number;
}

function readText(filePath: string): string {
	try {
		return fs.readFileSync(filePath, 'utf8');
	} catch {
		return '';
	}
}

function sha1Of(filePath: string): string | undefined {
	try {
		return crypto.createHash('sha1').update(fs.readFileSync(filePath)).digest('hex');
	} catch {
		return undefined;
	}
}

export function filesEqual(a: string, b: string): boolean {
	const ha = sha1Of(a);
	const hb = sha1Of(b);
	return ha !== undefined && hb !== undefined && ha === hb;
}

/** .kiro/steering 配下の Steering ファイルを発見する */
export function discoverSteering(workspaceRoots: string[], canonicalRoots: string[]): SteeringUnit[] {
	const units: SteeringUnit[] = [];
	for (const root of workspaceRoots) {
		const steeringDir = path.join(root, '.kiro', 'steering');
		if (!fs.existsSync(steeringDir)) {
			continue;
		}
		const files: string[] = [];
		listFilesRecursive(steeringDir, 0, files);
		for (const filePath of files.sort()) {
			if (!filePath.endsWith('.md')) {
				continue;
			}
			const text = readText(filePath);
			const fm = parseFrontmatter(text);
			const rawInclusion = (fm.values['inclusion'] ?? '').trim();
			const inclusion: Inclusion =
				rawInclusion === 'fileMatch' || rawInclusion === 'manual' ? rawInclusion : 'always';
			// 正本の対応ファイル（<canonicalRoot>/steering/<basename>）を探す
			let canonicalCounterpart: string | undefined;
			for (const cr of canonicalRoots) {
				const candidate = path.join(root, cr, 'steering', path.basename(filePath));
				if (candidate !== filePath && fs.existsSync(candidate)) {
					canonicalCounterpart = candidate;
					break;
				}
			}
			units.push({
				kind: 'steering',
				filePath,
				workspaceRoot: root,
				name: path.basename(filePath, '.md'),
				inclusion,
				inclusionExplicit: rawInclusion.length > 0,
				inclusionRaw: rawInclusion || undefined,
				fileMatchPattern: fm.values['fileMatchPattern']?.trim() || undefined,
				tokens: estimateTokens(text),
				graph: buildFileGraph(filePath, steeringDir),
				canonicalCounterpart,
			});
		}
	}
	return units;
}

/** .kiro/specs 配下の Spec ディレクトリを発見する */
export function discoverSpecs(workspaceRoots: string[]): SpecUnit[] {
	const units: SpecUnit[] = [];
	const roles: Array<{ role: SpecUnit['files'][number]['role']; fileName: string }> = [
		{ role: 'requirements', fileName: 'requirements.md' },
		{ role: 'design', fileName: 'design.md' },
		{ role: 'tasks', fileName: 'tasks.md' },
	];
	for (const root of workspaceRoots) {
		const specsDir = path.join(root, '.kiro', 'specs');
		if (!fs.existsSync(specsDir)) {
			continue;
		}
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(specsDir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (!entry.isDirectory()) {
				continue;
			}
			const dir = path.join(specsDir, entry.name);
			const files = roles.map(({ role, fileName }) => {
				const filePath = path.join(dir, fileName);
				const present = fs.existsSync(filePath);
				return {
					role,
					fileName,
					present,
					filePath,
					tokens: present ? estimateTokens(readText(filePath)) : 0,
					graph: present ? buildFileGraph(filePath, dir) : undefined,
				};
			});
			units.push({
				kind: 'spec',
				name: entry.name,
				workspaceRoot: root,
				dir,
				files,
				totalTokens: files.reduce((s, f) => s + f.tokens, 0),
			});
		}
	}
	return units;
}

/** Copilot instructions 系ファイル（読み取り表示専用）を発見する */
export function discoverCopilot(workspaceRoots: string[]): CopilotUnit[] {
	const units: CopilotUnit[] = [];
	const push = (filePath: string, mode: CopilotUnit['mode'], root: string, applyTo?: string) => {
		if (!fs.existsSync(filePath)) {
			return;
		}
		units.push({
			kind: 'copilot',
			filePath,
			workspaceRoot: root,
			name: path.basename(filePath),
			mode,
			applyTo,
			tokens: estimateTokens(readText(filePath)),
		});
	};
	for (const root of workspaceRoots) {
		push(path.join(root, '.github', 'copilot-instructions.md'), 'always', root);
		const instrDir = path.join(root, '.github', 'instructions');
		if (fs.existsSync(instrDir)) {
			const files: string[] = [];
			listFilesRecursive(instrDir, 0, files);
			for (const filePath of files.sort()) {
				if (!filePath.endsWith('.instructions.md')) {
					continue;
				}
				const fm = parseFrontmatter(readText(filePath));
				push(filePath, 'applyTo', root, fm.values['applyTo']?.trim() || undefined);
			}
		}
		// AGENTS.md はワークスペース内のものを拾う（深さ制限つき）
		const all: string[] = [];
		listFilesRecursive(root, 0, all);
		for (const filePath of all.sort()) {
			if (path.basename(filePath) === 'AGENTS.md') {
				push(filePath, 'always', root);
			}
		}
	}
	return units;
}

/** ワークスペース内のファイル一覧（ワークスペース相対・posix 区切り）。S2 の死パターン判定用 */
export function listWorkspaceRelPaths(workspaceRoots: string[], cap = 30000): string[] {
	const rels: string[] = [];
	for (const root of workspaceRoots) {
		const files: string[] = [];
		listFilesRecursive(root, 0, files);
		for (const f of files) {
			rels.push(path.relative(root, f).split(path.sep).join('/'));
			if (rels.length >= cap) {
				return rels;
			}
		}
	}
	return rels;
}

/** fileMatchPattern が実ファイルに1件でも一致するか */
export function patternMatchesAny(pattern: string | undefined, relPaths: string[]): boolean {
	if (!pattern) {
		return false;
	}
	return relPaths.some((rel) => matchesAnyPattern(pattern, rel));
}

/** ロードシミュレーション: 指定ファイルに対して読み込まれる Steering / Copilot を返す */
export function simulateLoad(
	relPathPosix: string,
	steering: SteeringUnit[],
	copilot: CopilotUnit[],
): { kiro: Array<{ name: string; tokens: number; reason: string }>; copilot: Array<{ name: string; tokens: number; reason: string }> } {
	const kiro: Array<{ name: string; tokens: number; reason: string }> = [];
	for (const s of steering) {
		if (s.inclusion === 'always') {
			kiro.push({ name: path.basename(s.filePath), tokens: s.tokens, reason: L('常時', 'always') });
		} else if (s.inclusion === 'fileMatch' && s.fileMatchPattern && matchesAnyPattern(s.fileMatchPattern, relPathPosix)) {
			kiro.push({ name: path.basename(s.filePath), tokens: s.tokens, reason: `fileMatch: ${s.fileMatchPattern}` });
		}
	}
	const cop: Array<{ name: string; tokens: number; reason: string }> = [];
	for (const c of copilot) {
		if (c.mode === 'always') {
			cop.push({ name: c.name, tokens: c.tokens, reason: L('常時', 'always') });
		} else if (c.applyTo && matchesAnyPattern(c.applyTo, relPathPosix)) {
			cop.push({ name: c.name, tokens: c.tokens, reason: `applyTo: ${c.applyTo}` });
		}
	}
	return { kiro, copilot: cop };
}

// readFileInfo を使う箇所のために再エクスポートしておく（ツリー側の利便性）
export { readFileInfo };
export type { FileGraph };
