const pattern = (value: string) => `%${value.replace(/[\\%_]/gu, "\\$&")}%`;

/** Bounded plain-language AND matching; every value remains a bound SQL parameter. */
export function communitySearchTerms(query: string): string[] {
  const terms = [...new Set(query.trim().split(/\s+/u).filter(Boolean))];
  return terms.length <= 8 ? terms : [query.trim()];
}

export function communitySearchCondition(query: string) {
  const terms = communitySearchTerms(query);
  return {
    sql: terms.map(() => "(post.title LIKE ? ESCAPE '\\' OR post.body LIKE ? ESCAPE '\\')").join(" AND "),
    values: terms.flatMap((term) => [pattern(term), pattern(term)]),
  };
}

export function communitySearchScore(query: string) {
  const terms = communitySearchTerms(query);
  return {
    sql: `CASE WHEN LOWER(matched.title)=LOWER(?) THEN 3
      WHEN matched.title LIKE ? ESCAPE '\\' THEN 2
      WHEN ${terms.map(() => "matched.title LIKE ? ESCAPE '\\'").join(" AND ")} THEN 1 ELSE 0 END`,
    values: [query.trim(), pattern(query.trim()), ...terms.map(pattern)],
  };
}
