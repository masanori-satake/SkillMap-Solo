import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
	discoverCopilot,
	discoverSpecs,
	discoverSteering,
	listWorkspaceRelPaths,
	simulateLoad,
} from '../contexts.js';
import { DEFAULT_RULE_SETTINGS, evaluateSpecs, evaluateSteering } from '../rules.js';
import { setLanguage } from '../i18n.js';

function tmpRoot(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'skillmap-ctx-'));
}

function write(root: string, rel: string, content: string): void {
	const full = path.join(root, rel);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content, 'utf8');
}

function setupWorkspace(root: string): void {
	write(root, '.kiro/steering/base.md', '# Base\n\n常時適用の方針。\n');
	write(root, '.kiro/steering/react.md', '---\ninclusion: fileMatch\nfileMatchPattern: "src/**/*.tsx"\n---\n\n# React\n');
	write(root, '.kiro/steering/dead.md', '---\ninclusion: fileMatch\nfileMatchPattern: "nope/**/*.zzz"\n---\n\n# Dead\n');
	write(root, '.kiro/steering/manual.md', '---\ninclusion: manual\n---\n\n# Manual\n');
	write(root, '.agents/steering/base.md', '# Base 正本（内容が違う）\n');
	write(root, '.kiro/specs/checkout/requirements.md', '# Requirements\n');
	write(root, '.kiro/specs/checkout/tasks.md', '# Tasks\n');
	write(root, '.github/copilot-instructions.md', '# Copilot\n');
	write(root, '.github/instructions/react.instructions.md', '---\napplyTo: "src/**/*.tsx"\n---\n\n# React rules\n');
	write(root, 'AGENTS.md', '# Agents\n');
	write(root, 'src/App.tsx', 'export {};\n');
}

test('Steering 発見と inclusion 解析、S1/S2 が機能する', () => {
	const root = tmpRoot();
	setupWorkspace(root);
	const steering = discoverSteering([root]);
	assert.equal(steering.length, 4);
	const byName = new Map(steering.map((s) => [s.name, s]));
	assert.equal(byName.get('base')?.inclusion, 'always');
	assert.equal(byName.get('base')?.inclusionExplicit, false);
	assert.equal(byName.get('react')?.inclusion, 'fileMatch');
	assert.equal(byName.get('manual')?.inclusion, 'manual');

	const rels = new Map([[root, listWorkspaceRelPaths([root])]]);
	const warnings = evaluateSteering(steering, rels, DEFAULT_RULE_SETTINGS);
	const byRule = (id: string) => warnings.filter((w) => w.ruleId === id);
	assert.equal(byRule('S1').length, 1, 'base.md の inclusion 未指定');
	assert.equal(byRule('S2').length, 1, 'dead.md の死パターン');
	assert.ok(byRule('S2')[0].file.endsWith('dead.md'));
	assert.equal(byRule('S5').length, 0, '正本との乖離チェック（廃止済み）は出ない');
});

test('Specs 発見と S4（design 欠け）が機能する', () => {
	const root = tmpRoot();
	setupWorkspace(root);
	const specs = discoverSpecs([root]);
	assert.equal(specs.length, 1);
	assert.equal(specs[0].files.filter((f) => f.present).length, 2);
	const warnings = evaluateSpecs(specs);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0].message, /design\.md/);
});

test('Copilot 発見とロードシミュレーションが機能する', () => {
	const root = tmpRoot();
	setupWorkspace(root);
	const copilot = discoverCopilot([root]);
	assert.equal(copilot.length, 3);
	const steering = discoverSteering([root]);
	const sim = simulateLoad('src/App.tsx', steering, copilot);
	// Kiro: base(常時) + react(fileMatch一致)。Copilot: copilot-instructions + AGENTS + react instructions(applyTo一致)
	assert.deepEqual(sim.kiro.map((x) => x.name).sort(), ['base.md', 'react.md']);
	assert.equal(sim.copilot.length, 3);
	const sim2 = simulateLoad('docs/note.md', steering, copilot);
	assert.deepEqual(sim2.kiro.map((x) => x.name), ['base.md']);
	assert.equal(sim2.copilot.length, 2, 'applyTo 不一致の instructions は含まれない');
});

