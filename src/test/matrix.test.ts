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

test('ロードマトリクス: 単一ルートではフォルダ名を付けない', () => {
	const md = renderLoadMatrix([], [], [specUnit('/home/u/repoA', 'alpha')], [copilotUnit('/home/u/repoA', 100)]);
	assert.match(md, /\| AGENTS\.md \|/);
	assert.match(md, /\| Spec: alpha \|/);
	assert.doesNotMatch(md, /repoA/);
});
