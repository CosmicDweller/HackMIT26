import { FileAudio, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/format";
import type { AudioAsset } from "@/types";

interface AudioPreviewProps {
  audio: AudioAsset;
  onTranscribe: () => void;
  onDiscard: () => void;
}

export function AudioPreview({ audio, onTranscribe, onDiscard }: AudioPreviewProps) {
  return (
    <div className="flex flex-col items-center gap-4 py-6">
      <div className="flex w-full max-w-sm items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-left">
        <FileAudio className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{audio.fileName}</p>
          <p className="text-xs text-muted-foreground">
            {formatBytes(audio.blob.size)}
          </p>
        </div>
      </div>

      <audio controls src={audio.url} className="w-full max-w-sm" />

      <div className="flex items-center gap-2">
        <Button variant="outline" onClick={onDiscard}>
          <RotateCcw className="size-4" />
          Replace
        </Button>
        <Button onClick={onTranscribe}>Transcribe</Button>
      </div>
    </div>
  );
}
