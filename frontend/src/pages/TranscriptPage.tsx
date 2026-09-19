import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { getTranscript } from "@/api/client";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { TranscriptChunk } from "@/types";

function formatTimestamp(ms: number) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function TranscriptPage() {
  const [searchParams] = useSearchParams();
  const highlighted = new Set(
    (searchParams.get("highlight") ?? "").split(",").filter(Boolean),
  );

  const [chunks, setChunks] = useState<TranscriptChunk[] | null>(null);
  const chunkRefs = useRef<Record<string, HTMLDivElement | null>>({});

  useEffect(() => {
    getTranscript("session-1").then(setChunks);
  }, []);

  useEffect(() => {
    if (!chunks || highlighted.size === 0) return;
    const firstId = [...highlighted][0];
    chunkRefs.current[firstId]?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chunks]);

  return (
    <div className="mx-auto max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle>Transcript</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!chunks && (
            <p className="text-sm text-muted-foreground">
              Generating transcript...
            </p>
          )}
          {chunks?.map((chunk) => (
            <div
              key={chunk.id}
              ref={(el) => {
                chunkRefs.current[chunk.id] = el;
              }}
              className={cn(
                "flex gap-3 rounded-md p-3 transition-colors",
                highlighted.has(chunk.id) && "bg-accent ring-1 ring-ring",
              )}
            >
              <div className="w-16 shrink-0 pt-0.5 text-xs text-muted-foreground">
                {formatTimestamp(chunk.startMs)}
              </div>
              <div className="space-y-1">
                <Badge
                  variant={chunk.speaker === "doctor" ? "default" : "secondary"}
                >
                  {chunk.speaker === "doctor" ? "Doctor" : "Patient"}
                </Badge>
                <p className="text-sm">{chunk.text}</p>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
