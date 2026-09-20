import type { SoapNote, SoapPreference, SoapSectionKey, SoapTemplate, SoapTemplateId } from "@/types";

export interface SoapApi {
  listTemplates(): Promise<SoapTemplate[]>;
  getPreference(): Promise<SoapPreference>;
  setPreference(templateId: SoapTemplateId): Promise<SoapPreference>;
  /** null when no SOAP note has been created for this transcription yet (404). */
  get(transcriptionId: string): Promise<SoapNote | null>;
  /** Idempotent create/recovery — only call when get() returned null. Never regenerates. */
  create(transcriptionId: string): Promise<SoapNote>;
  update(
    transcriptionId: string,
    patch: { sections: Record<SoapSectionKey, string>; revision: number },
  ): Promise<SoapNote>;
  approve(transcriptionId: string, revision: number): Promise<SoapNote>;
  /** Clears a stale-source state after the doctor re-checks an edited transcript. */
  reconcile(transcriptionId: string, revision: number): Promise<SoapNote>;
  /** Retries a `failed` note only; a good or edited draft is returned untouched. */
  retry(transcriptionId: string): Promise<SoapNote>;
  /** Acknowledges a NON-blocking flag; the backend refuses blocking ones (409 FLAG_BLOCKING). */
  acknowledgeFlag(transcriptionId: string, flagId: string): Promise<SoapNote>;
  export(transcriptionId: string, format: "pdf" | "txt"): Promise<Blob>;
}
