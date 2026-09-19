import { Loader2 } from "lucide-react";
import type { TranscriptionJob } from "@/types";

function stageLabel(uploading: boolean, job: TranscriptionJob | null): string {
  if (uploading) return "Uploading recording…";
  switch (job?.status) {
    case "queued":
    case "preparing":
      return "Preparing audio…";
    case "uploading":
    case "transcribing":
      return "Transcribing with Deepgram…";
    case "completed":
      return "Finalizing transcript…";
    default:
      return "Processing…";
  }
}

export function JobProgress({
  uploading,
  job,
}: {
  uploading: boolean;
  job: TranscriptionJob | null;
}) {
  return (
    <div className="flex flex-col items-center gap-3 py-14">
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
      <p className="text-sm text-muted-foreground">{stageLabel(uploading, job)}</p>
      <p className="max-w-sm text-center text-xs text-muted-foreground">
        This can take a little while for longer recordings. You can leave this
        page — the recording is saved on the server and will finish
        processing; find it again from the dashboard.
      </p>
    </div>
  );
}
