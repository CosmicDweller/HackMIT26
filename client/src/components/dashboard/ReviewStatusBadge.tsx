import { Badge } from "@/components/ui/badge";
import type { ReviewStatus } from "@/types";

export function ReviewStatusBadge({ status }: { status: ReviewStatus }) {
  if (status === "reviewed") {
    return (
      <Badge variant="secondary" className="gap-1.5">
        <span className="size-1.5 rounded-full bg-emerald-500" />
        Reviewed
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="gap-1.5">
      <span className="size-1.5 rounded-full bg-amber-500" />
      Needs review
    </Badge>
  );
}
