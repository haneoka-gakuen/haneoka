import { searchGlob } from "../src/lib/search-text";

/** Bounded plain-language AND matching; every value remains a bound SQL parameter. */
export function communitySearchTerms(query: string): string[] {
  const terms = [...new Set(query.trim().split(/\s+/u).filter(Boolean))];
  return terms.length <= 8 ? terms : [query.trim()];
}

export function communitySearchCondition(query: string) {
  const terms = communitySearchTerms(query);
  return {
    sql: terms.map(() => "(LOWER(post.title) GLOB ? OR LOWER(post.body) GLOB ?)").join(" AND "),
    values: terms.flatMap((term) => {
      const pattern = searchGlob(term);
      return [pattern, pattern];
    }),
  };
}

export function communitySearchScore(query: string) {
  const terms = communitySearchTerms(query);
  return {
    sql: `CASE WHEN LOWER(matched.title) GLOB ? THEN 3
      WHEN LOWER(matched.title) GLOB ? THEN 2
      WHEN ${terms.map(() => "LOWER(matched.title) GLOB ?").join(" AND ")} THEN 1 ELSE 0 END`,
    values: [searchGlob(query.trim(), true), searchGlob(query.trim()), ...terms.map((term) => searchGlob(term))],
  };
}
