import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bodyOf, countLines, parseFrontmatter, type Frontmatter } from './frontmatter.js';
import { estimateTokens } from './tokens.js';

export interface RefEdge {
	/** 参照の原文（リンク先表記） */
	raw: string;
	/** 参照が現れた行（0始まり） */
	line: number;
	/** 解決された絶対パス。ファイルが存在しない場合はその候補パスを返す */
	target: string;
	/** 解決先が存在するか */
	exists: boolean;
	/** 解決先がディレクトリか */
	isDirectory: boolean;
}

export interface FileInfo {
	absPath: string;
	/** スキルディレクトリからの相対パス（外に出る場合は ../ を含む） */
	relToSkill: string;
	exists: boolean;
	isDirectory: boolean;
	/** 形式の境界の外（スキルディレクトリ外）か */
	boundary: boolean;
	tokens: number;
	lines: number;
	refs: RefEdge[];
	/** テキストとして読めた場合の内容 */
	text?: string;
}

export interface SkillUnit {
	dir: string;
	skillMdPath: string;
	name: string;
	frontmatter: Frontmatter;
	skillMdTokens: number;
	skillMdBodyTokens: number;
	bodyLines: number;
	/** 到達可能なファイル（境界・参照切れ含む） */
	files: Map<string, FileInfo>;
	/** BFS による参照深さ（SKILL.md = 0）。境界を跨いだ先は深さ counting の対象外として -1 */
	depthOwned: Map<string, number>;
	/** 表示用の深さ（境界の先も数える） */
	depthDisplay: Map<string, number>;
	/** 到達可能なスキル内ファイル（SKILL.md 含む） */
	reachableOwned: Set<string>;
	/** 到達可能な境界ファイル */
	reachableBoundary: Set<string>;
	/** どこからも参照されていないスキル内ファイル */
	orphans: string[];
	/** スキル内の全ファイル（相対パス→ハッシュ）。ドリフト比較用 */
	fileHashes: Map<string, string>;
	/** L1（name + description）の推定トークン */
	l1Tokens: number;
	/** 境界のうち .kiro/steering かつ inclusion: always の推定トークン合計 */
	steeringAlwaysTokens: number;
}

export interface LogicalSkill {
	key: string;
	name: string;
	canonical: SkillUnit;
	copies: SkillUnit[];
	/** 正本が canonicalRoots の指定で選ばれたか */
	canonicalExplicit: boolean;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', '.vscode-test']);
const MAX_WALK_DEPTH = 10;

function isProbablyText(buf: Buffer): boolean {
	const len = Math.min(buf.length, 8192);
	for (let i = 0; i < len; i++) {
		if (buf[i] === 0) {
			return false;
		}
	}
	return true;
}

export function listFilesRecursive(dir: string, depth: number, out: string[]): void {
	if (depth > MAX_WALK_DEPTH) {
		return;
	}
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (!SKIP_DIRS.has(entry.name)) {
				listFilesRecursive(full, depth + 1, out);
			}
		} else if (entry.isFile()) {
			out.push(full);
		}
	}
}

/** ワークスペース配下から SKILL.md を持つディレクトリを探す */
export function findSkillDirs(workspaceRoots: string[], extraRoots: string[]): string[] {
	const found = new Set<string>();
	const scan = (root: string) => {
		const files: string[] = [];
		listFilesRecursive(root, 0, files);
		for (const f of files) {
			if (path.basename(f) === 'SKILL.md') {
				found.add(path.dirname(f));
			}
		}
	};
	for (const root of workspaceRoots) {
		scan(root);
	}
	for (const extra of extraRoots) {
		const abs = path.isAbsolute(extra) ? extra : extra;
		if (fs.existsSync(abs)) {
			scan(abs);
		}
	}
	return [...found].sort();
}

