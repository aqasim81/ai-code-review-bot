export type DiffParseError = "DIFF_EMPTY";

export type AstParseError =
  | "AST_INIT_FAILED"
  | "AST_LANGUAGE_NOT_SUPPORTED"
  | "AST_PARSE_FAILED";

export type ContextBuildError = "CONTEXT_NO_REVIEWABLE_FILES";
