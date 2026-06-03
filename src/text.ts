import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join, posix } from "node:path";

import TurndownService from "turndown";

import { EXTRACTED_CONTENT_FORMAT, type DevDocsIndex, type PageManifestEntry } from "./types";
import { removeUnpairedSurrogates } from "./unicode";

export interface ExtractPagesResult {
  pages: PageManifestEntry[];
  skippedEntries: number;
}

export async function extractMarkdownPages(index: DevDocsIndex, db: Record<string, string>, pagesDir: string): Promise<ExtractPagesResult> {
  const pages: PageManifestEntry[] = [];
  let skippedEntries = 0;

  for (const entry of index.entries) {
    const sourceKey = sourceKeyForPath(entry.path);
    const html = db[sourceKey] ?? db[entry.path];
    if (!html) {
      skippedEntries += 1;
      continue;
    }

    const id = pageId(entry.path, entry.name);
    const file = `${id}.md`;
    const text = renderMarkdown(entry.name, entry.path, html);

    await writeFile(join(pagesDir, file), text, "utf8");
    pages.push({
      id,
      name: entry.name,
      path: entry.path,
      type: entry.type,
      file: `pages/${file}`,
      format: EXTRACTED_CONTENT_FORMAT,
      sourceKey,
    });
  }

  return { pages, skippedEntries };
}

export function renderMarkdown(title: string, path: string, html: string): string {
  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    fence: "```",
    bulletListMarker: "-",
  });

  turndown.remove(["script", "style", "nav", "img"]);
  turndown.addRule("normalizedLinks", {
    filter: "a",
    replacement(content, node) {
      const href = node.getAttribute("href");
      if (!href) {
        return content;
      }

      const normalizedHref = normalizeLinkHref(href, path);
      const title = node.getAttribute("title");
      const titlePart = title ? ` "${title.replace(/"/g, '\\"')}"` : "";
      const lines = content
        .split(/\n+/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      if (lines.length > 1) {
        return lines.map((line) => `[${line}](${normalizedHref}${titlePart})`).join("\n");
      }

      const label = lines[0] ?? content.trim();
      return label ? `[${label}](${normalizedHref}${titlePart})` : "";
    },
  });
  turndown.addRule("devdocsPreCodeBlocks", {
    filter: "pre",
    replacement(_content, node) {
      const code = (node.textContent ?? "").replace(/\n+$/g, "");
      if (!code.trim()) {
        return "";
      }

      const fence = code.includes("```") ? "````" : "```";
      const language = node.getAttribute("data-language") ?? inferLanguageFromClassName(String(node.parentElement?.className ?? ""));
      return `\n\n${fence}${language ?? ""}\n${code}\n${fence}\n\n`;
    },
  });
  turndown.addRule("cppReferenceLines", {
    filter(node) {
      return node.nodeName === "SPAN" && node.classList.contains("t-lines");
    },
    replacement(_content, node) {
      const lines = Array.from(node.children as ArrayLike<{ textContent?: string | null }>)
        .map((child) => child.textContent?.trim() ?? "")
        .filter((line) => line.length > 0);

      return lines.length > 0 ? lines.join("\n") : node.textContent?.trim() ?? "";
    },
  });
  turndown.addRule("tables", {
    filter: "table",
    replacement(_content, node) {
      return renderMarkdownTable(turndown, node);
    },
  });

  const sectionHtml = extractHtmlSection(html, path);
  const body = cleanMarkdownBody(removeUnpairedSurrogates(turndown.turndown(sectionHtml)), title).trim();

  return removeUnpairedSurrogates([`# ${title}`, ``, `> DevDocs path: ${path}`, ``, body, ``].join("\n"));
}

interface MarkdownTableRow {
  cells: string[];
  isHeader: boolean;
  firstCellIsHeader: boolean;
}

interface ElementLike {
  nodeName: string;
  textContent?: string | null;
  innerHTML?: string;
  parentElement?: ElementLike | null;
  children: ArrayLike<ElementLike>;
  querySelectorAll?(selectors: string): ArrayLike<ElementLike>;
}

function renderMarkdownTable(turndown: TurndownService, table: ElementLike): string {
  const rows = Array.from(table.querySelectorAll?.("tr") ?? [])
    .map((row) => markdownTableRow(turndown, row))
    .filter((row): row is MarkdownTableRow => row !== undefined);
  if (rows.length === 0) {
    return "";
  }

  const columnCount = Math.max(...rows.map((row) => row.cells.length));
  if (columnCount === 0) {
    return "";
  }

  const firstRow = rows[0];
  if (!firstRow) {
    return "";
  }

  const hasHeaderRow = firstRow.isHeader;
  const header = hasHeaderRow
    ? padTableCells(firstRow.cells, columnCount)
    : inferredTableHeader(rows, columnCount);
  const bodyRows = hasHeaderRow ? rows.slice(1) : rows;
  const lines = [
    markdownTableLine(header),
    markdownTableLine(Array.from({ length: columnCount }, () => "---")),
    ...bodyRows.map((row) => markdownTableLine(padTableCells(row.cells, columnCount))),
  ];

  return `\n\n${lines.join("\n")}\n\n`;
}

