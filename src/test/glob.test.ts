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

test('レビュー指摘4: リスト全体の上限（入力長・要素数・総コンパイル数）でも一致なしに倒す', () => {
	// 入力長: 約200KB のリストは、要素単位では上限内でも丸ごと一致なし。
	// 旧実装では約10万個の RegExp を同期生成していた
	const longList = Array.from({ length: 20_000 }, (_, i) => `p${i}/*.md`).join(',');
	const start = Date.now();
	assert.equal(matchesAnyPattern(longList, 'p0/x.md'), false);
	assert.ok(Date.now() - start < 5000, 'リスト全体の上限で即座に打ち切られる');
	// 要素数: 129要素目は上限（128）超過で、一致する要素があっても一致なし
	const manyParts = [...Array.from({ length: 128 }, (_, i) => `no${i}/*.zzz`), 'src/**/*.tsx'].join(',');
	assert.equal(matchesAnyPattern(manyParts, 'src/App.tsx'), false);
	// 総コンパイル数: 展開後 8 件 × 100 要素 = 800 件は上限（512）超過で一致なし
	const wideList = Array.from({ length: 100 }, (_, i) => `d${i}/{a,b,c,d,e,f,g,h}/*.md`).join(',');
	assert.equal(matchesAnyPattern(wideList, 'd0/a/x.md'), false);
	// 上限内（展開後 8 件 × 64 要素 = 512 件ちょうど）は従来どおり一致する
	const justFits = Array.from({ length: 64 }, (_, i) => `d${i}/{a,b,c,d,e,f,g,h}/*.md`).join(',');
	assert.equal(matchesAnyPattern(justFits, 'd63/h/x.md'), true);
	assert.equal(matchesAnyPattern(justFits, 'd63/z/x.md'), false);
	// 上限超過リストの後でも、通常のリストは従来どおり動く（キャッシュが壊れない）
	assert.equal(matchesAnyPattern('src/**/*.tsx', 'src/App.tsx'), true);
	assert.equal(matchesAnyPattern('src/**/*.tsx', 'src/App.ts'), false);
});
