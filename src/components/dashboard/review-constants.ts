import type {
  CommentCategory,
  CommentSeverity,
  ReviewStatus,
} from "@/generated/prisma/enums";

export const CATEGORY_LABELS: Record<CommentCategory, string> = {
  SECURITY: "Security",
  BUGS: "Bugs",
  PERFORMANCE: "Performance",
  STYLE: "Style",
  BEST_PRACTICES: "Best Practices",
};

export const SEVERITY_VARIANT: Record<
  CommentSeverity,
  "default" | "secondary" | "destructive" | "outline"
> = {
  CRITICAL: "destructive",
  WARNING: "default",
  SUGGESTION: "secondary",
  NITPICK: "outline",
};

export const STATUS_VARIANT: Record<
  ReviewStatus,
  "default" | "secondary" | "destructive" | "outline"
> = {
  COMPLETED: "default",
  FAILED: "destructive",
  PROCESSING: "secondary",
  PENDING: "outline",
};
