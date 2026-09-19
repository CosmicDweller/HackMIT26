import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getSoapNote } from "@/api/client";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import type { SoapNote } from "@/types";

export function SoapNotePage() {
  const [note, setNote] = useState<SoapNote | null>(null);

  useEffect(() => {
    getSoapNote("session-1").then(setNote);
  }, []);

  return (
    <div className="mx-auto max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle>SOAP Note</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {!note && (
            <p className="text-sm text-muted-foreground">
              Generating SOAP note...
            </p>
          )}
          {note?.sections.map((section, i) => (
            <div key={section.id}>
              {i > 0 && <Separator className="mb-6" />}
              <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                {section.title}
              </h3>
              <ul className="space-y-2">
                {section.claims.map((claim) => (
                  <li key={claim.id} className="text-sm leading-relaxed">
                    {claim.text}{" "}
                    {claim.transcriptChunkIds.length > 0 && (
                      <Link
                        to={`/transcript?highlight=${claim.transcriptChunkIds.join(",")}`}
                        className="ml-1 text-xs font-medium text-primary underline underline-offset-2"
                      >
                        view in transcript
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
