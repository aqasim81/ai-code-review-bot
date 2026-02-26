declare const brand: unique symbol;

type Brand<T, TBrand extends string> = T & { readonly [brand]: TBrand };

export type InstallationId = Brand<string, "InstallationId">;
export type RepositoryId = Brand<string, "RepositoryId">;
export type ReviewId = Brand<string, "ReviewId">;
export type ReviewCommentId = Brand<string, "ReviewCommentId">;
export type JobId = Brand<string, "JobId">;
