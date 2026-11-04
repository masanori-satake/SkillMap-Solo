import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { buildUnit, findSkillDirs, groupSkills, listAllFiles, scopeRootFor } from './skills.js';
import {
	discoverCopilot,
	discoverSpecs,
	discoverSteering,
	simulateLoad,
} from './contexts.js';
import {
	DEFAULT_RULE_SETTINGS,
	evaluateSkill,
	evaluateSpecs,
	evaluateSteering,
	type RuleSettings,
	type SkillWarning,
} from './rules.js';
import { MapNode, SkillMapModel, SkillTreeProvider } from './treeProvider.js';
import { renderCopyTree } from './copyTree.js';
import { renderTipMarkdown } from './tips.js';
import { renderLoadMatrix } from './matrix.js';
import { L, setLanguage } from './i18n.js';

const TIP_SCHEME = 'skillmap-tip';
const MATRIX_SCHEME = 'skillmap-matrix';
/** 「すべて展開」で進捗表示を出す対象ノード数の下限（これ以下は無言で即展開） */
const EXPAND_PROGRESS_THRESHOLD = 50;

class TipContentProvider implements vscode.TextDocumentContentProvider {
	provideTextDocumentContent(uri: vscode.Uri): string {
		const params = new URLSearchParams(uri.query);
		const ruleId = params.get('rule') ?? '';
		const message = params.get('message') ?? undefined;
		return renderTipMarkdown(ruleId, message);
	}
}

class MatrixContentProvider implements vscode.TextDocumentContentProvider {
	constructor(private holder: { markdown: string }) {}
	provideTextDocumentContent(): string {
		return this.holder.markdown;
	}
}

interface Settings {
	canonicalRoots: string[];
	skillsRoots: string[];
	rules: RuleSettings;
	betaSpecs: boolean;
	betaLoadSimulation: boolean;
}

function readSettings(): Settings {
	const cfg = vscode.workspace.getConfiguration('skillmap');
	const rules: RuleSettings = {
		skillBodyMaxLines: cfg.get<number>('rules.skillBodyMaxLines', DEFAULT_RULE_SETTINGS.skillBodyMaxLines),
		skillBodyMaxTokens: cfg.get<number>('rules.skillBodyMaxTokens', DEFAULT_RULE_SETTINGS.skillBodyMaxTokens),
		descriptionMaxLength: cfg.get<number>('rules.descriptionMaxLength', DEFAULT_RULE_SETTINGS.descriptionMaxLength),
		maxReferenceDepth: cfg.get<number>('rules.maxReferenceDepth', DEFAULT_RULE_SETTINGS.maxReferenceDepth),
		skillTotalTokenBudget: cfg.get<number>('rules.skillTotalTokenBudget', DEFAULT_RULE_SETTINGS.skillTotalTokenBudget),
		orphanFiles: cfg.get<'off' | 'info' | 'warn'>('rules.orphanFiles', DEFAULT_RULE_SETTINGS.orphanFiles),
		steeringAlwaysTokenBudget: cfg.get<number>(
			'rules.steeringAlwaysTokenBudget',
			DEFAULT_RULE_SETTINGS.steeringAlwaysTokenBudget,
		),
	};
	return {
		canonicalRoots: cfg.get<string[]>('canonicalRoots', ['.agents']),
		skillsRoots: cfg.get<string[]>('skillsRoots', []),
		rules,
		betaSpecs: cfg.get<boolean>('beta.specs', true),
		betaLoadSimulation: cfg.get<boolean>('beta.loadSimulation', true),
	};
}

function severityOf(w: SkillWarning): vscode.DiagnosticSeverity {
	switch (w.severity) {
		case 'error':
			return vscode.DiagnosticSeverity.Error;
		case 'warn':
			return vscode.DiagnosticSeverity.Warning;
		default:
			return vscode.DiagnosticSeverity.Information;
	}
}

