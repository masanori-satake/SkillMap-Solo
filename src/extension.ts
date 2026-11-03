import * as path from 'node:path';
import * as vscode from 'vscode';
import { buildUnit, findSkillDirs, groupSkills } from './skills.js';
import {
	DEFAULT_RULE_SETTINGS,
	evaluateSkill,
	type RuleSettings,
	type SkillWarning,
} from './rules.js';
import { MapNode, SkillMapModel, SkillTreeProvider } from './treeProvider.js';
import { renderTipMarkdown } from './tips.js';

const TIP_SCHEME = 'skillmap-tip';

class TipContentProvider implements vscode.TextDocumentContentProvider {
	provideTextDocumentContent(uri: vscode.Uri): string {
		const params = new URLSearchParams(uri.query);
		const ruleId = params.get('rule') ?? '';
		const message = params.get('message') ?? undefined;
		return renderTipMarkdown(ruleId, message);
	}
}

function readSettings(): { canonicalRoots: string[]; skillsRoots: string[]; rules: RuleSettings } {
	const cfg = vscode.workspace.getConfiguration('skillmap');
	const rules: RuleSettings = {
		skillBodyMaxLines: cfg.get<number>('rules.skillBodyMaxLines', DEFAULT_RULE_SETTINGS.skillBodyMaxLines),
		skillBodyMaxTokens: cfg.get<number>('rules.skillBodyMaxTokens', DEFAULT_RULE_SETTINGS.skillBodyMaxTokens),
		descriptionMaxLength: cfg.get<number>('rules.descriptionMaxLength', DEFAULT_RULE_SETTINGS.descriptionMaxLength),
		maxReferenceDepth: cfg.get<number>('rules.maxReferenceDepth', DEFAULT_RULE_SETTINGS.maxReferenceDepth),
		skillTotalTokenBudget: cfg.get<number>('rules.skillTotalTokenBudget', DEFAULT_RULE_SETTINGS.skillTotalTokenBudget),
		orphanFiles: cfg.get<'off' | 'info' | 'warn'>('rules.orphanFiles', DEFAULT_RULE_SETTINGS.orphanFiles),
	};
	return {
		canonicalRoots: cfg.get<string[]>('canonicalRoots', ['.agents']),
		skillsRoots: cfg.get<string[]>('skillsRoots', []),
		rules,
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
	const model = new SkillMapModel();
	const provider = new SkillTreeProvider(model);
	const diagnostics = vscode.languages.createDiagnosticCollection('skillmap');
	const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
	statusBar.name = 'SkillMap 経路合計';
	context.subscriptions.push(diagnostics, statusBar);

	const treeView = vscode.window.createTreeView('skillmap-view', {
		treeDataProvider: provider,
		showCollapseAll: true,
	});
	context.subscriptions.push(treeView);
	context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(TIP_SCHEME, new TipContentProvider()));

	let refreshTimer: NodeJS.Timeout | undefined;
	const rebuild = () => {
		const settings = readSettings();
		const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
		const extraRoots = settings.skillsRoots.map((r) =>
			path.isAbsolute(r) ? r : path.join(workspaceRoots[0] ?? '', r),
		);
		const dirs = findSkillDirs(workspaceRoots, extraRoots);
		const units = dirs.map((d) => buildUnit(d));
		const skills = groupSkills(units, settings.canonicalRoots);
		const warnings = new Map<string, SkillWarning[]>();
		for (const skill of skills) {
			warnings.set(skill.key, evaluateSkill(skill, settings.rules));
		}
		model.setData(skills, warnings);
		provider.refresh();
		updateDiagnostics(diagnostics, warnings);
	};
	const scheduleRefresh = () => {
		if (refreshTimer) {
			clearTimeout(refreshTimer);
		}
		refreshTimer = setTimeout(rebuild, 300);
	};

	const updateDiagnostics = (
		collection: vscode.DiagnosticCollection,
		warnings: Map<string, SkillWarning[]>,
	) => {
		collection.clear();
		const byFile = new Map<string, vscode.Diagnostic[]>();
		for (const list of warnings.values()) {
			for (const w of list) {
				if (w.ruleId === 'R9') {
					continue; // 孤立はツリー表示に寄せ、Problems には出さない
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
		}
		for (const [file, diags] of byFile) {
			collection.set(vscode.Uri.file(file), diags);
		}
	};

	context.subscriptions.push(
		vscode.commands.registerCommand('skillmap.refresh', () => rebuild()),
		vscode.commands.registerCommand('skillmap.openFile', async (node?: MapNode) => {
			if (!node?.filePath) {
				return;
			}
			const target = node.kind === 'missing' ? node.parent?.filePath : node.filePath;
			if (!target) {
				return;
			}
			const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
			const editor = await vscode.window.showTextDocument(doc, { preview: true });
			const warnLine = node.warnings.find((w) => w.line !== undefined)?.line;
			const line = node.kind === 'missing' ? warnLine : node.warnings.find((w) => w.file === node.filePath)?.line;
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
				void vscode.window.showInformationMessage('このノードに警告はありません');
				return;
			}
			const query = new URLSearchParams({ rule: ruleId });
			if (warningMessage) {
				query.set('message', warningMessage);
			}
			const uri = vscode.Uri.from({ scheme: TIP_SCHEME, path: `/tips/${ruleId}.md`, query: query.toString() });
			const doc = await vscode.workspace.openTextDocument(uri);
			await vscode.window.showTextDocument(doc, { preview: true });
			// Markdown プレビューで開く（失敗したらソース表示のまま）
			try {
				await vscode.commands.executeCommand('markdown.showPreview', uri);
			} catch {
				// プレビューが使えない環境ではソース表示で代替
			}
		}),
	);

	// 経路合計のステータスバー表示
	treeView.onDidChangeSelection((e) => {
		const node = e.selection[0];
		if (!node || !node.filePath || node.kind === 'skill' || node.kind === 'copy' || node.kind === 'orphanGroup') {
			statusBar.hide();
			return;
		}
		const files = node.pathFiles();
		if (files.length === 0) {
			statusBar.hide();
			return;
		}
		const total = files.reduce((sum, n) => sum + n.ownTokens, 0);
		statusBar.text = `$(graph-line) 経路合計 ≈${total.toLocaleString()} tok（${files.length}ファイル）`;
		statusBar.tooltip = files
			.map((n) => `${path.basename(n.filePath ?? '')}: ≈${n.ownTokens.toLocaleString()} tok`)
			.join('\n');
		statusBar.show();
	});

	// 変更への追従
	const skillWatcher = vscode.workspace.createFileSystemWatcher('**/SKILL.md');
	skillWatcher.onDidCreate(scheduleRefresh);
	skillWatcher.onDidDelete(scheduleRefresh);
	skillWatcher.onDidChange(scheduleRefresh);
	context.subscriptions.push(skillWatcher);
	context.subscriptions.push(
		vscode.workspace.onDidSaveTextDocument((doc) => {
			const p = doc.uri.fsPath;
			if (p.endsWith('SKILL.md') || model.skills.some((s) => p.startsWith(s.canonical.dir) || s.copies.some((c) => p.startsWith(c.dir)))) {
				scheduleRefresh();
			}
		}),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('skillmap')) {
				scheduleRefresh();
			}
		}),
	);

	rebuild();
}

export function deactivate(): void {}