function markdownTableRow(
  turndown: TurndownService,
  row: ElementLike,
): MarkdownTableRow | undefined {
  const cells = Array.from(row.children).filter((cell) =>
    cell.nodeName === "TH" || cell.nodeName === "TD",
  );
  if (cells.length === 0) {
    return undefined;
  }

  return {
    cells: cells.map((cell) => markdownTableCell(turndown, cell)),
    isHeader: isInsideTag(row, "THEAD") || cells.every((cell) => cell.nodeName === "TH"),
    firstCellIsHeader: cells[0]?.nodeName === "TH",
  };
}

function markdownTableCell(turndown: TurndownService, cell: ElementLike): string {
  const markdown = turndown.turndown(cell.innerHTML ?? cell.textContent ?? "")
    .replace(/\r\n?/g, "\n")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("<br>");
  const text = markdown || cell.textContent?.trim() || "";
  return text.replace(/\|/g, "\\|");
}

function isInsideTag(element: ElementLike, tagName: string): boolean {
  let current: ElementLike | null | undefined = element;
  while (current) {
    if (current.nodeName === tagName) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

function inferredTableHeader(rows: MarkdownTableRow[], columnCount: number): string[] {
  if (columnCount === 2 && rows.every((row) => row.firstCellIsHeader)) {
    return ["Property", "Value"];
  }

  return Array.from({ length: columnCount }, (_, index) => `Column ${index + 1}`);
}

function padTableCells(cells: string[], columnCount: number): string[] {
  return Array.from({ length: columnCount }, (_, index) => cells[index] ?? "");
}

function markdownTableLine(cells: string[]): string {
  return `| ${cells.join(" | ")} |`;
}

function cleanMarkdownBody(markdown: string, title: string): string {
  return removeDuplicateLeadingHeading(markdown, title);
}

function removeDuplicateLeadingHeading(markdown: string, title: string): string {
  const match = markdown.match(/^\s{0,3}#{1,6}[ \t]+(.+?)\s*(?:\n+|$)/);
  if (!match || normalizedHeadingText(match[1] ?? "") !== normalizedHeadingText(title)) {
    return markdown;
  }

  return markdown.slice(match[0].length);
}

function normalizedHeadingText(value: string): string {
  return value
    .replace(/[`*_~\[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function extractHtmlSection(html: string, path: string): string {
  const anchor = anchorForPath(path);
  if (!anchor) {
    return html;
  }

  const heading = findHeadingById(html, anchor);
  if (heading) {
    const nextHeading = findNextHeadingAtOrAboveLevel(html, heading.end, heading.level);
    return html.slice(heading.start, nextHeading?.start ?? html.length);
  }

  const element = findElementById(html, anchor);
  if (element) {
    const start = findEnclosingOpenTagStart(html, "summary", element.start) ?? element.start;
    const end = findElementSectionEnd(html, element);
    return html.slice(start, end);
  }

  return html;
}

function inferLanguageFromClassName(className: string): string | undefined {
  const match = className.match(/\bsource-([a-z0-9_+-]+)\b/i);
  return match?.[1];
}

function sourceKeyForPath(path: string): string {
  return path.split("#", 1)[0] || "index";
}

function anchorForPath(path: string): string | undefined {
  const hashIndex = path.indexOf("#");
  if (hashIndex === -1 || hashIndex === path.length - 1) {
    return undefined;
  }

  try {
    return decodeURIComponent(path.slice(hashIndex + 1));
  } catch {
    return path.slice(hashIndex + 1);
  }
}

function findHeadingById(html: string, anchor: string): { start: number; end: number; level: number } | undefined {
  const headingPattern = /<h([1-6])\b[^>]*\bid=(["'])(.*?)\2[^>]*>/gis;
  for (const match of html.matchAll(headingPattern)) {
    if (decodeHtmlAttribute(match[3] ?? "") !== anchor) {
      continue;
    }
    return {
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      level: Number(match[1]),
    };
  }
  return undefined;
}

function findElementById(html: string, anchor: string): { start: number; end: number; tagName: string } | undefined {
  const elementPattern = /<([a-z][a-z0-9:-]*)\b[^>]*\bid=(["'])(.*?)\2[^>]*>/gis;
  for (const match of html.matchAll(elementPattern)) {
    if (decodeHtmlAttribute(match[3] ?? "") !== anchor) {
      continue;
    }
    return {
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      tagName: (match[1] ?? "").toLowerCase(),
    };
  }
  return undefined;
}

function findElementSectionEnd(
  html: string,
  element: { start: number; end: number; tagName: string },
): number {
  if (element.tagName === "section") {
    const sectionCloseEnd = findClosingTagEnd(html, "section", element.end) ?? element.end;
    const nextSectionStart = findOpeningTagStart(html, "section", sectionCloseEnd);
    if (nextSectionStart !== undefined) {
      return findEnclosingOpenTagStart(html, "summary", nextSectionStart) ?? nextSectionStart;
    }
    return html.length;
  }

  return findClosingTagEnd(html, element.tagName, element.end) ?? html.length;
}

function findOpeningTagStart(html: string, tagName: string, start: number): number | undefined {
  const pattern = new RegExp(`<${tagName}\\b`, "gi");
  pattern.lastIndex = start;
  const match = pattern.exec(html);
  return match?.index;
}

function findClosingTagEnd(html: string, tagName: string, start: number): number | undefined {
  const pattern = new RegExp(`</${tagName}>`, "gi");
  pattern.lastIndex = start;
  const match = pattern.exec(html);
  return match ? match.index + match[0].length : undefined;
}

function findEnclosingOpenTagStart(html: string, tagName: string, before: number): number | undefined {
  const lowerHtml = html.toLowerCase();
  const openStart = lowerHtml.lastIndexOf(`<${tagName}`, before);
  if (openStart === -1) {
    return undefined;
  }
  const closeStart = lowerHtml.lastIndexOf(`</${tagName}>`, before);
  return openStart > closeStart ? openStart : undefined;
}

function findNextHeadingAtOrAboveLevel(
  html: string,
  start: number,
  level: number,
): { start: number; level: number } | undefined {
  const headingPattern = /<h([1-6])\b[^>]*>/gis;
  headingPattern.lastIndex = start;
  let match: RegExpExecArray | null;
  while ((match = headingPattern.exec(html))) {
    const nextLevel = Number(match[1]);
    if (nextLevel <= level) {
      return { start: match.index, level: nextLevel };
    }
  }
  return undefined;
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export function normalizeLinkHref(href: string, currentPath: string): string {
  if (!href || /^(?:data|javascript|mailto):/i.test(href) || href.startsWith("//")) {
    return href;
  }

  const externalCppReferencePath = normalizeCppReferenceUrl(href);
  if (externalCppReferencePath) {
    return externalCppReferencePath;
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    return href;
  }

  const { path, suffix } = splitHref(href);
  if (!path) {
    return `${sourceKeyForPath(currentPath)}${suffix}`;
  }

  const normalizedPath = normalizeDevDocsPath(path, currentPath);
  return `${normalizedPath}${suffix}`;
}

function normalizeCppReferenceUrl(href: string): string | undefined {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return undefined;
  }

  if (!url.hostname.endsWith("cppreference.com")) {
    return undefined;
  }

  const match = url.pathname.match(/^\/w\/cpp\/?(.+)?$/);
  if (!match) {
    return undefined;
  }

  return `${match[1] ?? "index"}${url.hash}`;
}

function splitHref(href: string): { path: string; suffix: string } {
  const suffixStart = href.search(/[?#]/);
  if (suffixStart === -1) {
    return { path: href, suffix: "" };
  }

  return {
    path: href.slice(0, suffixStart),
    suffix: href.slice(suffixStart),
  };
}

function normalizeDevDocsPath(path: string, currentPath: string): string {
  const trimmedPath = path.replace(/^\/+/, "").replace(/^cpp\//, "");
  if (path.startsWith("/") || trimmedPath.startsWith("../") || trimmedPath.startsWith("./")) {
    return posix.normalize(posix.join(posix.dirname(sourceKeyForPath(currentPath)), trimmedPath));
  }

  const firstSegment = trimmedPath.split("/", 1)[0] ?? "";
  if (trimmedPath.includes("/") && isKnownCppReferenceRoot(firstSegment)) {
    return posix.normalize(trimmedPath);
  }

  return posix.normalize(posix.join(posix.dirname(sourceKeyForPath(currentPath)), trimmedPath));
}

function isKnownCppReferenceRoot(segment: string): boolean {
  return CPP_REFERENCE_ROOTS.has(segment);
}

const CPP_REFERENCE_ROOTS = new Set([
  "algorithm",
  "atomic",
  "chrono",
  "concept",
  "container",
  "coroutine",
  "error",
  "experimental",
  "filesystem",
  "header",
  "io",
  "iterator",
  "keyword",
  "language",
  "locale",
  "memory",
  "meta",
  "named_req",
  "numeric",
  "preprocessor",
  "regex",
  "string",
  "symbol_index",
  "thread",
  "types",
  "utility",
]);

function pageId(path: string, name: string): string {
  const label = `${name}-${path}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const hash = createHash("sha1").update(path).digest("hex").slice(0, 10);
  return `${label || "page"}-${hash}`;
}
