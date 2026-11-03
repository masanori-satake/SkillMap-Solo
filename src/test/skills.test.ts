import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { buildUnit, extractReferences, findSkillDirs, groupSkills, isTentativeMention, rootLabels, scopeRootFor } from '../skills.js';
import { discoverSteering, listWorkspaceRelPaths } from '../contexts.js';
import { DEFAULT_RULE_SETTINGS, evaluateSkill, evaluateSteering } from '../rules.js';

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

test('マルチルート: 別フォルダの同名スキルは統合されず、S2はフォルダ内で判定される', () => {
	const rootA = tmpRoot();
	const rootB = tmpRoot();
	// 両フォルダに同名スキル demo（正本 .agents のみ）を置く
	const skillA = `---\nname: demo\ndescription: A側のデモ。テストを実行するときに使う。\n---\n\n# Demo A\n`;
	const skillB = `---\nname: demo\ndescription: B側のデモ。テストを実行するときに使う。\n---\n\n# Demo B\n`;
	write(rootA, '.agents/skills/demo/SKILL.md', skillA);
	write(rootB, '.agents/skills/demo/SKILL.md', skillB);
	// A には src/only-a.ts がある。B の steering がそれを指しても B 内には無いので S2 が出るべき
	write(rootA, 'src/only-a.ts', 'export {};\n');
	write(rootB, '.kiro/steering/needs-a.md', '---\ninclusion: fileMatch\nfileMatchPattern: "src/**/*.ts"\n---\n\n# NeedsA\n');

	const dirsA = findSkillDirs([rootA], []);
	const dirsB = findSkillDirs([rootB], []);
	const units = [
		...dirsA.map((d) => buildUnit(d, rootA)),
		...dirsB.map((d) => buildUnit(d, rootB)),
	];
	const skills = groupSkills(units, ['.agents']);
	assert.equal(skills.length, 2, '同名でも別フォルダなら統合しない');
	assert.ok(skills.every((s) => s.copies.length === 0), '他フォルダの同名スキルを複製扱いしない');

	const steering = discoverSteering([rootA, rootB], ['.agents']);
	const byRoot = new Map([
		[rootA, listWorkspaceRelPaths([rootA])],
		[rootB, listWorkspaceRelPaths([rootB])],
	]);
	const warnings = evaluateSteering(steering, byRoot, DEFAULT_RULE_SETTINGS);
	const s2 = warnings.filter((w) => w.ruleId === 'S2');
	assert.equal(s2.length, 1, 'B のパターンは B 内に一致が無いので S2（A の同名パスに誤一致しない）');
	assert.ok(s2[0].file.startsWith(rootB));
});

