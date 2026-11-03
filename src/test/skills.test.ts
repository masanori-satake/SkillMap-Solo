import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { buildUnit, findSkillDirs, groupSkills } from '../skills.js';
import { DEFAULT_RULE_SETTINGS, evaluateSkill } from '../rules.js';

function tmpRoot(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'skillmap-test-'));
}

function write(root: string, rel: string, content: string): void {
	const full = path.join(root, rel);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content, 'utf8');
}

const GOOD_SKILL = `---
name: demo
description: デモ用スキル。テストを実行するときに使う。
---

# Demo

詳細は [guide](references/guide.md) を参照。
`;

test('発見・グルーピング・境界・孤立が機能する', () => {
	const root = tmpRoot();
	write(root, '.agents/skills/demo/SKILL.md', GOOD_SKILL);
	write(root, '.agents/skills/demo/references/guide.md', '# Guide\n\n方針は [base](../../../../.kiro/steering/base.md) に従う。\n');
	write(root, '.agents/skills/demo/references/unused.md', '# 未使用\n');
	write(root, '.kiro/steering/base.md', '---\ninclusion: always\n---\n\n# Base\n\n常時適用の方針。\n');
	// 複製（同一内容）
	write(root, '.github/skills/demo/SKILL.md', GOOD_SKILL);
	write(root, '.github/skills/demo/references/guide.md', '# Guide\n\n方針は [base](../../../../.kiro/steering/base.md) に従う。\n');
	write(root, '.github/skills/demo/references/unused.md', '# 未使用\n');

	const dirs = findSkillDirs([root], []);
	assert.equal(dirs.length, 2);

	const units = dirs.map((d) => buildUnit(d));
	const skills = groupSkills(units, ['.agents']);
	assert.equal(skills.length, 1);
	const skill = skills[0];
	assert.equal(skill.canonicalExplicit, true);
	assert.ok(skill.canonical.dir.includes('.agents'));
	assert.equal(skill.copies.length, 1);

	const unit = skill.canonical;
	// 境界（steering）に到達している
	const boundaryPaths = [...unit.reachableBoundary];
	assert.ok(boundaryPaths.some((p) => p.includes('.kiro')));
	// inclusion: always の steering が常時ロード分として数えられる
	assert.ok(unit.steeringAlwaysTokens > 0);
	// 孤立ファイル
	assert.equal(unit.orphans.length, 1);
	assert.ok(unit.orphans[0].endsWith('unused.md'));

	// 正常系では error が出ない / ドリフトなし
	const warnings = evaluateSkill(skill, DEFAULT_RULE_SETTINGS);
	assert.ok(!warnings.some((w) => w.severity === 'error'), JSON.stringify(warnings));
	assert.ok(!warnings.some((w) => w.ruleId === 'R11'));
	// 孤立は info で出る
	assert.ok(warnings.some((w) => w.ruleId === 'R9'));
});

test('複製ドリフトを検出する', () => {
	const root = tmpRoot();
	write(root, '.agents/skills/demo/SKILL.md', GOOD_SKILL);
	write(root, '.agents/skills/demo/references/guide.md', '# Guide\n');
	write(root, '.github/skills/demo/SKILL.md', GOOD_SKILL);
	write(root, '.github/skills/demo/references/guide.md', '# Guide 改変済み\n');

	const units = findSkillDirs([root], []).map((d) => buildUnit(d));
	const skill = groupSkills(units, ['.agents'])[0];
	const warnings = evaluateSkill(skill, DEFAULT_RULE_SETTINGS);
	const drift = warnings.find((w) => w.ruleId === 'R11');
	assert.ok(drift, 'R11 が出るはず');
	assert.match(drift.message, /不一致 1件/);
});

test('違反系: name不一致・参照切れ・循環・深さを検出する', () => {
	const root = tmpRoot();
	const body = Array.from({ length: 30 }, (_, i) => `行${i}`).join('\n');
	write(root, 'skills/bad/SKILL.md', `---
name: Bad_Name
description: ${'あ'.repeat(1100)}
---

${body}

[missing](references/missing.md)
[x](references/x.md)
`);
	write(root, 'skills/bad/references/x.md', '# X\n\n[y](y.md)\n');
	write(root, 'skills/bad/references/y.md', '# Y\n\n[x](x.md)\n[deep1](deep/deep1.md)\n');
	write(root, 'skills/bad/references/deep/deep1.md', '# D1\n\n[deep2](deep2.md)\n');
	write(root, 'skills/bad/references/deep/deep2.md', '# D2\n');

	const unit = buildUnit(path.join(root, 'skills/bad'));
	const skill = groupSkills([unit], ['.agents'])[0];
	const warnings = evaluateSkill(skill, DEFAULT_RULE_SETTINGS);
	const byRule = (id: string) => warnings.filter((w) => w.ruleId === id);
	assert.ok(byRule('R1').length >= 2, 'name 形式とディレクトリ不一致');
	assert.ok(byRule('R2').length === 1, 'description 長すぎ');
	assert.ok(byRule('R7').length === 1, '参照切れ');
	assert.ok(byRule('R8').length >= 1, '循環参照');
	assert.ok(byRule('R6').length >= 1, '深さ超過（deep2 は深さ3）');
});

test('frontmatter の文字種・サイズ: ハイフン位置と compatibility 上限を検出する', () => {
	const root = tmpRoot();
	write(
		root,
		'.agents/skills/bad-hyphen-/SKILL.md',
		`---\nname: bad-hyphen-\ndescription: テスト用。検証するときに使う。\ncompatibility: ${'x'.repeat(501)}\n---\n\n# Bad\n`,
	);
	write(
		root,
		'.agents/skills/double--hyphen/SKILL.md',
		`---\nname: double--hyphen\ndescription: テスト用。検証するときに使う。\n---\n\n# Bad2\n`,
	);
	const dirs = findSkillDirs([root], []);
	const units = dirs.map((d) => buildUnit(d));
	const skills = groupSkills(units, ['.agents']);
	const all: string[] = [];
	const messages: string[] = [];
	for (const skill of skills) {
		for (const w of evaluateSkill(skill, DEFAULT_RULE_SETTINGS)) {
			all.push(w.ruleId);
			messages.push(w.message);
		}
	}
	const hyphenEdge = messages.filter((m) => m.includes('先頭・末尾'));
	const hyphenDouble = messages.filter((m) => m.includes('連続するハイフン'));
	assert.equal(hyphenEdge.length, 1, '末尾ハイフンを検出');
	assert.equal(hyphenDouble.length, 1, '連続ハイフンを検出');
	assert.ok(all.includes('R12'), 'compatibility 501文字で R12');
});

test('description に利用シーンが無いと R3 が出る', () => {
	const root = tmpRoot();
	write(root, 'skills/plain/SKILL.md', `---
name: plain
description: ファイルを変換するツール。
---

# Plain
`);
	const unit = buildUnit(path.join(root, 'skills/plain'));
	const skill = groupSkills([unit], ['.agents'])[0];
	const warnings = evaluateSkill(skill, DEFAULT_RULE_SETTINGS);
	assert.ok(warnings.some((w) => w.ruleId === 'R3'));
	assert.ok(!warnings.some((w) => w.severity === 'error'));
});
