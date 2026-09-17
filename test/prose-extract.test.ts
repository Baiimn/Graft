/**
 * The prose tier: markdown documents indexed as file + section nodes, wired by
 * their outbound links.
 *
 * Two things can go quietly wrong here and both are pinned below.
 *
 * The SPAN, for the same reason `container-extract.test.ts` pins it: graft's
 * promise is that its `file:line` is exact, and a section whose end is off by
 * one sends the reader into the next section with full confidence. Every fixture
 * is written as an array of lines and joined, so the expected line numbers are
 * the array indices + 1 and can be read off the source rather than counted.
 *
 * The LINK REWRITE, because it is invisible: `extractProse` emits a specifier
 * relative to the linking file, and `resolve.ts` turns that into an edge. If the
 * rewrite is wrong the build still succeeds, the graph still loads, and every
 * link edge is silently dangling — so the end-to-end test asserts on a RESOLVED
 * edge between two real node ids, not on the raw specifier.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractProse, proseLangOf, proseExtensions, buildProseIndex } from "../src/graph/prose.js";
import { supportedExtensions } from "../src/graph/source-files.js";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";

const EMPTY = new Map<string, string>();

function repo(): string {
  return mkdtempSync(join(tmpdir(), "graft-prose-"));
}

test("prose tier claims markdown, and source-files agrees", () => {
  assert.equal(proseLangOf("docs/PLAN.md"), "markdown");
  assert.equal(proseLangOf("README.MARKDOWN"), "markdown");
  assert.equal(proseLangOf("src/index.ts"), null);
  // The three enumerations must not drift apart, or `build` and `check` would
  // walk different file sets and `-e .md` would warn about a supported extension.
  for (const ext of proseExtensions()) assert.ok(supportedExtensions().includes(ext), ext);
});

test("headings become section nodes whose spans run to the next peer heading", () => {
  const lines = [
    "---", //            1  frontmatter opens
    "title: Zone law", // 2
    "---", //            3  frontmatter closes
    "# Vault", //        4  L4-L14 (to EOF)
    "preamble", //       5
    "## Zones", //       6  L6-L12 (to the line before `## Tasks` — the closing
    "raw wiki work", //  7     fence on 12 is part of this section, not the next)
    "### raw", //        8  L8-L12 (closed by `## Tasks`, a higher level)
    "sources", //        9
    "```", //           10  a fence — the `#` inside is not a heading
    "# not a heading", //11
    "```", //           12
    "## Tasks", //      13  L13-L14
    "zeno", //          14
  ];
  const { nodes } = extractProse("uni/wiki/zone.md", lines.join("\n"), EMPTY);

  const span = (name: string) => nodes.find((n) => n.name === name)?.span;
  assert.equal(nodes[0].kind, "file");
  assert.equal(nodes[0].span, "L1-L14");
  assert.equal(span("Vault"), "L4-L14");
  assert.equal(span("Zones"), "L6-L12");
  assert.equal(span("raw"), "L8-L12");
  assert.equal(span("Tasks"), "L13-L14");
  // The fenced `# not a heading` must not have become a node.
  assert.equal(nodes.filter((n) => n.kind === "section").length, 4);
  assert.ok(!nodes.some((n) => n.name === "not a heading"));
});

test("contains edges nest by heading level, not by document order", () => {
  const lines = ["# A", "## B", "### C", "## D"];
  const { rawEdges } = extractProse("a.md", lines.join("\n"), EMPTY);
  const contains = rawEdges.filter((e) => e.relation === "contains");
  const pair = (t: string) => contains.find((e) => e.targetId?.endsWith(`#${t}`))?.source;
  assert.equal(pair("a"), "a.md"); // file → top-level heading
  assert.equal(pair("b"), "a.md#a");
  assert.equal(pair("c"), "a.md#b");
  assert.equal(pair("d"), "a.md#a"); // back out to level 2 — NOT under C
});

test("links are rewritten relative to the linking file, and attributed to their section", () => {
  const index = buildProseIndex(["uni/wiki/glossary.md", "dev/wiki/design-system/_index.md"]);
  const lines = [
    "# Page", //                                            1
    "see [the glossary](../wiki/glossary.md) for terms", //  2  already relative
    "## Detail", //                                         3
    "and [[design-system]] for the tokens", //              4  wikilink → dir of an _index
    "plus [[nothing-here]] which does not exist", //        5  unresolvable
    "```", //                                               6
    "[[in-a-fence]] must be ignored", //                    7
    "```", //                                               8
  ];
  const { rawEdges } = extractProse("uni/work/page.md", lines.join("\n"), index);
  const imports = rawEdges.filter((e) => e.relation === "imports");
  const specs = imports.map((e) => e.specifier);

  assert.ok(specs.includes("../wiki/glossary.md"), specs.join(","));
  assert.ok(specs.includes("../../dev/wiki/design-system/_index.md"), specs.join(","));
  // An unknown wikilink keeps a bare target rather than becoming a wrong one.
  assert.ok(specs.includes("nothing-here"));
  // Nothing inside the fence.
  assert.ok(!specs.includes("in-a-fence"));
  // The link on line 4 sits under `## Detail`, not under the file.
  assert.equal(imports.find((e) => e.specifier?.includes("design-system"))?.source, "uni/work/page.md#detail");
});

test("end to end: a built graph resolves a markdown link into a real edge", async () => {
  const root = repo();
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "glossary.md"), "# Glossary\n\nzone law means raw, wiki, work.\n");
  writeFileSync(
    join(root, "docs", "plan.md"),
    "# Plan\n\n## Terms\n\nsee [glossary](glossary.md) and [[glossary]].\n",
  );
  const outDir = join(root, "graft");

  await buildGraph(root, outDir, { reuse: false });
  const graph = readGraph(wiringPath(outDir));

  const files = graph.nodes.filter((n) => n.kind === "file" && n.path.endsWith(".md"));
  assert.equal(files.length, 2, "both markdown files indexed");
  assert.ok(
    graph.nodes.some((n) => n.kind === "section" && n.name === "Terms"),
    "headings became section nodes",
  );
  // The whole point: a RESOLVED edge, both ends a real node id. A dangling
  // target (the bare string "glossary.md") means the rewrite is wrong.
  const byId = new Set(graph.nodes.map((n) => n.id));
  const resolved = graph.edges.filter(
    (e) => e.relation === "imports" && e.source.startsWith("docs/plan.md") && byId.has(e.target),
  );
  assert.ok(resolved.length >= 1, `expected a resolved link edge, got ${JSON.stringify(graph.edges)}`);
  assert.ok(resolved.every((e) => e.target === "docs/glossary.md"));
});