test('Kiro の予約 Steering (product/structure/tech) には S1 を出さない', () => {
	const root = tmpRoot();
	setupWorkspace(root);
	write(root, '.kiro/steering/product.md', '# Product\n\nプロダクト概要。\n');
	write(root, '.kiro/steering/structure.md', '# Structure\n\n構成。\n');
	write(root, '.kiro/steering/tech.md', '# Tech\n\n技術。\n');
	write(root, '.kiro/steering/custom-notes.md', '# Notes\n\n独自メモ。\n');
	const steering = discoverSteering([root]);
	const rels = new Map([[root, listWorkspaceRelPaths([root])]]);
	const warnings = evaluateSteering(steering, rels, DEFAULT_RULE_SETTINGS);
	const s1Files = warnings.filter((w) => w.ruleId === 'S1').map((w) => path.basename(w.file));
	assert.ok(!s1Files.includes('product.md'), 'product.md は S1 対象外');
	assert.ok(!s1Files.includes('structure.md'), 'structure.md は S1 対象外');
	assert.ok(!s1Files.includes('tech.md'), 'tech.md は S1 対象外');
	assert.ok(s1Files.includes('custom-notes.md'), '通常の Steering には S1 が出る');
	// 予約ファイルも常時ロードとしての集計・シミュレーション対象ではあること
	const product = steering.find((s) => s.name === 'product');
	assert.equal(product?.inclusion, 'always');
});

test('inclusion の綴り間違いに S6 が出る', () => {
	const root = tmpRoot();
	setupWorkspace(root);
	write(root, '.kiro/steering/typo.md', '---\ninclusion: alwyas\n---\n\n# Typo\n');
	const steering = discoverSteering([root]);
	const rels = new Map([[root, listWorkspaceRelPaths([root])]]);
	const warnings = evaluateSteering(steering, rels, DEFAULT_RULE_SETTINGS);
	const s6 = warnings.filter((w) => w.ruleId === 'S6');
	assert.equal(s6.length, 1);
	assert.ok(s6[0].file.endsWith('typo.md'));
	// 暗黙に always 扱いになることも併せて確認
	const typo = steering.find((s) => s.name === 'typo');
	assert.equal(typo?.inclusion, 'always');
});

test('監査指摘1: Steering の読み込みにもサイズ上限が効く', () => {
	const root = tmpRoot();
	setupWorkspace(root);
	// 1MB 超の steering は内容を読まない（トークン 0、frontmatter も読めない）
	write(root, '.kiro/steering/huge.md', '---\ninclusion: manual\n---\n\n' + 'あ'.repeat(600_000));
	const steering = discoverSteering([root]);
	const huge = steering.find((s) => s.name === 'huge');
	assert.ok(huge);
	assert.equal(huge.tokens, 0);
});

test('表示言語を英語に切り替えると警告メッセージも英語になる', () => {
	const root = tmpRoot();
	setupWorkspace(root);
	const steering = discoverSteering([root]);
	const rels = new Map([[root, listWorkspaceRelPaths([root])]]);
	setLanguage('en');
	try {
		const warnings = evaluateSteering(steering, rels, DEFAULT_RULE_SETTINGS);
		const s1 = warnings.find((w) => w.ruleId === 'S1');
		assert.ok(s1 && s1.message.includes('inclusion is not specified'));
		const s2 = warnings.find((w) => w.ruleId === 'S2');
		assert.ok(s2 && s2.message.includes('matches no file'));
	} finally {
		setLanguage('ja');
	}
});

test('レビュー指摘1: サイズ上限超の Steering は未解析として扱い、常時ロードに数えない', () => {
	const root = tmpRoot();
	write(root, '.kiro/steering/normal.md', '# Normal\n\n通常の常時ロード。\n');
	// frontmatter では inclusion: manual だが、サイズ上限超で内容を読めない
	write(root, '.kiro/steering/huge.md', '---\ninclusion: manual\n---\n\n' + 'あ'.repeat(600_000));
	const steering = discoverSteering([root]);
	const huge = steering.find((s) => s.name === 'huge');
	assert.ok(huge, 'ユニット自体は保持される');
	assert.equal(huge.tokens, 0);
	assert.equal(huge.unparsed, true, 'サイズ超過は未解析として区別される');
	// ロードシミュレーション: 未解析は常時ロードとして報告しない
	const sim = simulateLoad('src/App.tsx', steering, []);
	assert.deepEqual(sim.kiro.map((x) => x.name), ['normal.md']);
	// S1（inclusion 未指定）は未解析には誤発しない
	const rels = new Map([[root, listWorkspaceRelPaths([root])]]);
	const warnings = evaluateSteering(steering, rels, DEFAULT_RULE_SETTINGS);
	assert.equal(warnings.filter((w) => w.ruleId === 'S1' && w.file.endsWith('huge.md')).length, 0);
	// 対照: 空ファイルは未解析ではなく、従来どおり「未指定＝常時」として扱われる
	write(root, '.kiro/steering/empty.md', '');
	const steering2 = discoverSteering([root]);
	const empty = steering2.find((s) => s.name === 'empty');
	assert.equal(empty?.unparsed, undefined);
	assert.equal(empty?.inclusion, 'always');
	const warnings2 = evaluateSteering(steering2, rels, DEFAULT_RULE_SETTINGS);
	assert.equal(warnings2.filter((w) => w.ruleId === 'S1' && w.file.endsWith('empty.md')).length, 1);
});
