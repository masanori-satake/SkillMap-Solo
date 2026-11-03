// ツリー表示をプレーンテキスト化する（クリップボードコピー用、依存ゼロの純粋モジュール）
// 罫線のスタイルは StructMap-Solo の TreeRenderer に揃え、シリーズで見た目を統一する。
// チャット（Teams 等）やドキュメントに貼って構造を共有するための機能。

export interface CopyTreeNode {
	label: string;
	description?: string;
	/** 表示中コピーで子を含めるか（全体コピーでは参照されない） */
	expanded: boolean;
	children: CopyTreeNode[];
}

export type CopyTreeStyle = 'unicode' | 'ascii';

const GLYPHS = {
	unicode: { branch: '├─ ', last: '└─ ', vert: '│  ', blank: '   ' },
	ascii: { branch: '+- ', last: '+- ', vert: '|  ', blank: '   ' },
} as const;

function lineText(node: CopyTreeNode): string {
	return node.description ? `${node.label}  ${node.description}` : node.label;
}

function renderChildren(
	nodes: CopyTreeNode[],
	prefix: string,
	style: CopyTreeStyle,
	visibleOnly: boolean,
	lines: string[],
): void {
	const g = GLYPHS[style];
	nodes.forEach((node, i) => {
		const isLast = i === nodes.length - 1;
		lines.push(prefix + (isLast ? g.last : g.branch) + lineText(node));
		if (node.children.length > 0 && (!visibleOnly || node.expanded)) {
			renderChildren(node.children, prefix + (isLast ? g.blank : g.vert), style, visibleOnly, lines);
		}
	});
}

/** ルート（セクション）は罫線なしで出し、その下を罫線でぶら下げる */
export function renderCopyTree(roots: CopyTreeNode[], style: CopyTreeStyle, visibleOnly: boolean): string {
	const lines: string[] = [];
	for (const root of roots) {
		lines.push(lineText(root));
		if (root.children.length > 0 && (!visibleOnly || root.expanded)) {
			renderChildren(root.children, '', style, visibleOnly, lines);
		}
	}
	return lines.join('\n');
}
