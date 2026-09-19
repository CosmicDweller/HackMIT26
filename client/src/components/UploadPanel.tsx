import { UploadCloud } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { AudioAsset } from "@/types";

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
const ACCEPTED_EXTENSIONS = [".mp3", ".wav", ".m4a", ".ogg", ".webm", ".flac"];

interface UploadPanelProps {
  onSelected: (asset: AudioAsset) => void;
}

function isLikelyAudioFile(file: File): boolean {
  if (file.type.startsWith("audio/")) return true;
  const lower = file.name.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function UploadPanel({ onSelected }: UploadPanelProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(
    (file: File | undefined) => {
      if (!file) return;
      setError(null);

      if (!isLikelyAudioFile(file)) {
        setError("That file doesn't look like an audio file. Try MP3, WAV, M4A, OGG, WEBM, or FLAC.");
        return;
      }
      if (file.size > MAX_FILE_BYTES) {
        setError(`File is too large (${formatBytes(file.size)}). Maximum size is 10 MB.`);
        return;
      }
      if (file.size === 0) {
        setError("That file is empty.");
        return;
      }

      onSelected({
        blob: file,
        source: "upload",
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        url: URL.createObjectURL(file),
      });
    },
    [onSelected],
  );

  return (
    <div className="flex flex-col items-center gap-4 py-6">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          handleFile(e.dataTransfer.files[0]);
        }}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
        }}
        className={cn(
          "flex w-full max-w-sm cursor-pointer flex-col items-center gap-3 rounded-lg border border-dashed px-8 py-10 text-center transition-colors",
          isDragging
            ? "border-foreground/40 bg-muted"
            : "border-border hover:border-foreground/30 hover:bg-muted/50",
        )}
      >
        <UploadCloud className="size-7 text-muted-foreground" />
        <div className="text-sm">
          <span className="font-medium text-foreground">Click to upload</span>
          <span className="text-muted-foreground"> or drag and drop</span>
        </div>
        <p className="text-xs text-muted-foreground">
          MP3, WAV, M4A, OGG, WEBM, FLAC — up to 10 MB
        </p>
        <input
          ref={inputRef}
          type="file"
          accept="audio/*"
          className="hidden"
          onChange={(e) => handleFile(e.target.files?.[0])}
        />
      </div>

      {error && (
        <p className="max-w-sm text-center text-sm text-destructive">{error}</p>
      )}
    </div>
  );
}
