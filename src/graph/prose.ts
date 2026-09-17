/**
 * Prose tier — markdown documents, indexed the same way code is.
 *
 * Graft's three existing tiers all parse a programming language. A great many
 * repos (and every note vault) carry the part an agent actually needs to read
 * first in markdown: the PRD, the plan files, the architecture notes, the
 * glossary. Those are invisible to a code-only graph, so the agent falls back to
 * grepping for exactly the files a map should have handed it.
 *
 * **Why no tree-sitter here.** `tree-sitter-wasm` does ship a markdown grammar,
 * so a breadth-tier row in generic.ts would cost ~10 lines — but markdown's
 * *block* grammar hands back every paragraph as one opaque `inline` node, and
 * links live in the separate `markdown_inline` grammar. A breadth row would
 * therefore produce headings and NO edges, and edges are the whole reason a
 * graph beats similarity search. One line scanner sees both in a single pass.
 *
 * What it emits:
 *   - a `file` node per document (as every tier does)
 *   - a `section` node per ATX heading, spanning to the next heading of the same
 *     or higher level
 *   - `contains` edges: file → top-level headings, heading → sub-heading
 *   - `imports` edges: one per outbound link, from the innermost enclosing
 *     section (or the file), for both `[text](path.md)` and `[[Wikilink]]`
 *
 * **Why `imports` and not a new relation.** `resolve.ts` already resolves any
 * specifier beginning with `.` against the linking file's directory, so a link
 * rewritten as a path relative to its own file resolves with that file
 * untouched — and `resolve.ts` is the file an upstream rebase is most likely to
 * conflict on. A wikilink whose slug is unknown or ambiguous is left as a bare
 * string, which is exactly what graft does with an unresolvable module: an
 * honest dangling target beats an invented edge.
 */
import { posix } from "node:path";
import { contentHash } from "../util/id.js";
import type { NodeV1 } from "./types.js";
import { mintId, type ExtractResult, type RawEdge } from "./extract.js";

/** Extensions the prose tier claims. Must not collide with any other tier. */
const PROSE_EXTS = [".md", ".markdown", ".mdx"] as const;

export function proseExtensions(): string[] {
  return [...PROSE_EXTS];
}

/** The prose language for a path, or null if this tier does not claim it. */
export function proseLangOf(path: string): "markdown" | null {
  const p = path.toLowerCase();
  return PROSE_EXTS.some((e) => p.endsWith(e)) ? "markdown" : null;
}

/** Mirrors extract.ts's caps so a prose node costs the same as a code node. */
const MAX_BODY_CHARS = 5000;
const MAX_FILE_BODY_CHARS = 16000;

function searchBody(text: string, max = MAX_BODY_CHARS): string {
  const norm = text.replace(/\s+/g, " ").trim();
  return norm.length > max ? norm.slice(0, max) : norm;
}

/**
 * The lookup a wikilink needs: page slug → repo-relative path.
 *
 * A wikilink names a page, not a path, so resolving one needs repo-wide
 * knowledge the extractor does not have. build.ts owns the file list, so it
 * builds this once and hands it in. A slug claimed by two files is DROPPED
 * rather than resolved to whichever came first — an ambiguous target left bare
 * is recoverable, a confidently wrong one is not.
 */
export function buildProseIndex(relPaths: readonly string[]): Map<string, string> {
  const hits = new Map<string, string[]>();
  for (const rel of relPaths) {
    if (!proseLangOf(rel)) continue;
    for (const key of pageKeys(rel)) {
      const list = hits.get(key);
      if (list) list.push(rel);
      else hits.set(key, [rel]);
    }
  }
  const index = new Map<string, string>();
  for (const [key, list] of hits) if (list.length === 1) index.set(key, list[0]);
  return index;
}

/**
 * The keys one document answers to: its basename, and — for an `_index.md` — the
 * directory it indexes. `[[design-system]]` and `[[design-system/_index]]` both
 * mean `dev/wiki/design-system/_index.md`, and a vault links the first way.
 */
function pageKeys(rel: string): string[] {
  const noExt = rel.replace(/\.(md|markdown|mdx)$/i, "");
  const base = posix.basename(noExt);
  const keys = [slug(noExt), slug(base)];
  if (base === "_index") {
    const dir = posix.basename(posix.dirname(noExt));
    if (dir && dir !== ".") keys.push(slug(dir));
  }
  return [...new Set(keys.filter(Boolean))];
}

/** Fold a heading or link target to a comparable key: lower-case, spaces and
 * separators collapsed to `-`. `[[Zone Law]]` and `zone-law.md` must match. */
function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9/\-.]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

/** A fence opener/closer: ``` or ~~~, optionally indented, optionally with an
 * info string. Only a fence of the SAME character closes one, so a ``` block
 * quoting ~~~ does not terminate early. */
const FENCE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
/** ATX heading. Setext (`===` underlines) is deliberately unsupported: it is
 * vanishingly rare in agent-facing markdown and needs a second line of
 * lookahead to tell from a horizontal rule. */
const HEADING = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
/** `[[Page]]`, `[[Page|alias]]`, `[[Page#Heading]]`, `[[Page#Heading|alias]]`. */
const WIKILINK = /\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g;
/** `[text](path.md)` / `[text](path.md#anchor)`. Angle-bracket and titled forms
 * (`[t](<a b.md> "x")`) are not matched — neither appears in generated docs, and
 * a partial match would produce a wrong path rather than no path. */
