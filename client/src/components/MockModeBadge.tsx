import { Badge } from "@/components/ui/badge";

export function MockModeBadge() {
  return (
    <Badge variant="secondary" className="gap-1.5">
      <span className="size-1.5 rounded-full bg-amber-500" />
      Mock mode — backend not connected
    </Badge>
  );
}
