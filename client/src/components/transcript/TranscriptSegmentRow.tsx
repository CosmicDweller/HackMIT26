import { AlertTriangle, Check, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatSeconds } from "@/lib/format";
import { speakerColor } from "@/lib/speakerColors";
import { speakerDisplayLabel } from "@/lib/exportTranscript";
import { cn } from "@/lib/utils";
import type { Speaker, TranscriptSegment } from "@/types";

interface TranscriptSegmentRowProps {
  segment: TranscriptSegment;
  speakers: Speaker[];
  speakerIndex: Map<string, number>;
  isSaving: (key: string) => boolean;
  onSave: (segmentId: string, patch: { text: string; speakerId: string | null }) => void;
  onDirtyChange?: (segmentId: string, dirty: boolean) => void;
}

export function TranscriptSegmentRow({
  segment,
  speakers,
  speakerIndex,
  isSaving,
  onSave,
  onDirtyChange,
}: TranscriptSegmentRowProps) {
  const [draftText, setDraftText] = useState(segment.text);
  const [justSaved, setJustSaved] = useState(false);
  const saving = isSaving(`segment:${segment.id}`);
  const wasSaving = useRef(false);
  const dirty = draftText !== segment.text;

  useEffect(() => {
    setDraftText(segment.text);
  }, [segment.text]);

  useEffect(() => {
    onDirtyChange?.(segment.id, dirty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, segment.id]);

  useEffect(() => {
    return () => onDirtyChange?.(segment.id, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segment.id]);

  useEffect(() => {
    if (wasSaving.current && !saving) {
      setJustSaved(true);
      const timeout = setTimeout(() => setJustSaved(false), 1500);
      wasSaving.current = saving;
      return () => clearTimeout(timeout);
    }
    wasSaving.current = saving;
  }, [saving]);

  function commitSave(speakerId: string | null) {
    onSave(segment.id, { text: draftText, speakerId });
  }

  const speaker = segment.speakerId ? speakers.find((s) => s.id === segment.speakerId) : undefined;
  const color = segment.speakerId ? speakerColor(speakerIndex.get(segment.speakerId) ?? 0) : null;

  return (
    <div
      className={cn(
        "space-y-1.5 rounded-lg border p-3",
        segment.needsReview ? "border-amber-300 dark:border-amber-800" : "border-border",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        {segment.speakerId ? (
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-xs font-medium",
              color!.bg,
              color!.text,
            )}
          >
            {speakerDisplayLabel(speaker)}
          </span>
        ) : (
          <span className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
            <AlertTriangle className="size-3" />
            Unknown speaker
          </span>
        )}
        <span className="text-xs text-muted-foreground">
          {formatSeconds(segment.startMs / 1000)}
        </span>
        {segment.needsReview && (
          <span className="flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            <AlertTriangle className="size-3" />
            Review
          </span>
        )}

        <select
          value={segment.speakerId ?? ""}
          onChange={(e) => commitSave(e.target.value || null)}
          disabled={saving}
          className="ml-auto rounded-md border border-input bg-transparent px-2 py-1 text-xs text-muted-foreground outline-none focus-visible:border-ring disabled:opacity-50"
          aria-label="Reassign speaker for this segment"
        >
          <option value="">Unknown</option>
          {speakers.map((s) => (
            <option key={s.id} value={s.id}>
              {speakerDisplayLabel(s)}
            </option>
          ))}
        </select>
      </div>

      <textarea
        value={draftText}
        onChange={(e) => setDraftText(e.target.value)}
        onBlur={() => dirty && commitSave(segment.speakerId)}
        rows={2}
        disabled={saving}
        className="w-full resize-y rounded-md border border-transparent bg-transparent px-1 py-1 text-sm leading-relaxed outline-none transition-colors hover:border-input focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
      />

      <div className="flex h-5 items-center justify-end gap-1.5 text-xs text-muted-foreground">
        {saving && (
          <>
            <Loader2 className="size-3 animate-spin" /> Saving…
          </>
        )}
        {!saving && justSaved && (
          <>
            <Check className="size-3 text-emerald-600 dark:text-emerald-500" /> Saved
          </>
        )}
        {!saving && !justSaved && dirty && (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => commitSave(segment.speakerId)}
            className="h-5 px-1.5"
          >
            Save
          </Button>
        )}
      </div>
    </div>
  );
}