const MDLINK = /\[[^\]\n]*\]\(\s*([^)\s#]+\.(?:md|markdown|mdx))(?:#[^)\s]*)?\s*\)/gi;

interface Section {
  id: string;
  level: number;
  start: number; // 1-based line
}

/**
 * Extract one markdown document.
 *
 * `index` maps page slug → repo-relative path (see {@link buildProseIndex}).
 * Passing an empty map is legal — every wikilink then stays unresolved, which is
 * what a single-file unit test wants.
 */
export function extractProse(rel: string, source: string, index: Map<string, string>): ExtractResult {
  const lines = source.split("\n");
  const fileNode: NodeV1 = {
    id: rel,
    name: posix.basename(rel),
    kind: "file",
    path: rel,
    span: `L1-L${Math.max(lines.length, 1)}`,
    signature: null,
    exported: true,
    origin: "generic",
    body_hash: contentHash(source),
    chars: source.length,
    summary_state: "pending",
    summary: null,
    crux: null,
  };
  const nodes: NodeV1[] = [fileNode];
  const rawEdges: RawEdge[] = [];
  const minted = new Set<string>([rel]);

  // Open sections, outermost first. The last entry is the innermost, and is what
  // a link on the current line is attributed to.
  const stack: Section[] = [];
  /** Section id → the node, so a span can be closed once its end is known. */
  const byId = new Map<string, NodeV1>();

  const close = (level: number, endLine: number) => {
    while (stack.length && stack[stack.length - 1].level >= level) {
      const s = stack.pop()!;
      const node = byId.get(s.id)!;
      const end = Math.max(s.start, endLine);
      node.span = `L${s.start}-L${end}`;
      node.body_text = searchBody(lines.slice(s.start - 1, end).join(" "));
    }
  };

  let fence: string | null = null;
  let inFrontmatter = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    // YAML frontmatter, only when it opens on line 1. `---` anywhere else is a
    // horizontal rule and must not swallow the document.
    if (lineNo === 1 && /^---\s*$/.test(line)) {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (/^(---|\.\.\.)\s*$/.test(line)) inFrontmatter = false;
      continue;
    }

    const fenceMatch = line.match(FENCE);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    // A `#` inside a code fence is a comment or a shell prompt, never a heading —
    // and a link inside one is documentation of a link, not a link.
    if (fence !== null) continue;

    const heading = line.match(HEADING);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2].trim();
      close(level, lineNo - 1);
      const parent = stack.length ? stack[stack.length - 1].id : rel;
      const id = mintId(`${rel}#${slug(text) || "section"}`, minted);
      const node: NodeV1 = {
        id,
        name: text,
        kind: "section",
        path: rel,
        span: `L${lineNo}-L${lineNo}`, // closed by `close()` once the end is known
        signature: `${heading[1]} ${text}`,
        exported: true,
        origin: "generic",
        body_hash: contentHash(text),
        summary_state: "pending",
        summary: null,
        crux: null,
      };
      nodes.push(node);
      byId.set(id, node);
      rawEdges.push({ source: parent, relation: "contains", file: rel, targetId: id });
      stack.push({ id, level, start: lineNo });
      continue;
    }

    const from = stack.length ? stack[stack.length - 1].id : rel;
    for (const spec of linkTargets(line, rel, index)) {
      rawEdges.push({ source: from, relation: "imports", file: rel, specifier: spec });
    }
  }

  close(1, lines.length);
  fileNode.body_text = searchBody(fileResidual(lines, nodes.slice(1)), MAX_FILE_BODY_CHARS);
  return { nodes, rawEdges };
}

/**
 * Every link target on one line, already rewritten into the form `resolveImport`
 * understands: a path relative to the LINKING file, prefixed with `./`.
 *
 * A markdown link is already relative, so it only needs the `./` prefix that
 * `resolveImport`'s `startsWith(".")` gate demands (`[x](glossary.md)` is the
 * common form and would otherwise be read as a bare module name). A wikilink is
 * resolved through the index and then made relative the same way. An unknown
 * wikilink is returned verbatim so the edge exists with a bare target.
 */
function linkTargets(line: string, rel: string, index: Map<string, string>): string[] {
  const out: string[] = [];
  const dir = posix.dirname(rel);

  MDLINK.lastIndex = 0;
  for (let m = MDLINK.exec(line); m; m = MDLINK.exec(line)) {
    const spec = m[1];
    if (/^[a-z]+:/i.test(spec) || spec.startsWith("/")) continue; // external / absolute
    out.push(spec.startsWith(".") ? spec : `./${spec}`);
  }

  WIKILINK.lastIndex = 0;
  for (let m = WIKILINK.exec(line); m; m = WIKILINK.exec(line)) {
    const raw = m[1].trim();
    if (!raw) continue;
    const target = index.get(slug(raw));
    if (!target) {
      out.push(raw); // unresolvable — a bare target, never a guessed one
      continue;
    }
    if (target === rel) continue; // a page linking itself is not an edge
    const relative = posix.relative(dir === "." ? "" : dir, target);
    out.push(relative.startsWith(".") ? relative : `./${relative}`);
  }
  return [...new Set(out)];
}

/** The document's residual: every line no section covers — the title block and
 * any preamble above the first heading. Section bodies are indexed on their own
 * nodes, so storing them again on the file node would only double the graph. */
function fileResidual(lines: string[], sections: NodeV1[]): string {
  const covered = new Uint8Array(lines.length + 2);
  for (const s of sections) {
    const m = s.span.match(/^L(\d+)-L(\d+)$/);
    if (!m) continue;
    for (let r = Number(m[1]); r <= Number(m[2]) && r < covered.length; r++) covered[r] = 1;
  }
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) if (!covered[i + 1]) kept.push(lines[i]);
  return kept.join(" ");
}
