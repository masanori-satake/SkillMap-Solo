import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesAnyPattern } from '../glob.js';

test('** は階層を跨ぐ', () => {
	assert.equal(matchesAnyPattern('src/**/*.tsx', 'src/components/App.tsx'), true);
	assert.equal(matchesAnyPattern('src/**/*.tsx', 'src/App.tsx'), true);
	assert.equal(matchesAnyPattern('src/**/*.tsx', 'src/App.ts'), false);
	assert.equal(matchesAnyPattern('src/**/*.tsx', 'other/App.tsx'), false);
});

test('* は / を跨がない', () => {
	assert.equal(matchesAnyPattern('*.md', 'README.md'), true);
	assert.equal(matchesAnyPattern('docs/*.md', 'docs/a.md'), true);
	assert.equal(matchesAnyPattern('docs/*.md', 'docs/sub/a.md'), false);
});

test('カンマ区切りとブレース展開', () => {
	assert.equal(matchesAnyPattern('**/*.{ts,tsx}', 'a/b.ts'), true);
	assert.equal(matchesAnyPattern('**/*.{ts,tsx}', 'a/b.tsx'), true);
	assert.equal(matchesAnyPattern('**/*.ts, **/*.md', 'x/y.md'), true);
	assert.equal(matchesAnyPattern('**/*.ts, **/*.md', 'x/y.js'), false);
});

test('Copilot applyTo の典型パターン', () => {
	assert.equal(matchesAnyPattern('src/**', 'src/index.ts'), true);
	assert.equal(matchesAnyPattern('**/*.py', 'tools/gen.py'), true);
});

test('監査指摘3: ブレース展開の指数爆発を上限で止める', () => {
	// {a,b} を多数連結したパターンは展開が 2^n に膨らむ。上限（グループ数 8）を超えたら
	// 一致なしとして即座に返ること（旧実装では20個で約56秒かかった）
	const bomb = '{a,b}'.repeat(20);
	const start = Date.now();
	assert.equal(matchesAnyPattern(bomb, 'abababababababababab'), false);
	assert.ok(Date.now() - start < 2000, '上限で即座に打ち切られる');
	// 展開後件数の上限（64）を超える単一グループも一致なし
	const manyAlts = `{${Array.from({ length: 100 }, (_, i) => `f${i}.md`).join(',')}}`;
	assert.equal(matchesAnyPattern(manyAlts, 'f50.md'), false);
	// 長さ上限（512文字）を超えるパターンも一致なし
	assert.equal(matchesAnyPattern(`${'a'.repeat(513)}.md`, `${'a'.repeat(513)}.md`), false);
});

test('上限内のブレース展開と繰り返し呼び出し（キャッシュ）は従来どおり', () => {
	assert.equal(matchesAnyPattern('src/{a,b}/{c,d}.ts', 'src/a/d.ts'), true);
	assert.equal(matchesAnyPattern('src/{a,b}/{c,d}.ts', 'src/a/e.ts'), false);
	// コンパイル結果キャッシュを介しても結果が一貫する
	assert.equal(matchesAnyPattern('src/**/*.tsx', 'src/App.tsx'), true);
	assert.equal(matchesAnyPattern('src/**/*.tsx', 'src/App.tsx'), true);
	assert.equal(matchesAnyPattern('src/**/*.tsx', 'src/App.ts'), false);
});
