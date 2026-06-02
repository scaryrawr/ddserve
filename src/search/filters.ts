import { cachePaths, readCacheManifest, readJsonFile } from "../cache";
import { normalizeDocsets } from "../devdocs";
import { DdserveError } from "../errors";
import type { CacheManifestDocset, DevDocsRawDocset, DocsetSummary } from "../types";

export type SearchFilterOptionValues = string | readonly string[] | undefined;

export interface ResolveSearchFiltersOptions {
  cacheRoot: string;
  slug?: SearchFilterOptionValues;
  language?: SearchFilterOptionValues;
}

interface InstalledDocsetFilterEntry {
  slug: string;
  name: string;
  type: string;
  sourceName?: string;
  sourceType?: string;
  aliases: string[];
}

interface CachedDevDocsSourceIndex {
  docsets?: DevDocsRawDocset[];
}

export async function resolveSearchFilterSlugs(options: ResolveSearchFiltersOptions): Promise<string[] | undefined> {
  const slugFilters = parseSearchFilterValues(options.slug, "--slug");
  const languageFilters = parseSearchFilterValues(options.language, "--language");

  if (slugFilters.length === 0 && languageFilters.length === 0) {
    return undefined;
  }

  const manifest = await readCacheManifest(options.cacheRoot);
  const sourceMetadata = await readCachedSourceMetadata(options.cacheRoot);
  const installed = Object.values(manifest.docs);
  const entries = installed.map((docset) => toFilterEntry(docset, sourceMetadata.bySlug.get(docset.slug)));
  const installedSlugSet = new Set(entries.map((entry) => entry.slug));
  const resolved: string[] = [];
  const seen = new Set<string>();

  for (const slug of slugFilters) {
    if (!installedSlugSet.has(slug)) {
      throw unknownSlugFilterError(slug, entries);
    }
    pushUnique(resolved, seen, slug);
  }

  for (const language of languageFilters) {
    pushUnique(resolved, seen, resolveLanguageFilter(language, entries, sourceMetadata.available));
  }

  return resolved.length > 0 ? resolved : undefined;
}

export function parseSearchFilterValues(values: SearchFilterOptionValues, label = "filter"): string[] {
  const rawValues: readonly string[] = values === undefined ? [] : typeof values === "string" ? [values] : values;
  const parsed = rawValues.flatMap((value) =>
    value
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  );

  if (rawValues.length > 0 && parsed.length === 0) {
    throw new DdserveError(`No ${label} values were provided`);
  }

  return parsed;
}

async function readCachedSourceMetadata(cacheRoot: string): Promise<{
  available: boolean;
  bySlug: Map<string, DocsetSummary>;
}> {
  const cached = await readJsonFile<CachedDevDocsSourceIndex>(cachePaths(cacheRoot).devdocsSourceIndex);
  if (!Array.isArray(cached?.docsets)) {
    return { available: false, bySlug: new Map() };
  }

  return {
    available: true,
    bySlug: new Map(normalizeDocsets(cached.docsets).map((docset) => [docset.slug, docset])),
  };
}

function toFilterEntry(docset: CacheManifestDocset, sourceMetadata: DocsetSummary | undefined): InstalledDocsetFilterEntry {
  return {
    slug: docset.slug,
    name: docset.name,
    type: docset.type,
    sourceName: sourceMetadata?.name,
    sourceType: sourceMetadata?.type,
    aliases: sourceMetadata?.aliases ?? [],
  };
}

function resolveLanguageFilter(value: string, entries: InstalledDocsetFilterEntry[], hasSourceMetadata: boolean): string {
  const exactSlugMatch = entries.find((entry) => entry.slug === value);
  if (exactSlugMatch) {
    return exactSlugMatch.slug;
  }

  const normalizedValue = normalizeMatchKey(value);
  const slugMatches = entries.filter((entry) => normalizeMatchKey(entry.slug) === normalizedValue);
  if (slugMatches.length === 1) {
    return slugMatches[0]!.slug;
  }
  if (slugMatches.length > 1) {
    throw ambiguousLanguageFilterError(value, slugMatches);
  }

  const metadataMatches = entries.filter((entry) =>
    matchFields(entry).some((field) => normalizeMatchKey(field) === normalizedValue),
  );
  if (metadataMatches.length === 1) {
    return metadataMatches[0]!.slug;
  }
  if (metadataMatches.length > 1) {
    throw ambiguousLanguageFilterError(value, metadataMatches);
  }

  throw unknownLanguageFilterError(value, entries, hasSourceMetadata);
}

function matchFields(entry: InstalledDocsetFilterEntry): string[] {
  return [entry.name, entry.type, entry.sourceName, entry.sourceType, ...entry.aliases].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

function normalizeMatchKey(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function pushUnique(values: string[], seen: Set<string>, value: string): void {
  if (!seen.has(value)) {
    seen.add(value);
    values.push(value);
  }
}

function unknownSlugFilterError(value: string, entries: InstalledDocsetFilterEntry[]): DdserveError {
  if (entries.length === 0) {
    return new DdserveError(`No docsets are installed; cannot resolve --slug filter "${value}"`);
  }

  return new DdserveError(
    `Unknown --slug filter "${value}"; expected an exact installed docset slug. Installed slugs: ${formatSlugs(entries)}`,
  );
}

function unknownLanguageFilterError(
  value: string,
  entries: InstalledDocsetFilterEntry[],
  hasSourceMetadata: boolean,
): DdserveError {
  if (entries.length === 0) {
    return new DdserveError(`No docsets are installed; cannot resolve --language filter "${value}"`);
  }

  const metadataNote = hasSourceMetadata ? "" : " Cached DevDocs source metadata is unavailable, so aliases may be missing.";
  return new DdserveError(
    `Unknown --language filter "${value}"; expected an installed docset slug, name, type, or alias. Installed slugs: ${formatSlugs(entries)}.${metadataNote}`,
  );
}

function ambiguousLanguageFilterError(value: string, entries: InstalledDocsetFilterEntry[]): DdserveError {
  return new DdserveError(
    `Ambiguous --language filter "${value}"; matches multiple installed docsets: ${formatCandidates(entries)}. Use --slug with an exact installed slug.`,
  );
}

function formatSlugs(entries: InstalledDocsetFilterEntry[]): string {
  return entries.map((entry) => entry.slug).join(", ");
}

function formatCandidates(entries: InstalledDocsetFilterEntry[]): string {
  return entries.map((entry) => `${entry.slug} (${entry.name})`).join(", ");
}
