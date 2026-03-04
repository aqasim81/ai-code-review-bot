declare const brand: unique symbol;

type Brand<T, TBrand extends string> = T & { readonly [brand]: TBrand };

export type InstallationId = Brand<string, "InstallationId">;
export type RepositoryId = Brand<string, "RepositoryId">;
export type ReviewId = Brand<string, "ReviewId">;
