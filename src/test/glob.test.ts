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
