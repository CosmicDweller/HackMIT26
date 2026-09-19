import { Check, Copy, Download, RotateCcw } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { formatSeconds } from "@/lib/format";

interface TranscriptResultProps {
  transcript: string;
  durationSeconds: number | null;
  onChange: (text: string) => void;
  onNewTranscription: () => void;
}

export function TranscriptResult({
  transcript,
  durationSeconds,
  onChange,
  onNewTranscription,
}: TranscriptResultProps) {
  const [copied, setCopied] = useState(false);
  const isEmpty = transcript.trim().length === 0;

  async function handleCopy() {
    await navigator.clipboard.writeText(transcript);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function handleDownload() {
    const blob = new Blob([transcript], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "transcript.txt";
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-4 py-6">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">Transcript</h2>
        {durationSeconds != null && (
          <span className="text-xs text-muted-foreground">
            {formatSeconds(durationSeconds)} of audio
          </span>
        )}
      </div>

      <textarea
        value={transcript}
        onChange={(e) => onChange(e.target.value)}
        placeholder={isEmpty ? "No speech was detected in this audio." : undefined}
        rows={8}
        className="w-full resize-y rounded-lg border border-input bg-background px-3 py-2.5 text-sm leading-relaxed outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={handleCopy} disabled={isEmpty}>
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button variant="outline" onClick={handleDownload} disabled={isEmpty}>
          <Download className="size-4" />
          Download .txt
        </Button>
        <Button variant="ghost" onClick={onNewTranscription} className="ml-auto">
          <RotateCcw className="size-4" />
          New transcription
        </Button>
      </div>
    </div>
  );
}
