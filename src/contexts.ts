import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseFrontmatter } from './frontmatter.js';
import { estimateTokens } from './tokens.js';
import {
	buildFileGraph,
	buildResolutionContext,
	listAllFiles,
	listFilesRecursive,
	MAX_TEXT_FILE_BYTES,
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
	/**
	 * サイズ上限超などで内容を解析できなかった。inclusion 等の frontmatter
	 * 由来の値は未確定であり、「常時ロード」として数えてはいけない
	 */
	unparsed?: boolean;
	/** frontmatter に書かれた inclusion の生値（検証用） */
	inclusionRaw?: string;
	fileMatchPattern?: string;
	tokens: number;
	graph: FileGraph;
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

interface TextRead {
	text: string;
	/**
	 * サイズ上限超・通常ファイルでない・読み取り失敗のいずれかで、内容を
	 * 解析できなかった。空ファイル（text が空で unparsed でない）とは
	 * 区別すること: 未解析のファイルの frontmatter 由来の値は未確定であり、
	 * 「inclusion 未指定＝常時ロード」のような既定解釈をしてはいけない
	 */
	unparsed: boolean;
}

function readText(filePath: string): TextRead {
	try {
		// skills.ts 側と同じ上限: 通常ファイルでないもの（FIFO 等は open で
		// ブロックする）とサイズ上限超は読まない
		const st = fs.statSync(filePath);
		if (!st.isFile() || st.size > MAX_TEXT_FILE_BYTES) {
			return { text: '', unparsed: true };
		}
		return { text: fs.readFileSync(filePath, 'utf8'), unparsed: false };
	} catch {
		return { text: '', unparsed: true };
	}
}

/** .kiro/steering 配下の Steering ファイルを発見する */
export function discoverSteering(
	workspaceRoots: string[],
	knownFiles?: Map<string, string[]>,
): SteeringUnit[] {
	const units: SteeringUnit[] = [];
	for (const root of workspaceRoots) {
		const steeringDir = path.join(root, '.kiro', 'steering');
		if (!fs.existsSync(steeringDir)) {
			continue;
		}
		// 参照の解決はフォルダ相対とフォルダ内の同名一意一致も試みる（§10.2）。
		// フォルダ内の全ファイルは呼び出し側の走査結果を再利用する（無ければここで歩く）
		const resCtx = buildResolutionContext([root], knownFiles?.get(root) ?? listAllFiles(root));
		const files: string[] = [];
		listFilesRecursive(steeringDir, 0, files);
		for (const filePath of files.sort()) {
			if (!filePath.endsWith('.md')) {
				continue;
			}
			const { text, unparsed } = readText(filePath);
			const fm = parseFrontmatter(text);
			const rawInclusion = (fm.values['inclusion'] ?? '').trim();
			const inclusion: Inclusion =
				rawInclusion === 'fileMatch' || rawInclusion === 'manual' ? rawInclusion : 'always';
			units.push({
				kind: 'steering',
				filePath,
				workspaceRoot: root,
				name: path.basename(filePath, '.md'),
				inclusion,
				inclusionExplicit: rawInclusion.length > 0,
				inclusionRaw: rawInclusion || undefined,
				unparsed: unparsed || undefined,
				fileMatchPattern: fm.values['fileMatchPattern']?.trim() || undefined,
				tokens: estimateTokens(text),
				graph: buildFileGraph(filePath, steeringDir, resCtx),
			});
		}
	}
	return units;
}

/** .kiro/specs 配下の Spec ディレクトリを発見する */
export function discoverSpecs(workspaceRoots: string[], knownFiles?: Map<string, string[]>): SpecUnit[] {
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
		// 参照の解決はフォルダ相対とフォルダ内の同名一意一致も試みる（§10.2）。
		// フォルダ内の全ファイルは呼び出し側の走査結果を再利用する（無ければここで歩く）
		const resCtx = buildResolutionContext([root], knownFiles?.get(root) ?? listAllFiles(root));
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
					tokens: present ? estimateTokens(readText(filePath).text) : 0,
					graph: present ? buildFileGraph(filePath, dir, resCtx) : undefined,
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
export function discoverCopilot(workspaceRoots: string[], knownFiles?: Map<string, string[]>): CopilotUnit[] {
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
			tokens: estimateTokens(readText(filePath).text),
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
				const fm = parseFrontmatter(readText(filePath).text);
				push(filePath, 'applyTo', root, fm.values['applyTo']?.trim() || undefined);
			}
		}
		// AGENTS.md はワークスペース内のものを拾う（深さ制限つき）。
		// 全ファイルは呼び出し側の走査結果を再利用する（無ければここで歩く）
		const all = knownFiles?.get(root) ?? listAllFiles(root);
		for (const filePath of [...all].sort()) {
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
		// 未解析のファイルは適用条件が未確定なので、常時ロードにも条件一致にも数えない
		if (s.unparsed) {
			continue;
		}
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