export function activate(context: vscode.ExtensionContext): void {
	setLanguage(vscode.env.language.toLowerCase().startsWith('ja') ? 'ja' : 'en');
	const model = new SkillMapModel();
	const provider = new SkillTreeProvider(model);
	const diagnostics = vscode.languages.createDiagnosticCollection('skillmap');
	const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
	statusBar.name = L('SkillMap 経路合計', 'SkillMap Path Total');
	const simBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
	simBar.name = L('SkillMap ロードシミュレーション（β）', 'SkillMap Load Simulation (Beta)');
	const matrixHolder = { markdown: L('# SkillMap\n\n（データがありません）\n', '# SkillMap\n\n(no data)\n') };
	context.subscriptions.push(diagnostics, statusBar, simBar);

	const treeView = vscode.window.createTreeView('skillmap-view', {
		treeDataProvider: provider,
		showCollapseAll: true,
	});
	context.subscriptions.push(treeView);
	// 開閉状態を記録する（「表示中のツリーをコピー」と、再構築後の展開復元のため）
	context.subscriptions.push(
		treeView.onDidExpandElement((e) => provider.noteExpansion(e.element, true)),
		treeView.onDidCollapseElement((e) => provider.noteExpansion(e.element, false)),
	);
	context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(TIP_SCHEME, new TipContentProvider()));
	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(MATRIX_SCHEME, new MatrixContentProvider(matrixHolder)),
	);

	let currentSettings = readSettings();
	let refreshTimer: NodeJS.Timeout | undefined;

	// 対象ルートの絞り込み（マルチルート用）。undefined = 全ルート。
	// 選択はワークスペースごとに保持し、再起動後も維持する
	let rootFilter = context.workspaceState.get<string>('skillmap.rootFilter');
	const updateFilterMessage = () => {
		if (rootFilter) {
			const folder = (vscode.workspace.workspaceFolders ?? []).find((f) => f.uri.fsPath === rootFilter);
			treeView.message = `${L('表示対象', 'Showing')}: ${folder?.name ?? path.basename(rootFilter)}${L(' のみ（ルートで絞り込み中）', ' only (filtered by root)')}`;
		} else {
			treeView.message = undefined;
		}
	};

	const updateDiagnostics = (all: SkillWarning[]) => {
		diagnostics.clear();
		const byFile = new Map<string, vscode.Diagnostic[]>();
		for (const w of all) {
			// 孤立（R9）と Spec 欠け（S4）と予算（S3）はツリー表示に寄せる
			if (w.ruleId === 'R9' || w.ruleId === 'S4' || w.ruleId === 'S3') {
				continue;
			}
			if (!fs.existsSync(w.file)) {
				continue;
			}
			const line = Math.max(0, w.line ?? 0);
			const diag = new vscode.Diagnostic(
				new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER),
				`${w.ruleId}: ${w.message}`,
				severityOf(w),
			);
			diag.source = 'SkillMap';
			diag.code = w.ruleId;
			const arr = byFile.get(w.file) ?? [];
			arr.push(diag);
			byFile.set(w.file, arr);
		}
		for (const [file, diags] of byFile) {
			diagnostics.set(vscode.Uri.file(file), diags);
		}
	};

	const updateSimulation = () => {
		if (!currentSettings.betaLoadSimulation) {
			simBar.hide();
			return;
		}
		const editor = vscode.window.activeTextEditor;
		// マルチルート対応: 開いているファイルが所属するフォルダを基準にする
		const folder = editor ? vscode.workspace.getWorkspaceFolder(editor.document.uri) : undefined;
		if (!editor || !folder) {
			simBar.hide();
			return;
		}
		const workspaceRoot = folder.uri.fsPath;
		const rel = path.relative(workspaceRoot, editor.document.uri.fsPath).split(path.sep).join('/');
		if (rel.startsWith('..')) {
			simBar.hide();
			return;
		}
		// 対象は所属フォルダの Steering / Copilot のみ（他フォルダの分は読み込まれない）
		const steering = model.steering.filter((u) => u.workspaceRoot === workspaceRoot);
		const copilot = model.copilot.filter((u) => u.workspaceRoot === workspaceRoot);
		const sim = simulateLoad(rel, steering, copilot);
		const kiroTotal = sim.kiro.reduce((s, x) => s + x.tokens, 0);
		const copTotal = sim.copilot.reduce((s, x) => s + x.tokens, 0);
		if (steering.length === 0 && copilot.length === 0) {
			simBar.hide();
			return;
		}
		simBar.text = `$(book) ${L('読込β', 'Load β')} Kiro ≈${kiroTotal.toLocaleString()} / Copilot ≈${copTotal.toLocaleString()} tok`;
		const lines = [L(`対象: ${rel}`, `Target: ${rel}`), '', 'Kiro:'];
		for (const x of sim.kiro) {
			lines.push(`- ${x.name} ≈${x.tokens.toLocaleString()} tok (${x.reason})`);
		}
		lines.push('', 'Copilot:');
		for (const x of sim.copilot) {
			lines.push(`- ${x.name} ≈${x.tokens.toLocaleString()} tok（${x.reason}）`);
		}
		lines.push('', L('※ 簡易 glob 評価による目安です（β）', 'Note: estimate by simple glob matching (beta)'));
		simBar.tooltip = lines.join('\n');
		simBar.show();
	};

	const rebuild = () => {
		currentSettings = readSettings();
		const settings = currentSettings;
		const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
		// 選択中ルートがワークスペースから外れていたら絞り込みを解除する
		if (rootFilter && !workspaceRoots.includes(rootFilter)) {
			rootFilter = undefined;
			void context.workspaceState.update('skillmap.rootFilter', undefined);
		}
		void vscode.commands.executeCommand('setContext', 'skillmap.multiRoot', workspaceRoots.length > 1);
		// 絞り込み中は対象フォルダだけを走査する（表示量と走査コストの両方を減らす）
		const scanRoots = rootFilter ? [rootFilter] : workspaceRoots;
		// フォルダ内の全ファイルは rebuild につき1回だけ列挙し、発見・解決索引・
		// パターン評価で共有する（以前は処理ごとに歩き直して応答を落としていた）
		const knownFiles = new Map(scanRoots.map((r) => [r, listAllFiles(r)] as const));
		// 追加の探索ルート: 相対指定は各ワークスペースフォルダごとに解決する（マルチルート対応）
		const extraRoots: string[] = [];
		for (const r of settings.skillsRoots) {
			if (path.isAbsolute(r)) {
				extraRoots.push(r);
			} else {
				for (const w of scanRoots) {
					extraRoots.push(path.join(w, r));
				}
			}
		}
		// Skills（グルーピングのスコープは scopeRootFor: フォルダ内はフォルダ単位に揃える）
		const dirs = findSkillDirs(scanRoots, extraRoots, knownFiles);
		const units = dirs.map((d) => buildUnit(d, scopeRootFor(d, workspaceRoots, extraRoots)));
		const skills = groupSkills(units, settings.canonicalRoots);
		const skillWarnings = new Map<string, SkillWarning[]>();
		const allWarnings: SkillWarning[] = [];
		for (const skill of skills) {
			const w = evaluateSkill(skill, settings.rules);
			skillWarnings.set(skill.key, w);
			allWarnings.push(...w);
		}
		// Steering / Specs / Copilot
		const steering = discoverSteering(scanRoots, settings.canonicalRoots, knownFiles);
		// 相対パス一覧は fileMatch な Steering の死パターン判定（S2）でしか使わない。
		// 必要なときだけ作る（全ファイル分の変換は走査と同程度に重いため）
		const relPathsByRoot = steering.some((u) => u.inclusion === 'fileMatch')
			? new Map(
					scanRoots.map((r) => [
						r,
						(knownFiles.get(r) ?? []).slice(0, 30000).map((f) => path.relative(r, f).split(path.sep).join('/')),
					]),
				)
			: new Map<string, string[]>();
		const steeringWarnings = evaluateSteering(steering, relPathsByRoot, settings.rules);
		const specs = discoverSpecs(scanRoots, knownFiles);
		const specWarnings = evaluateSpecs(specs);
		const copilot = discoverCopilot(scanRoots, knownFiles);
		allWarnings.push(...steeringWarnings, ...specWarnings);

		model.skills = skills;
		model.skillWarnings = skillWarnings;
		model.steering = steering;
		model.steeringWarnings = steeringWarnings;
		model.specs = specs;
		model.specWarnings = specWarnings;
		model.copilot = copilot;
		model.betaSpecs = settings.betaSpecs;
		matrixHolder.markdown = renderLoadMatrix(skills, steering, specs, copilot);

		provider.refresh();
		updateFilterMessage();
		updateDiagnostics(allWarnings);
		updateSimulation();
	};
	const scheduleRefresh = () => {
		if (refreshTimer) {
			clearTimeout(refreshTimer);
		}
		refreshTimer = setTimeout(rebuild, 300);
	};

	// ツリーのテキストコピー（全体／表示中）。チャットやドキュメントへ貼って共有するため
	const copyTreeText = async (visibleOnly: boolean): Promise<void> => {
		const style =
			vscode.workspace.getConfiguration('skillmap').get<string>('copyTreeStyle') === 'ascii' ? 'ascii' : 'unicode';
		const text = renderCopyTree(provider.buildCopyForest(), style, visibleOnly);
		if (!text.trim()) {
			void vscode.window.showInformationMessage(L('コピーできるツリーがありません', 'There is no tree to copy'));
			return;
		}
		await vscode.env.clipboard.writeText(text);
		void vscode.window.showInformationMessage(
			visibleOnly
				? L('表示中のツリーをコピーしました', 'Visible tree copied to clipboard')
				: L('ツリーをコピーしました', 'Tree copied to clipboard'),
		);
	};

	context.subscriptions.push(
		vscode.commands.registerCommand('skillmap.refresh', () => rebuild()),
		vscode.commands.registerCommand('skillmap.expandAll', async () => {
			// ノードが多い時だけ進捗を出す（少ない時は従来どおり無言で展開する）。
			// 共有参照が多いツリーではノード数が経路数まで膨らみ、逐次 reveal に
			// 時間がかかるため、「終わらない」ように見えないよう進捗と残量を示す
			if (provider.collectExpandable().length > EXPAND_PROGRESS_THRESHOLD) {
				await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: L('すべて展開中', 'Expanding all'),
						cancellable: true,
					},
					(progress, token) =>
						provider.expandAll(
							treeView,
							(done, total) => progress.report({ increment: 100 / total, message: `${done} / ${total}` }),
							token,
						),
				);
			} else {
				await provider.expandAll(treeView);
			}
		}),
		vscode.commands.registerCommand('skillmap.copyTree', () => copyTreeText(false)),
		vscode.commands.registerCommand('skillmap.copyVisibleTree', () => copyTreeText(true)),
		vscode.commands.registerCommand('skillmap.selectRoot', () => {
			const folders = vscode.workspace.workspaceFolders ?? [];
			if (folders.length <= 1) {
				return;
			}
			type RootItem = vscode.QuickPickItem & { root?: string };
			const items: RootItem[] = [
				{ label: L('すべてのルート', 'All roots'), root: undefined },
				...folders.map((f): RootItem => ({ label: f.name, description: f.uri.fsPath, root: f.uri.fsPath })),
			];
			const qp = vscode.window.createQuickPick<RootItem>();
			qp.items = items;
			qp.placeholder = L('表示するルートを選択', 'Select the root to display');
			qp.activeItems = items.filter((i) => i.root === rootFilter);
			qp.onDidAccept(() => {
				const sel = qp.activeItems[0];
				qp.hide();
				if (!sel || sel.root === rootFilter) {
					return;
				}
				rootFilter = sel.root;
				void context.workspaceState.update('skillmap.rootFilter', rootFilter);
				rebuild();
			});
			qp.onDidHide(() => qp.dispose());
			qp.show();
		}),
		vscode.commands.registerCommand('skillmap.openFile', async (node?: MapNode) => {
			if (!node?.filePath) {
				return;
			}
			if (node.kind === 'missing') {
				// 参照切れ: 参照元を開く。Spec の欠落: Spec フォルダをエクスプローラーで示す
				if (node.specUnit) {
					await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(node.specUnit.dir));
					return;
				}
				const parentPath = node.parent?.filePath;
				if (!parentPath) {
					return;
				}
				const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(parentPath));
				const editor = await vscode.window.showTextDocument(doc, { preview: true });
				const line = node.warnings.find((w) => w.line !== undefined)?.line;
				if (line !== undefined) {
					const pos = new vscode.Position(line, 0);
					editor.selection = new vscode.Selection(pos, pos);
					editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
				}
				return;
			}
			const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(node.filePath));
			const editor = await vscode.window.showTextDocument(doc, { preview: true });
			const line = node.warnings.find((w) => w.file === node.filePath)?.line;
			if (line !== undefined) {
				const pos = new vscode.Position(line, 0);
				editor.selection = new vscode.Selection(pos, pos);
				editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
			}
		}),
		vscode.commands.registerCommand('skillmap.openTip', async (arg?: { ruleId: string; warningMessage?: string } | MapNode) => {
			let ruleId: string | undefined;
			let warningMessage: string | undefined;
			if (arg instanceof MapNode) {
				const first = arg.warnings[0] ?? arg.allWarnings()[0];
				ruleId = first?.ruleId;
				warningMessage = first?.message;
			} else if (arg && typeof arg === 'object') {
				ruleId = arg.ruleId;
				warningMessage = arg.warningMessage;
			}
			if (!ruleId) {
				void vscode.window.showInformationMessage(L('このノードに警告はありません', 'This node has no warnings'));
				return;
			}
			const query = new URLSearchParams({ rule: ruleId });
			if (warningMessage) {
				query.set('message', warningMessage);
			}
			const uri = vscode.Uri.from({ scheme: TIP_SCHEME, path: `/tips/${ruleId}.md`, query: query.toString() });
			const doc = await vscode.workspace.openTextDocument(uri);
			await vscode.window.showTextDocument(doc, { preview: true });
			try {
				await vscode.commands.executeCommand('markdown.showPreview', uri);
			} catch {
				// プレビューが使えない環境ではソース表示で代替
			}
		}),
		vscode.commands.registerCommand('skillmap.showLoadMatrix', async () => {
			const uri = vscode.Uri.from({ scheme: MATRIX_SCHEME, path: '/load-matrix.md' });
			const doc = await vscode.workspace.openTextDocument(uri);
			await vscode.window.showTextDocument(doc, { preview: true });
			try {
				await vscode.commands.executeCommand('markdown.showPreview', uri);
			} catch {
				// プレビューが使えない環境ではソース表示で代替
			}
		}),
	);

	treeView.onDidChangeSelection((e) => {
		const node = e.selection[0];
		if (!node || !node.filePath || node.kind === 'section' || node.kind === 'skill' || node.kind === 'copy' || node.kind === 'orphanGroup' || node.kind === 'spec') {
			statusBar.hide();
			return;
		}
		const files = node.pathFiles();
		// 経路合計は SKILL.md 起点の場合のみ意味を持つため、Skills 配下でのみ表示する
		const inSkills = files.some((n) => n.unit?.skillMdPath === n.filePath) || node.skill !== undefined;
		if (!inSkills || files.length === 0) {
			statusBar.hide();
			return;
		}
		const total = files.reduce((sum, n) => sum + n.ownTokens, 0);
		statusBar.text = `$(graph-line) ${L(`経路合計 ≈${total.toLocaleString()} tok（${files.length}ファイル）`, `Path total ≈${total.toLocaleString()} tok (${files.length} files)`)}`;
		statusBar.tooltip = files
			.map((n) => `${path.basename(n.filePath ?? '')}: ≈${n.ownTokens.toLocaleString()} tok`)
			.join('\n');
		statusBar.show();
	});

	const skillWatcher = vscode.workspace.createFileSystemWatcher('**/SKILL.md');
	skillWatcher.onDidCreate(scheduleRefresh);
	skillWatcher.onDidDelete(scheduleRefresh);
	skillWatcher.onDidChange(scheduleRefresh);
	context.subscriptions.push(skillWatcher);
	const contextWatcher = vscode.workspace.createFileSystemWatcher('**/{.kiro,.github}/**/*.md');
	contextWatcher.onDidCreate(scheduleRefresh);
	contextWatcher.onDidDelete(scheduleRefresh);
	contextWatcher.onDidChange(scheduleRefresh);
	context.subscriptions.push(contextWatcher);
	context.subscriptions.push(
		vscode.workspace.onDidSaveTextDocument((doc) => {
			const p = doc.uri.fsPath;
			const relevant =
				p.endsWith('SKILL.md') ||
				p.endsWith('AGENTS.md') ||
				p.includes(`${path.sep}.kiro${path.sep}`) ||
				p.includes(`${path.sep}.github${path.sep}`) ||
				model.skills.some((s) => p.startsWith(s.canonical.dir) || s.copies.some((c) => p.startsWith(c.dir)));
			if (relevant) {
				scheduleRefresh();
			}
		}),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('skillmap')) {
				scheduleRefresh();
			}
		}),
		vscode.window.onDidChangeActiveTextEditor(() => updateSimulation()),
		// マルチルート: フォルダの追加・削除に追随して再スキャンする
		vscode.workspace.onDidChangeWorkspaceFolders(() => scheduleRefresh()),
	);

	rebuild();
}

export function deactivate(): void {}
