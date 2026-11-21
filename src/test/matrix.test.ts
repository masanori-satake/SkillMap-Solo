import assert from 'node:assert/strict';
import test from 'node:test';
import type { CopilotUnit, SpecUnit } from '../contexts.js';
import { renderLoadMatrix } from '../matrix.js';

function copilotUnit(root: string, tokens: number): CopilotUnit {
	return {
		kind: 'copilot',
		filePath: `${root}/AGENTS.md`,
		workspaceRoot: root,
		name: 'AGENTS.md',
		mode: 'always',
		tokens,
	};
}

function specUnit(root: string, name: string): SpecUnit {
	return {
		kind: 'spec',
		name,
		workspaceRoot: root,
		dir: `${root}/.kiro/specs/${name}`,
		files: [],
		totalTokens: 42,
	};
}

test('ロードマトリクス: マルチルートでは同名ファイルにフォルダ名が付く', () => {
	const md = renderLoadMatrix(
		[],
		[],
		[specUnit('/home/u/repoA', 'alpha'), specUnit('/home/u/repoB', 'beta')],
		[copilotUnit('/home/u/repoA', 100), copilotUnit('/home/u/repoB', 200)],
	);
	assert.match(md, /\| AGENTS\.md · repoA \|/);
	assert.match(md, /\| AGENTS\.md · repoB \|/);
	assert.match(md, /\| Spec: alpha · repoA \|/);
	assert.match(md, /\| Spec: beta · repoB \|/);
});

test('ロードマトリクス: 列順は Copilot が Kiro の左', () => {
	const md = renderLoadMatrix([], [], [], [copilotUnit('/home/u/repoA', 100)]);
	assert.match(md, /\| ファイル \| Copilot \| Kiro \| 推定トークン \|/);
	// Copilot 行: Copilot 列に読み込み条件、Kiro 列に「読まれない」
	assert.match(md, /\| AGENTS\.md \| 常時 \| 読まれない \| ≈100 \|/);
});

test('ロードマトリクス: 単一ルートではフォルダ名を付けない', () => {
	const md = renderLoadMatrix([], [], [specUnit('/home/u/repoA', 'alpha')], [copilotUnit('/home/u/repoA', 100)]);
	assert.match(md, /\| AGENTS\.md \|/);
	assert.match(md, /\| Spec: alpha \|/);
	assert.doesNotMatch(md, /repoA/);
});

test('ロードマトリクス: 未解析の Steering は「常時」ではなく未解析と表示する', () => {
	const steeringUnit = (unparsed: boolean): import('../contexts.js').SteeringUnit => ({
		kind: 'steering',
		filePath: '/r/.kiro/steering/huge.md',
		workspaceRoot: '/r',
		name: 'huge',
		inclusion: 'always',
		inclusionExplicit: false,
		unparsed: unparsed || undefined,
		tokens: 0,
		graph: { rootPath: '/r/.kiro/steering/huge.md', ownedDir: '/r/.kiro/steering', files: new Map(), depthDisplay: new Map(), reachable: new Set() },
	});
	const mdUnparsed = renderLoadMatrix([], [steeringUnit(true)], [], []);
	assert.match(mdUnparsed, /未解析/);
	assert.ok(!mdUnparsed.includes('| 常時 |'), '未解析を常時ロードとして表示しない');
	const mdParsed = renderLoadMatrix([], [steeringUnit(false)], [], []);
	assert.ok(mdParsed.includes('| 常時 |'), '解析できた always は従来どおり「常時」と表示する');
});

test('ロードマトリクス: 未解析の理由をサイズ上限超と断定しない', () => {
	// unparsed はサイズ上限超のほか、通常ファイルでない・読み取り失敗でも立つ。
	// 理由を保持していないので、表示で特定の原因を断定してはいけない
	const unit: import('../contexts.js').SteeringUnit = {
		kind: 'steering',
		filePath: '/r/.kiro/steering/unreadable.md',
		workspaceRoot: '/r',
		name: 'unreadable',
		inclusion: 'always',
		inclusionExplicit: false,
		unparsed: true,
		tokens: 0,
		graph: { rootPath: '/r/.kiro/steering/unreadable.md', ownedDir: '/r/.kiro/steering', files: new Map(), depthDisplay: new Map(), reachable: new Set() },
	};
	const md = renderLoadMatrix([], [unit], [], []);
	assert.match(md, /未解析（内容を読み取れませんでした）/);
	assert.doesNotMatch(md, /サイズ上限/, '未解析の原因をサイズ上限超と断定しない');
});

test('ロードマトリクス: リポジトリ由来文字列のリンク構文がエスケープされる', () => {
	const spec = specUnit('/ws', '[悪性](https://example.com)');
	const md = renderLoadMatrix([], [], [spec], []);
	assert.ok(md.includes('\\[悪性\\]'), '角括弧がエスケープされる');
	assert.ok(!md.includes('[悪性](https://example.com)'), 'リンク記法がそのまま残らない');
	const copilot: CopilotUnit = {
		...copilotUnit('/ws', 10),
		mode: 'applyTo',
		applyTo: '**/*.ts` [x](https://example.com)',
	};
	const md2 = renderLoadMatrix([], [], [], [copilot]);
	assert.ok(md2.includes('\\[x\\]'), 'applyTo の角括弧がエスケープされる');
	assert.ok(md2.includes('\\`'), 'applyTo のバッククォートがエスケープされる');
	assert.ok(!md2.includes('[x](https://example.com)'), 'applyTo のリンク記法がそのまま残らない');
});
