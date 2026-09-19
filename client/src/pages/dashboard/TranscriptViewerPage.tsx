import { AlertTriangle, Check, Download, Loader2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ReviewStatusBadge } from "@/components/dashboard/ReviewStatusBadge";
import { SpeakerMappingPanel } from "@/components/transcript/SpeakerMappingPanel";
import { TranscriptSegmentRow } from "@/components/transcript/TranscriptSegmentRow";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useTranscriptionEditor } from "@/hooks/useTranscriptionEditor";
import { downloadTextFile, formatTranscriptForExport } from "@/lib/exportTranscript";
import { formatDate } from "@/lib/format";
import { transcriptions } from "@/services/transcriptions/transcriptionsService";

export function TranscriptViewerPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const {
    transcription,
    loadError,
    saveError,
    isSaving,
    updateSpeakerRole,
    updateSegment,
    markReviewed,
  } = useTranscriptionEditor(id!);

  const dirtySegmentsRef = useRef(new Set<string>());
  const handleDirtyChange = useCallback((segmentId: string, dirty: boolean) => {
    if (dirty) dirtySegmentsRef.current.add(segmentId);
    else dirtySegmentsRef.current.delete(segmentId);
  }, []);

  useEffect(() => {
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      if (dirtySegmentsRef.current.size === 0) return;
      e.preventDefault();
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

  const speakerIndex = useMemo(() => {
    const map = new Map<string, number>();
    transcription?.speakers.forEach((s, i) => map.set(s.id, i));
    return map;
  }, [transcription?.speakers]);

  async function handleDelete() {
    if (!transcription) return;
    if (!window.confirm("Delete this transcript? This cannot be undone.")) return;
    await transcriptions.remove(transcription.id);
    navigate("/dashboard/history", { replace: true });
  }

  function handleExport() {
    if (!transcription) return;
    if (transcription.reviewStatus !== "reviewed") {
      const proceed = window.confirm(
        "This transcript hasn't been marked reviewed yet. " +
          "Exported text is unverified, auto-generated content, not confirmed clinical " +
          "documentation. Export anyway?",
      );
      if (!proceed) return;
    }
    downloadTextFile(
      `transcript-${transcription.id}.txt`,
      formatTranscriptForExport(transcription.segments, transcription.speakers),
    );
  }

  if (loadError) {
    return <p className="text-sm text-destructive">{loadError}</p>;
  }

  if (!transcription) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            {formatDate(transcription.createdAt)}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <ReviewStatusBadge status={transcription.reviewStatus} />
            <span className="text-xs text-muted-foreground">
              {transcription.engine === "deepgram"
                ? "Processed by Deepgram (cloud)"
                : "Processed locally"}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {transcription.reviewStatus !== "reviewed" && (
            <Button variant="outline" onClick={markReviewed} disabled={isSaving("review")}>
              {isSaving("review") ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Check className="size-4" />
              )}
              Mark as reviewed
            </Button>
          )}
          <Button variant="outline" onClick={handleExport}>
            <Download className="size-4" />
            Export .txt
          </Button>
          <Button variant="outline" onClick={handleDelete}>
            <Trash2 className="size-4" />
            Delete
          </Button>
        </div>
      </div>

      {transcription.reviewStatus !== "reviewed" && (
        <p className="rounded-md bg-amber-100 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          This is unreviewed, automatically generated text — not confirmed clinical
          documentation. Confirm the speakers and segments below, then mark it reviewed.
        </p>
      )}

      {transcription.diarization.status !== "ok" ? (
        <p className="flex items-center gap-2 rounded-md bg-amber-100 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <AlertTriangle className="size-3.5 shrink-0" />
          Speaker detection {transcription.diarization.status === "unavailable"
            ? "was unavailable"
            : "failed"}{" "}
          for this recording — assign speakers to segments manually below.
        </p>
      ) : (
        transcription.speakers.length > 0 && (
          <SpeakerMappingPanel
            speakers={transcription.speakers}
            isSaving={isSaving}
            onChangeRole={updateSpeakerRole}
          />
        )
      )}

      {saveError && <p className="text-sm text-destructive">{saveError}</p>}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm text-muted-foreground">Transcript</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {transcription.segments.map((segment) => (
            <TranscriptSegmentRow
              key={segment.id}
              segment={segment}
              speakers={transcription.speakers}
              speakerIndex={speakerIndex}
              isSaving={isSaving}
              onSave={updateSegment}
              onDirtyChange={handleDirtyChange}
            />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
