import { Trash2 } from "lucide-react";
import { Link } from "react-router-dom";
import { ReviewStatusBadge } from "@/components/dashboard/ReviewStatusBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useTranscriptionList } from "@/hooks/useTranscriptionList";
import { formatDate, formatSeconds } from "@/lib/format";

export function TranscriptHistoryPage() {
  const { items, error, remove } = useTranscriptionList();

  async function handleDelete(id: string) {
    if (!window.confirm("Delete this transcript? This cannot be undone.")) return;
    await remove(id);
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-xl font-semibold tracking-tight">Transcript history</h1>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {items === null && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
      {items?.length === 0 && (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No transcripts yet.
          </CardContent>
        </Card>
      )}

      <div className="space-y-2">
        {items?.map((t) => (
          <Card key={t.id}>
            <CardContent className="flex items-center justify-between gap-4">
              <Link to={`/dashboard/transcripts/${t.id}`} className="min-w-0 flex-1">
                <p className="text-sm font-medium">{formatDate(t.createdAt)}</p>
                <p className="text-xs text-muted-foreground">
                  {t.durationSeconds != null ? formatSeconds(t.durationSeconds) : "Unknown length"}
                </p>
              </Link>
              <ReviewStatusBadge status={t.reviewStatus} />
              <Button variant="ghost" size="icon" onClick={() => handleDelete(t.id)} aria-label="Delete transcript">
                <Trash2 className="size-4" />
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