const LINK_RE = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const CODE_SPAN_RE = /`([^`\n]+)`/g;
const PATH_LIKE_RE = /^[\w.@~+%-]+(\/[\w.@~+%-]+)+(\.\w+)?$|^[^\s/]+\.\w{1,10}$/;

export function extractReferences(fromFile: string, text: string): RefEdge[] {
	const edges: RefEdge[] = [];
	const seen = new Set<string>();
	const fromDir = path.dirname(fromFile);
	const push = (raw: string, line: number) => {
		const cleaned = raw.replace(/^<|>$/g, '').split('#')[0].trim();
		if (!cleaned || cleaned.includes('://') || cleaned.startsWith('mailto:') || cleaned.startsWith('/')) {
			return;
		}
		const target = path.resolve(fromDir, cleaned);
		if (target === fromFile) {
			return;
		}
		const key = `${line}:${target}`;
		if (seen.has(key)) {
			return;
		}
		seen.add(key);
		let exists = false;
		let isDirectory = false;
		try {
			const st = fs.statSync(target);
			exists = true;
			isDirectory = st.isDirectory();
		} catch {
			exists = false;
		}
		edges.push({ raw: cleaned, line, target, exists, isDirectory });
	};
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const lineText = lines[i];
		let m: RegExpExecArray | null;
		LINK_RE.lastIndex = 0;
		while ((m = LINK_RE.exec(lineText)) !== null) {
			push(m[2], i);
		}
		CODE_SPAN_RE.lastIndex = 0;
		while ((m = CODE_SPAN_RE.exec(lineText)) !== null) {
			const candidate = m[1].trim();
			if (PATH_LIKE_RE.test(candidate) && !candidate.includes(' ')) {
				push(candidate, i);
			}
		}
	}
	return edges;
}

export function readFileInfo(absPath: string, skillDir: string): FileInfo {
	const relToSkill = path.relative(skillDir, absPath);
	const boundary = relToSkill.startsWith('..' + path.sep) || path.isAbsolute(relToSkill);
	let exists = false;
	let isDirectory = false;
	let tokens = 0;
	let lines = 0;
	let text: string | undefined;
	let refs: RefEdge[] = [];
	try {
		const st = fs.statSync(absPath);
		exists = true;
		isDirectory = st.isDirectory();
		if (!isDirectory) {
			const buf = fs.readFileSync(absPath);
			if (isProbablyText(buf)) {
				text = buf.toString('utf8');
				tokens = estimateTokens(text);
				lines = countLines(text);
				refs = extractReferences(absPath, text);
			}
		}
	} catch {
		exists = false;
	}
	return { absPath, relToSkill, exists, isDirectory, boundary, tokens, lines, refs, text };
}

export function buildUnit(skillDir: string): SkillUnit {
	const skillMdPath = path.join(skillDir, 'SKILL.md');
	const skillInfo = readFileInfo(skillMdPath, skillDir);
	const content = skillInfo.text ?? '';
	const frontmatter = parseFrontmatter(content);
	const name = (frontmatter.name ?? '').trim() || path.basename(skillDir);
	const body = bodyOf(content, frontmatter);
	const l1Text = `${frontmatter.name ?? ''}\n${frontmatter.description ?? ''}`;
	const l1Tokens = estimateTokens(l1Text);

	const files = new Map<string, FileInfo>();
	const depthDisplay = new Map<string, number>();
	const depthOwned = new Map<string, number>();
	const reachableOwned = new Set<string>();
	const reachableBoundary = new Set<string>();

	// BFS で到達可能なファイルを辿る
	const queue: Array<{ p: string; depth: number; ownedDepth: number }> = [
		{ p: skillMdPath, depth: 0, ownedDepth: 0 },
	];
	files.set(skillMdPath, skillInfo);
	while (queue.length > 0) {
		const current = queue.shift()!;
		const info = files.get(current.p)!;
		depthDisplay.set(current.p, current.depth);
		if (current.ownedDepth >= 0) {
			depthOwned.set(current.p, current.ownedDepth);
		}
		if (info.boundary) {
			reachableBoundary.add(current.p);
		} else {
			reachableOwned.add(current.p);
		}
		for (const edge of info.refs) {
			if (edge.isDirectory) {
				if (!files.has(edge.target)) {
					files.set(edge.target, readFileInfo(edge.target, skillDir));
					depthDisplay.set(edge.target, current.depth + 1);
					if (!files.get(edge.target)!.boundary && current.ownedDepth >= 0) {
						depthOwned.set(edge.target, current.ownedDepth + 1);
						reachableOwned.add(edge.target);
					} else if (files.get(edge.target)!.boundary) {
						reachableBoundary.add(edge.target);
					}
				}
				continue;
			}
			if (!files.has(edge.target)) {
				files.set(edge.target, readFileInfo(edge.target, skillDir));
			}
			if (!depthDisplay.has(edge.target)) {
				const targetInfo = files.get(edge.target)!;
				const nextOwned = !targetInfo.boundary && current.ownedDepth >= 0 ? current.ownedDepth + 1 : -1;
				queue.push({ p: edge.target, depth: current.depth + 1, ownedDepth: nextOwned });
			}
		}
	}

	// スキル内の全ファイル（孤立検出・ハッシュ用）
	const diskAbs: string[] = [];
	listFilesRecursive(skillDir, 0, diskAbs);
	const fileHashes = new Map<string, string>();
	for (const abs of diskAbs) {
		try {
			const buf = fs.readFileSync(abs);
			fileHashes.set(path.relative(skillDir, abs), crypto.createHash('sha1').update(buf).digest('hex'));
		} catch {
			// 読めないファイルは無視
		}
	}
	const orphans = diskAbs
		.filter((abs) => abs !== skillMdPath && !reachableOwned.has(abs))
		.sort();

	// Kiro steering の常時ロード分の目安
	let steeringAlwaysTokens = 0;
	for (const p of reachableBoundary) {
		const normalized = p.split(path.sep).join('/');
		if (normalized.includes('/.kiro/steering/')) {
			const info = files.get(p);
			if (info?.text) {
				const fm = parseFrontmatter(info.text);
				if ((fm.values['inclusion'] ?? 'always') === 'always') {
					steeringAlwaysTokens += info.tokens;
				}
			}
		}
	}

	return {
		dir: skillDir,
		skillMdPath,
		name,
		frontmatter,
		skillMdTokens: skillInfo.tokens,
		skillMdBodyTokens: estimateTokens(body),
		bodyLines: countLines(body),
		files,
		depthOwned,
		depthDisplay,
		reachableOwned,
		reachableBoundary,
		orphans,
		fileHashes,
		l1Tokens,
		steeringAlwaysTokens,
	};
}

function rootPriority(dir: string, canonicalRoots: string[]): number {
	const normalized = dir.split(path.sep).join('/');
	for (let i = 0; i < canonicalRoots.length; i++) {
		const root = canonicalRoots[i].replace(/\/+$/, '');
		if (normalized === root || normalized.includes('/' + root.replace(/^\.\//, '') + '/') || normalized.includes(root + '/')) {
			return i;
		}
	}
	return Number.MAX_SAFE_INTEGER;
}

export function groupSkills(units: SkillUnit[], canonicalRoots: string[]): LogicalSkill[] {
	const groups = new Map<string, SkillUnit[]>();
	for (const unit of units) {
		const key = unit.name;
		const arr = groups.get(key) ?? [];
		arr.push(unit);
		groups.set(key, arr);
	}
	const result: LogicalSkill[] = [];
	for (const [key, arr] of groups) {
		const sorted = [...arr].sort((a, b) => {
			const pa = rootPriority(a.dir, canonicalRoots);
			const pb = rootPriority(b.dir, canonicalRoots);
			if (pa !== pb) {
				return pa - pb;
			}
			return a.dir.localeCompare(b.dir);
		});
		const canonical = sorted[0];
		result.push({
			key,
			name: canonical.name,
			canonical,
			copies: sorted.slice(1),
			canonicalExplicit: rootPriority(canonical.dir, canonicalRoots) !== Number.MAX_SAFE_INTEGER,
		});
	}
	return result.sort((a, b) => a.name.localeCompare(b.name));
}

/** ルート表示用の階層ラベル（SKILL.md が L2、その参照先が L3、以降 L4, L5...） */
export function layerLabel(depthDisplay: number): string {
	return `L${depthDisplay + 2}`;
}

/** 任意のファイルを起点にした参照グラフ（Steering 等の単一ファイル起点用） */
export interface FileGraph {
	rootPath: string;
	ownedDir: string;
	files: Map<string, FileInfo>;
	depthDisplay: Map<string, number>;
	reachable: Set<string>;
}

export function buildFileGraph(rootPath: string, ownedDir: string): FileGraph {
	const files = new Map<string, FileInfo>();
	const depthDisplay = new Map<string, number>();
	const reachable = new Set<string>();
	const rootInfo = readFileInfo(rootPath, ownedDir);
	files.set(rootPath, rootInfo);
	const queue: Array<{ p: string; depth: number }> = [{ p: rootPath, depth: 0 }];
	while (queue.length > 0) {
		const current = queue.shift()!;
		if (depthDisplay.has(current.p)) {
			continue;
		}
		depthDisplay.set(current.p, current.depth);
		reachable.add(current.p);
		const info = files.get(current.p);
		if (!info) {
			continue;
		}
		for (const edge of info.refs) {
			if (!files.has(edge.target)) {
				files.set(edge.target, readFileInfo(edge.target, ownedDir));
			}
			if (edge.exists && !edge.isDirectory && !depthDisplay.has(edge.target)) {
				queue.push({ p: edge.target, depth: current.depth + 1 });
			}
		}
	}
	return { rootPath, ownedDir, files, depthDisplay, reachable };
}
