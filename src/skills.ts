import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bodyOf, countLines, parseFrontmatter, type Frontmatter } from './frontmatter.js';
import { estimateTokens } from './tokens.js';

export interface RefEdge {
	/** 参照の原文（リンク先表記） */
	raw: string;
	/** 参照が最初に現れた行（0始まり）。代表行として警告の突合に使う */
	line: number;
	/** 参照が現れた全ての行（0始まり）。同一ファイル内の重複は1エッジに集約する */
	lines: number[];
	/** 抽出元: リンク記法かコードスパンか（参照意図の明示度の判定に使う） */
	via: 'link' | 'code';
	/** 解決された絶対パス。ファイルが存在しない場合はその候補パスを返す */
	target: string;
	/** 解決先が存在するか */
	exists: boolean;
	/** 解決先がディレクトリか */
	isDirectory: boolean;
}

/**
 * 未解決の参照候補が「ファイル名のみの言及」かを判定する。
 * コードスパンに書かれたパスなしの名前は、参照の意図とは限らず（構造の説明・
 * 作成予定の名前など）、参照切れと断定できないため R13（要確認）として扱う。
 */
export function isTentativeMention(edge: RefEdge): boolean {
	return edge.via === 'code' && !edge.raw.includes('/');
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
	/** 発見元の探索ルート（ワークスペースフォルダ等）。マルチルート時のグルーピング単位 */
	sourceRoot: string;
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
// パス・ファイル名の候補は、構文記号（括弧・引用符・演算子・グロブ等）を含むものを
// 除外文字方式で弾く。`targets[i].name` のような式をファイル名と誤認しないため。
// ASCII の \w に狭めると日本語ファイル名（パス中のセグメント含む）が落ちるため、
// パス付き・ファイル名のみの双方を除外方式にしている。
const PATH_LIKE_RE =
	/^[^\s\/\[\](){}<>"'|=;:,!?*#$&\\]+(\/[^\s\/\[\](){}<>"'|=;:,!?*#$&\\]+)+(\.[^\s\/.\[\](){}<>"'|=;:,!?*#$&\\]{1,10})?$|^[^\s\/\[\](){}<>"'|=;:,!?*#$&\\]+(\.[^\s\/.\[\](){}<>"'|=;:,!?*#$&\\]{1,10})$/;

export function extractReferences(fromFile: string, text: string): RefEdge[] {
	const edges: RefEdge[] = [];
	const byTarget = new Map<string, RefEdge>();
	const fromDir = path.dirname(fromFile);
	const push = (raw: string, line: number, via: 'link' | 'code') => {
		const cleaned = raw.replace(/^<|>$/g, '').split('#')[0].trim();
		if (!cleaned || cleaned.includes('://') || cleaned.startsWith('mailto:') || cleaned.startsWith('/')) {
			return;
		}
		const target = path.resolve(fromDir, cleaned);
		if (target === fromFile) {
			return;
		}
		// 同一ファイル内で同じ参照先が複数回現れても1エッジに集約し、出現行を全て保持する
		const existing = byTarget.get(target);
		if (existing) {
			if (!existing.lines.includes(line)) {
				existing.lines.push(line);
			}
			// リンク記法で書かれた箇所が1つでもあれば、参照の意図は明示的として格上げする
			if (via === 'link') {
				existing.via = 'link';
			}
			// パス付きで書かれた箇所が1つでもあれば、そちらを代表表記にして
			// 「ファイル名のみの言及」（R13）ではなく参照切れ（R7）として扱う
			if (cleaned.includes('/') && !existing.raw.includes('/')) {
				existing.raw = cleaned;
			}
			return;
		}
		let exists = false;
		let isDirectory = false;
		try {
			const st = fs.statSync(target);
			exists = true;
			isDirectory = st.isDirectory();
		} catch {
			exists = false;
		}
		const edge: RefEdge = { raw: cleaned, line, lines: [line], via, target, exists, isDirectory };
		byTarget.set(target, edge);
		edges.push(edge);
	};
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const lineText = lines[i];
		let m: RegExpExecArray | null;
		LINK_RE.lastIndex = 0;
		while ((m = LINK_RE.exec(lineText)) !== null) {
			push(m[2], i, 'link');
		}
		CODE_SPAN_RE.lastIndex = 0;
		while ((m = CODE_SPAN_RE.exec(lineText)) !== null) {
			const candidate = m[1].trim();
			if (PATH_LIKE_RE.test(candidate)) {
				push(candidate, i, 'code');
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

export function buildUnit(skillDir: string, sourceRoot = ''): SkillUnit {
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
		sourceRoot,
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

/**
 * スキルの所属スコープ（グルーピング単位）を決める。
 * ワークスペースフォルダ内にあるスキルは、そのフォルダ（最長一致）をスコープとする。
 * skillsRoots がフォルダ内のパス（例: .github/skills）を指していても、正本と複製を
 * 分割しないよう、フォルダ外の探索ルートはフォルダに一致しない場合にだけ使う。
 */
export function scopeRootFor(dir: string, workspaceRoots: string[], extraRoots: string[]): string {
	const longestIn = (roots: string[]): string => {
		let best = '';
		for (const r of roots) {
			const prefix = r.endsWith(path.sep) ? r : r + path.sep;
			if ((dir === r || dir.startsWith(prefix)) && r.length > best.length) {
				best = r;
			}
		}
		return best;
	};
	return longestIn(workspaceRoots) || longestIn(extraRoots);
}

/**
 * ルートの表示名を決める。同名フォルダが重なる場合は、区別できるまで
 * 親パスを足していく（例: /work/client/app と /work/server/app → client/app と server/app）。
 */
export function rootLabels(roots: string[]): Map<string, string> {
	const uniq = [...new Set(roots)];
	const depths = new Map(uniq.map((r) => [r, 1]));
	const tail = (r: string) => r.split(path.sep).filter(Boolean).slice(-(depths.get(r) ?? 1)).join('/');
	// 衝突しているラベルだけを一段ずつ深くする（衝突していないものは短いまま）
	for (let round = 0; round < 8; round++) {
		const byLabel = new Map<string, string[]>();
		for (const r of uniq) {
			const arr = byLabel.get(tail(r)) ?? [];
			arr.push(r);
			byLabel.set(tail(r), arr);
		}
		const colliding = [...byLabel.values()].filter((arr) => arr.length > 1).flat();
		if (colliding.length === 0) {
			break;
		}
		for (const r of colliding) {
			depths.set(r, (depths.get(r) ?? 1) + 1);
		}
	}
	return new Map(uniq.map((r) => [r, tail(r)]));
}

export function groupSkills(units: SkillUnit[], canonicalRoots: string[]): LogicalSkill[] {
	const groups = new Map<string, SkillUnit[]>();
	for (const unit of units) {
		// マルチルート対応: 正本/複製の関係は同一の探索ルート内でのみ成立させる。
		// 別フォルダ（別リポジトリ）の同名スキルは統合しない。
		const key = `${unit.sourceRoot}\n${unit.name}`;
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
