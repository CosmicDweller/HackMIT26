import { AlertTriangle, Check, Clipboard, Download, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { SoapGenerationStatus } from "@/components/soap/SoapGenerationStatus";
import { SoapSectionEditor } from "@/components/soap/SoapSectionEditor";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useSoapNote } from "@/hooks/useSoapNote";
import { downloadBlob, formatSoapNoteAsText, SOAP_SECTION_ORDER } from "@/lib/soapExport";
import { formatDate } from "@/lib/format";
import { soap } from "@/services/soap/soapService";
import type { SoapClaim, SoapSectionKey, SoapSections, Transcription } from "@/types";

interface SoapEditorProps {
  transcription: Transcription;
  onClaimClick: (claim: SoapClaim) => void;
}

export function SoapEditor({ transcription, onClaimClick }: SoapEditorProps) {
  const {
    note,
    loading,
    loadError,
    saveState,
    saveError,
    conflictNote,
    approving,
    approveError,
    save,
    retryAfterConflict,
    approve,
    reconcile,
    retry,
    acknowledgeFlag,
    discardConflict,
    refresh,
  } = useSoapNote(transcription.id);

  const [editingSection, setEditingSection] = useState<SoapSectionKey | null>(null);
  const [draft, setDraft] = useState<SoapSections | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<"pdf" | "txt" | "copy" | null>(null);

  const dirty = draft !== null;
  const readOnly = note?.status === "approved";

  useEffect(() => {
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      if (dirty) e.preventDefault();
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [dirty]);

  // Editing the transcript — assigning a speaker, correcting a segment — is what makes this note stale, and the server only
  // recomputes that on read. Without this the doctor keeps seeing a note that silently disagrees with the transcript: no stale
  // banner, no reconcile button, and no way to reach either short of reloading the page by hand.
  const transcriptRevision = transcription.revision;
  const lastRevisionRef = useRef(transcriptRevision);
  useEffect(() => {
    if (lastRevisionRef.current === transcriptRevision) return;
    lastRevisionRef.current = transcriptRevision;
    refresh();
  }, [transcriptRevision, refresh]);

  if (loading) {
    return (
      <Card>
        <CardContent className="flex justify-center py-10">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (loadError || !note) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-destructive">
          {loadError ?? "Couldn't load the SOAP note."}
        </CardContent>
      </Card>
    );
  }

  const sections = draft ?? note.sections;
  // The backend computes staleness itself; don't second-guess it by comparing revisions.
  const staleSource = note.sourceStale;
  // Blocking flags mean a statement the transcript doesn't support: they can't be
  // acknowledged away, only fixed in the text, and they block approval.
  const blockingFlags = note.reviewFlags.filter((f) => f.blocking && !f.resolved);
  const openAdvisoryFlags = note.reviewFlags.filter(
    (f) => !f.blocking && !f.resolved && !f.acknowledgedAt,
  );
  // An empty section is a statement about the consultation, not a defect in the note: a visit that examined nothing has an empty
  // Objective, and that is the accurate record. Counting those as "unresolved review flags" in the approval prompt made an
  // accurate note look unsafe to sign, so only findings the doctor could actually act on are worth pausing over.
  const actionableFlags = openAdvisoryFlags.filter((f) => f.type !== "missing_documentation");

  function updateSection(key: SoapSectionKey, value: string) {
    setDraft({ ...(draft ?? note!.sections), [key]: value });
  }

  async function handleSaveDraft() {
    const saved = await save(sections);
    if (saved) {
      setDraft(null);
      setEditingSection(null);
    }
  }

  async function handleApprove() {
    // A save advances the revision, so approve with the revision it returned — the one
    // captured in this closure is stale as soon as the save resolves.
    let revision = note!.revision;
    if (dirty) {
      const saved = await save(sections);
      if (!saved) return;
      revision = saved.revision;
      setDraft(null);
      setEditingSection(null);
    }
    const flagCount = actionableFlags.length;
    const proceed = window.confirm(
      flagCount > 0
        ? `This note still has ${flagCount} unresolved review flag${flagCount === 1 ? "" : "s"}. Approve anyway?`
        : "Approve this SOAP note? Once approved it becomes read-only and can be exported.",
    );
    if (!proceed) return;
    await approve(revision);
  }

  function handleDiscardConflict() {
    discardConflict();
    setDraft(null);
    setEditingSection(null);
  }

  async function handleRetrySaveAnyway() {
    const ok = await retryAfterConflict(sections);
    if (ok) {
      setDraft(null);
      setEditingSection(null);
    }
  }

  async function handleExport(format: "pdf" | "txt") {
    setExportError(null);
    setExporting(format);
    try {
      const blob = await soap.export(transcription.id, format);
      downloadBlob(`soap-note-${transcription.id}.${format}`, blob);
    } catch {
      setExportError(`Couldn't download the ${format.toUpperCase()}. Try again.`);
    } finally {
      setExporting(null);
    }
  }

  async function handleCopy() {
    setExportError(null);
    setExporting("copy");
    try {
      await navigator.clipboard.writeText(formatSoapNoteAsText(note!.sections));
    } catch {
      setExportError("Couldn't copy to clipboard.");
    } finally {
      setExporting(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>SOAP Note</CardTitle>
          {note.status === "approved" ? (
            <span className="flex items-center gap-1.5 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">
              <Check className="size-3.5" />
              Approved {note.approvedAt && formatDate(note.approvedAt)}
            </span>
          ) : (
            <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-200">
              Draft — not yet approved
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {note.status === "processing" && (
          <SoapGenerationStatus stage={note.generationStage} />
        )}
        {note.status === "failed" && (
          <div className="space-y-2">
            <SoapGenerationStatus stage={null} errorCode={note.errorCode} />
            <Button variant="outline" size="sm" onClick={retry}>
              Try generating again
            </Button>
          </div>
        )}

        {(note.status === "draft_ready" || note.status === "approved") && (
          <>
            {staleSource && (
              <div className="space-y-2 rounded-md bg-amber-100 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                <p className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  The transcript was edited after this note was drafted (note is from
                  revision {note.sourceTranscriptRevision}, transcript is now at{" "}
                  {note.transcriptRevision}). The note is not updated automatically —
                  re-check it against the transcript below, then confirm.
                </p>
                {note.status !== "approved" && (
                  <Button variant="outline" size="xs" onClick={reconcile}>
                    I've re-checked this against the transcript
                  </Button>
                )}
              </div>
            )}

            {/* Blocking flags: a statement the transcript doesn't support. No acknowledge
                button — it has to be corrected or removed in the text. */}
            {blockingFlags.length > 0 && (
              <div className="space-y-1.5">
                {blockingFlags.map((flag) => (
                  <p
                    key={flag.id}
                    className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
                  >
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                    <span className="flex-1">
                      {flag.message}
                      <span className="mt-0.5 block opacity-80">
                        This must be corrected or removed before the note can be approved.
                      </span>
                    </span>
                  </p>
                ))}
              </div>
            )}

            {openAdvisoryFlags.length > 0 && (
              <div className="space-y-1.5">
                {openAdvisoryFlags.map((flag) => (
                  <p
                    key={flag.id}
                    className="flex items-start gap-2 rounded-md bg-amber-100 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200"
                  >
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                    <span className="flex-1">{flag.message}</span>
                    {!readOnly && (
                      <button
                        type="button"
                        onClick={() => acknowledgeFlag(flag.id)}
                        className="shrink-0 underline underline-offset-2"
                      >
                        Mark reviewed
                      </button>
                    )}
                  </p>
                ))}
              </div>
            )}

            {conflictNote && (
              <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs">
                <p className="text-destructive">
                  This note was changed elsewhere since you started editing.
                </p>
                <div className="flex gap-2">
                  <Button variant="outline" size="xs" onClick={handleDiscardConflict}>
                    Discard my edits and reload
                  </Button>
                  <Button size="xs" onClick={handleRetrySaveAnyway}>
                    Keep my edits and retry save
                  </Button>
                </div>
              </div>
            )}

            {SOAP_SECTION_ORDER.map(({ key, heading }) => (
              <SoapSectionEditor
                key={key}
                sectionKey={key}
                heading={heading}
                text={sections[key]}
                claims={note.claims.filter((c) => c.section === key)}
                editing={editingSection === key}
                readOnly={!!readOnly}
                onToggleEdit={() => setEditingSection(editingSection === key ? null : key)}
                onChange={(text) => updateSection(key, text)}
                onClaimClick={onClaimClick}
              />
            ))}

            {saveError && <p className="text-sm text-destructive">{saveError}</p>}
            {approveError && <p className="text-sm text-destructive">{approveError}</p>}
            {exportError && <p className="text-sm text-destructive">{exportError}</p>}

            <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
              {!readOnly && (
                <>
                  <Button variant="outline" onClick={handleSaveDraft} disabled={!dirty || saveState === "saving"}>
                    {saveState === "saving" ? <Loader2 className="size-4 animate-spin" /> : null}
                    {saveState === "saving" ? "Saving…" : saveState === "saved" && !dirty ? "Saved." : "Save Draft"}
                  </Button>
                  <Button
                    onClick={handleApprove}
                    disabled={approving || staleSource || blockingFlags.length > 0}
                    title={
                      blockingFlags.length > 0
                        ? "Unsupported statements must be corrected or removed first"
                        : staleSource
                          ? "Re-check the note against the edited transcript first"
                          : undefined
                    }
                  >
                    {approving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
                    Approve SOAP Note
                  </Button>
                </>
              )}
              <Button
                variant="outline"
                onClick={() => handleExport("pdf")}
                disabled={!readOnly || exporting != null}
                title={readOnly ? undefined : "Approve the note to enable export"}
              >
                {exporting === "pdf" ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
                Download PDF
              </Button>
              <Button
                variant="outline"
                onClick={() => handleExport("txt")}
                disabled={!readOnly || exporting != null}
                title={readOnly ? undefined : "Approve the note to enable export"}
              >
                {exporting === "txt" ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
                Download TXT
              </Button>
              <Button
                variant="outline"
                onClick={handleCopy}
                disabled={!readOnly || exporting != null}
                title={readOnly ? undefined : "Approve the note to enable copying"}
              >
                {exporting === "copy" ? <Loader2 className="size-4 animate-spin" /> : <Clipboard className="size-4" />}
                Copy Note
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
