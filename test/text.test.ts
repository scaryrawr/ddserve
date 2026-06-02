import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { extractHtmlSection, extractMarkdownPages, normalizeLinkHref, renderMarkdown } from "../src/text";

describe("renderMarkdown", () => {
  test("strips script and style tags while keeping body text", () => {
    const text = renderMarkdown("Intro", "intro", "<style>.x{}</style><h1>Intro</h1><p>Hello <strong>world</strong>.</p><script>x()</script>");
    expect(text).toContain("# Intro");
    expect(text).toContain("Hello **world**.");
    expect(text).not.toContain(".x{}");
    expect(text).not.toContain("x()");
  });

  test("normalizes relative and cppreference links", () => {
    const text = renderMarkdown(
      "std::copy",
      "algorithm/copy",
      '<p><a href="../header/algorithm">&lt;algorithm&gt;</a> <a href="copy_backward">copy_backward</a> <a href="http://en.cppreference.com/w/cpp/types/decay">decay</a></p>',
    );

    expect(text).toContain("[<algorithm>](header/algorithm");
    expect(text).toContain("[copy\\_backward](algorithm/copy_backward");
    expect(text).toContain("[decay](types/decay");
  });

  test("separates cppreference t-lines entries", () => {
    const text = renderMarkdown(
      "Algorithms library",
      "algorithm",
      '<span class="t-lines"><span>all_of</span><span>any_of</span><span>none_of</span></span>',
    );

    expect(text).toContain("all_of\nany_of\nnone_of");
  });

  test("preserves code blocks as fenced markdown", () => {
    const text = renderMarkdown("Example", "example", '<pre data-language="ts">const answer = 42;\nconsole.log(answer);</pre>');

    expect(text).toContain("```ts");
    expect(text).toContain("const answer = 42;");
    expect(text).toContain("console.log(answer);");
  });

  test("uses a longer fence when code contains triple backticks", () => {
    const text = renderMarkdown("Fence", "fence", "<pre>console.log(```);</pre>");

    expect(text).toContain("````\nconsole.log(```);\n````");
  });

  test("removes unpaired surrogates while preserving valid emoji", () => {
    const text = renderMarkdown("Rust \uDD2C", "rust", "<p>Nightly marker 🔬 stays, but this does not: \uD83D</p>");

    expect(text).toContain("Nightly marker 🔬 stays");
    expect(hasUnpairedSurrogate(text)).toBe(false);
  });

  test("renders only the matching heading section for hash paths", () => {
    const text = renderMarkdown(
      "Compile-Time Parameters",
      "index#Compile-Time-Parameters",
      [
        "<h2 id=\"comptime\">comptime</h2>",
        "<p>Compile-time overview.</p>",
        "<h3 id=\"Compile-Time-Parameters\">Compile-Time Parameters</h3>",
        "<p>Generic functions use comptime parameters.</p>",
        "<h3 id=\"Generic-Data-Structures\">Generic Data Structures</h3>",
        "<p>Generic List example.</p>",
      ].join(""),
    );

    expect(text).toContain("Generic functions use comptime parameters.");
    expect(text).not.toContain("Compile-time overview.");
    expect(text).not.toContain("Generic List example.");
  });
});

describe("extractHtmlSection", () => {
  test("keeps nested subsections and stops at the next same-level heading", () => {
    const html = [
      "<h2 id=\"comptime\">comptime</h2>",
      "<p>Compile-time overview.</p>",
      "<h3 id=\"Compile-Time-Parameters\">Compile-Time Parameters</h3>",
      "<p>Parameters.</p>",
      "<h4 id=\"Nested\">Nested</h4>",
      "<p>Nested details.</p>",
      "<h3 id=\"Generic-Data-Structures\">Generic Data Structures</h3>",
      "<p>Generic list.</p>",
    ].join("");

    expect(extractHtmlSection(html, "index#comptime")).toContain("Generic Data Structures");
    expect(extractHtmlSection(html, "index#Compile-Time-Parameters")).toContain("Nested details");
    expect(extractHtmlSection(html, "index#Compile-Time-Parameters")).not.toContain("Generic list");
  });

  test("extracts Rust-style section anchors with docblocks", () => {
    const html = [
      '<summary><section id="method.wrapping_add" class="method">',
      '<pre class="code-header" data-language="rust">pub const fn wrapping_add(self, rhs: i128) -&gt; i128</pre>',
      "</section></summary>",
      '<div class="docblock">',
      "<p>Wrapping (modular) addition.</p>",
      '<h5 id="examples-66">Examples</h5>',
      "<p>Example details should stay with this method.</p>",
      "</div>",
      '<summary><section id="method.wrapping_sub" class="method">',
      '<pre class="code-header" data-language="rust">pub const fn wrapping_sub(self, rhs: i128) -&gt; i128</pre>',
      "</section></summary>",
      '<div class="docblock"><p>Subtraction docs.</p></div>',
    ].join("");

    const section = extractHtmlSection(html, "std/primitive.i128#method.wrapping_add");

    expect(section).toContain("wrapping_add");
    expect(section).toContain("Wrapping (modular) addition.");
    expect(section).toContain("Example details should stay with this method.");
    expect(section).not.toContain("wrapping_sub");
    expect(section).not.toContain("Subtraction docs.");
  });
});

describe("normalizeLinkHref", () => {
  test("normalizes references relative to the current doc path", () => {
    expect(normalizeLinkHref("../header/algorithm", "algorithm/copy")).toBe("header/algorithm");
    expect(normalizeLinkHref("copy_backward", "algorithm/copy")).toBe("algorithm/copy_backward");
    expect(normalizeLinkHref("ranges/copy_backward", "algorithm/copy")).toBe("algorithm/ranges/copy_backward");
    expect(normalizeLinkHref("algorithm/ranges#Return_types", "algorithm")).toBe("algorithm/ranges#Return_types");
    expect(normalizeLinkHref("#Notes", "algorithm/copy")).toBe("algorithm/copy#Notes");
  });

  test("maps cppreference absolute URLs to local DevDocs paths", () => {
    expect(normalizeLinkHref("https://en.cppreference.com/w/cpp/types/remove_cvref", "algorithm/copy")).toBe("types/remove_cvref");
  });
});

describe("extractMarkdownPages", () => {
  test("uses the base path before hash fragments to read db entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ddserve-text-test-"));
    const result = await extractMarkdownPages(
      { entries: [{ name: "Section", path: "guide#section", type: "Guide" }] },
      { guide: "<h1>Guide</h1><p>Details</p>" },
      dir,
    );

    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]!.file.endsWith(".md")).toBe(true);
    expect(result.pages[0]!.format).toBe("markdown");
    expect(result.skippedEntries).toBe(0);
    expect(await readFile(join(dir, result.pages[0]!.file.replace("pages/", "")), "utf8")).toContain("Details");
  });
});

function hasUnpairedSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      return true;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}
