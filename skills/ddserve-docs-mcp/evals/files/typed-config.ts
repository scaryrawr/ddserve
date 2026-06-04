interface SearchOptions {
  mode: "semantic" | "keyword";
  limit: number;
  includeSnippets: boolean;
}

export const defaultSearchOptions = {
  mode: "semantic",
  limit: 10,
  includeSnippets: true,
} as const satisfies SearchOptions;
