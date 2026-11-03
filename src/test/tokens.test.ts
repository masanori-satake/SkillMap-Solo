import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateTokens } from '../tokens.js';

test('英数字は約4文字で1トークン', () => {
	assert.equal(estimateTokens('abcd'), 1);
	assert.equal(estimateTokens('abcdefgh'), 2);
});

test('日本語は約1文字で1トークン', () => {
	assert.equal(estimateTokens('あいうえお'), 5);
	assert.equal(estimateTokens('日本語テスト'), 6);
});

test('空文字は0', () => {
	assert.equal(estimateTokens(''), 0);
});

test('混在は合算', () => {
	// 日本語2文字(2) + 英字8文字(2) = 4
	assert.equal(estimateTokens('あいabcdefgh'), 4);
});
