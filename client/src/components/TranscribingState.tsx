import { Loader2 } from "lucide-react";

export function TranscribingState() {
  return (
    <div className="flex flex-col items-center gap-3 py-14">
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
      <p className="text-sm text-muted-foreground">Transcribing your audio…</p>
    </div>
  );
}
