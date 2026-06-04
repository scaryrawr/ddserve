export function parseKeywordTerms(query: string): string[] {
  return Array.from(
    new Set(
      query
        .toLocaleLowerCase()
        .split(/\s+/)
        .map((term) => term.trim())
        .filter((term) => term.length > 0),
    ),
  ).slice(0, 8);
}
