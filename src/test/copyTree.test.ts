import * as assert from 'node:assert/strict';
import test from 'node:test';
import { renderCopyTree, type CopyTreeNode } from '../copyTree.js';

function node(label: string, opts: Partial<CopyTreeNode> = {}): CopyTreeNode {
	return { label, expanded: false, children: [], ...opts };
}

function sample(): CopyTreeNode[] {
	return [
		node('Skills', {
			description: '2件',
			expanded: true,
			children: [
				node('demo', {
					description: '合計 ≈30 tok',
					expanded: true,
					children: [
						node('SKILL.md', { description: '≈20 tok L1' }),
						node('guide.md', { description: '≈10 tok L2' }),
					],
				}),
				node('other', { description: '合計 ≈5 tok' }),
			],
		}),
		node('Specs（β）', { description: '1件' }),
	];
}

test('全体コピー（Unicode）: セクションは罫線なし、配下は罫線でぶら下がる', () => {
	const text = renderCopyTree(sample(), 'unicode', false);
	assert.equal(
		text,
		[
			'Skills  2件',
			'├─ demo  合計 ≈30 tok',
			'│  ├─ SKILL.md  ≈20 tok L1',
			'│  └─ guide.md  ≈10 tok L2',
			'└─ other  合計 ≈5 tok',
			'Specs（β）  1件',
		].join('\n'),
	);
});

test('全体コピー（ASCII）: 罫線が ASCII になる', () => {
	const text = renderCopyTree(sample(), 'ascii', false);
	assert.ok(text.includes('+- demo  合計 ≈30 tok'));
	assert.ok(text.includes('|  +- SKILL.md'));
	assert.ok(!text.includes('├'));
});

test('表示中コピー: 閉じたノードの子は含まれない', () => {
	const forest = sample();
	// demo を閉じた状態にする
	forest[0].children[0].expanded = false;
	const text = renderCopyTree(forest, 'unicode', true);
	assert.ok(text.includes('demo'));
	assert.ok(!text.includes('SKILL.md'), '閉じたノードの子は出ない');
	assert.ok(!text.includes('guide.md'));
	// 閉じたセクションの配下も出ない
	assert.ok(!text.includes('partial'));
	const closed = renderCopyTree([node('Specs（β）', { expanded: false, children: [node('spec-a')] })], 'unicode', true);
	assert.equal(closed, 'Specs（β）');
});

test('表示中コピー: 開いたノードの子は全体コピーと同じに出る', () => {
	const text = renderCopyTree(sample(), 'unicode', true);
	assert.ok(text.includes('SKILL.md  ≈20 tok L1'));
});