test('scopeRootFor と rootLabels: スコープ決定と同名フォルダの区別', () => {
	const ws = path.join(path.sep, 'ws');
	const extraInWs = path.join(ws, '.github', 'skills');
	// フォルダ内の追加ルート配下でも、スコープはワークスペースフォルダ（正本と分割しない）
	assert.equal(scopeRootFor(path.join(extraInWs, 'demo'), [ws], [extraInWs]), ws);
	// フォルダ外の追加ルートはそのルート自体がスコープ
	const outside = path.join(path.sep, 'shared', 'skills');
	assert.equal(scopeRootFor(path.join(outside, 'demo'), [ws], [outside]), outside);
	// 入れ子のフォルダでは内側を優先
	const inner = path.join(ws, 'sub');
	assert.equal(scopeRootFor(path.join(inner, 'x'), [ws, inner], []), inner);
	// どこにも属さなければ空
	assert.equal(scopeRootFor(path.join(path.sep, 'elsewhere', 'x'), [ws], []), '');

	// 同名フォルダは親パスを足して区別する
	const labels = rootLabels(['/work/client/app', '/work/server/app', '/work/unique']);
	assert.equal(labels.get('/work/client/app'), 'client/app');
	assert.equal(labels.get('/work/server/app'), 'server/app');
	assert.equal(labels.get('/work/unique'), 'unique');
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

test('未解決参照の段階化: リンク/パス付きはR7、ファイル名のみの言及はR13', () => {
	const root = tmpRoot();
	write(
		root,
		'skills/mentions/SKILL.md',
		`---
name: mentions
description: 言及の段階化テスト用。テストを実行するときに使う。
---

# Mentions

[link-path](references/gone.md)
[link-bare](bare-link.md)
\`references/span-path.md\` はまだ無い。
作成予定は \`planned.md\` を参照。
\`planned.md\` は後で作る。
式 \`targets[i].name\` と記法 \`*.md\` はファイルではない。
日本語名 \`要件定義.md\` も候補になる。
`,
	);
	const unit = buildUnit(path.join(root, 'skills/mentions'));
	const skill = groupSkills([unit], ['.agents'])[0];
	const warnings = evaluateSkill(skill, DEFAULT_RULE_SETTINGS);
	const byRule = (id: string) => warnings.filter((w) => w.ruleId === id);
	assert.equal(byRule('R7').length, 3, 'リンク2件＋パス付きコードスパン1件が参照切れ');
	assert.ok(byRule('R7').every((w) => w.severity === 'warn'), 'R7 は warn に緩和');
	assert.equal(byRule('R13').length, 2, 'planned.md と 要件定義.md が要確認の言及');
	assert.ok(byRule('R13').every((w) => w.severity === 'info'), 'R13 は info');

	// 重複言及は1エッジに集約され、出現行が保持される
	const skillInfo = unit.files.get(unit.skillMdPath);
	const planned = skillInfo?.refs.find((e) => e.raw === 'planned.md');
	assert.ok(planned, 'planned.md のエッジがある');
	assert.equal(planned.lines.length, 2, '2行分の言及が集約される');
	assert.equal(planned.via, 'code');
	const linkBare = skillInfo?.refs.find((e) => e.raw === 'bare-link.md');
	assert.equal(linkBare?.via, 'link');
	assert.ok(!skillInfo?.refs.some((e) => e.raw.includes('targets')), '式は候補にしない');
});

test('抽出: 同じ行のリンクとコードスパンはリンクとして格上げされる', () => {
	const root = tmpRoot();
	const from = path.join(root, 'a.md');
	const edges = extractReferences(from, '`shared.md` と [link](shared.md) が同じ行\n\n`shared.md` が別の行\n');
	assert.equal(edges.length, 1, '同一参照先は1エッジ');
	assert.equal(edges[0].via, 'link');
	assert.deepEqual(edges[0].lines, [0, 2]);
});

test('抽出: 日本語のパス付きコードスパンも候補になり、参照切れとして扱う', () => {
	const root = tmpRoot();
	const from = path.join(root, 'a.md');
	const edges = extractReferences(from, '`references/要件定義.md` を参照\n');
	assert.equal(edges.length, 1);
	assert.equal(isTentativeMention(edges[0]), false, 'パス付きは言及ではなく参照');
});

test('抽出: 後から現れたパス付き表記に格上げされ、R13 ではなく R7 になる', () => {
	const root = tmpRoot();
	const from = path.join(root, 'a.md');
	const edges = extractReferences(from, '`planned.md` が先\n\n`./planned.md` が後\n');
	assert.equal(edges.length, 1, '同一参照先は1エッジ');
	assert.equal(edges[0].raw, './planned.md');
	assert.equal(isTentativeMention(edges[0]), false);
});

test('警告: 同じ行の別々の未解決参照は target で区別できる', () => {
	const root = tmpRoot();
	write(
		root,
		'skills/mixed/SKILL.md',
		`---
name: mixed
description: 突合テスト用。テストを実行するときに使う。
---

# Mixed

[a](gone-a.md) と \`planned-b.md\` が同じ行にある。
`,
	);
	const unit = buildUnit(path.join(root, 'skills/mixed'));
	const skill = groupSkills([unit], ['.agents'])[0];
	const warnings = evaluateSkill(skill, DEFAULT_RULE_SETTINGS);
	const r7 = warnings.find((w) => w.ruleId === 'R7');
	const r13 = warnings.find((w) => w.ruleId === 'R13');
	assert.ok(r7 && r13, 'R7 と R13 が1件ずつ出る');
	assert.equal(r7.line, r13.line, '同じ行');
	assert.ok(r7.target?.endsWith('gone-a.md'));
	assert.ok(r13.target?.endsWith('planned-b.md'));
});
