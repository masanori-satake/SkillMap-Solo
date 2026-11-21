import assert from 'node:assert/strict';
import test from 'node:test';
import { renderTipMarkdown } from '../tips.js';

test('Tips: 警告文のリポジトリ由来文字列がエスケープされる', () => {
	const md = renderTipMarkdown('R1', '[悪性](https://example.com) と `code` <b> を含む警告');
	assert.ok(md.includes('\\[悪性\\]'), '角括弧がエスケープされる');
	assert.ok(md.includes('\\`code\\`'), 'バッククォートがエスケープされる');
	assert.ok(md.includes('\\<b\\>'), '山括弧がエスケープされる');
	assert.ok(!md.includes('[悪性](https://example.com)'), 'リンク記法がそのまま残らない');
});
