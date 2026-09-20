import { SoapProviderError } from "./gemini.js";
import { compositionPrompt, extractionPrompt, factSchema, manualFactsBlock, noteSchema, numberedTranscript, uncertaintyNotice } from "./prompt.js";
import { DEFAULT_TEMPLATE_ID, templateById } from "./templates.js";
import { validateFacts, validateNote } from "./validate.js";

// Turning a persisted transcript into a draft SOAP note. Two stages on purpose: pull out facts with their sources first, then write
// only from those facts. Asking for a polished note in one step produces fluent text whose sentences cannot be traced to anything.
//
// The input is always the FINAL STORED transcript (with the doctor's corrections and confirmed speaker roles), never Deepgram's raw
// response: the note must describe the document the doctor actually has.

/** A long transcript is drafted in windows so nothing is silently truncated. Measured against the model's practical input size. */
const WINDOW_SEGMENTS = 220;
const WINDOW_OVERLAP = 10;

export function createSoapGenerator({ config, provider, logger = console }) {
  /**
   * Draft a note. Returns { sections, claims, reviewFlags, blocking, usage, templateId, model, provider, stages }.
   * Throws SoapProviderError (provider trouble) or Error (unusable response). Never returns a partial note as a complete one.
   */
  async function generate(transcription, { templateId = DEFAULT_TEMPLATE_ID, manualFacts = [], signal, onStage = () => {} } = {}) {
    const template = templateById(templateId) ?? templateById(DEFAULT_TEMPLATE_ID);
    if (transcription.segments.length === 0) throw new SoapProviderError("EMPTY_TRANSCRIPT", { detail: "no segments" });

    const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, ms: 0, calls: 0 };
    const add = (part) => {
      usage.inputTokens += part.inputTokens ?? 0;
      usage.outputTokens += part.outputTokens ?? 0;
      usage.totalTokens += part.totalTokens ?? 0;
      usage.ms += part.ms ?? 0;
      usage.calls += 1;
    };

    const { lines } = numberedTranscript(transcription);
    const uncertainty = uncertaintyNotice(transcription);
    const manualBlock = manualFactsBlock(manualFacts);

    // ---- stage 1: facts, with their sources ----
    onStage("extracting");
    const windows = splitIntoWindows(transcription);
    const allFacts = [];
    let droppedFacts = 0;
    for (const window of windows) {
      const prompt = extractionPrompt({ transcript: window.text, manualFacts: manualBlock, uncertainty });
      const { data, usage: used } = await provider.generate({ ...prompt, schema: factSchema(), stage: `extract${windows.length > 1 ? ` ${window.index + 1}/${windows.length}` : ""}`, signal });
      add(used);
      // Facts cite line numbers within the WHOLE transcript (windows keep the global numbering), so they resolve directly.
      const { facts, dropped } = validateFacts(data, { lines });
      droppedFacts += dropped;
      allFacts.push(...facts);
    }
    if (allFacts.length === 0) throw new Error("no usable clinical facts were extracted from this transcript");
    // Renumber after merging windows so ids are unique across the whole note.
    const facts = allFacts.map((fact, index) => ({ ...fact, id: `fact_${index + 1}` }));

    // ---- stage 2: the note, written only from those facts ----
    onStage("drafting");
    const { text: fullTranscript } = numberedTranscript(transcription);
    const factLines = facts.map((fact) => `(${fact.id}) [${fact.category}${fact.negated ? ", NEGATED" : ""}${fact.uncertain ? ", UNCERTAIN" : ""}] ${fact.text}  <- lines ${fact.sourceLines.join(", ")}`).join("\n");
    const prompt = compositionPrompt({ transcript: fullTranscript, facts: factLines, template, manualFacts: manualBlock, uncertainty });
    const { data, usage: used } = await provider.generate({ ...prompt, schema: noteSchema(), stage: "compose", signal });
    add(used);

    // ---- validation against the transcript itself ----
    onStage("validating");
    const validated = validateNote(data, { lines, segments: transcription.segments, manualFacts });
    if (droppedFacts > 0) {
      validated.reviewFlags.push({
        id: `flag_${validated.reviewFlags.length + 1}`, type: "invalid_source", severity: "info", section: null, claimId: null,
        message: `${droppedFacts} extracted fact${droppedFacts === 1 ? "" : "s"} cited a transcript line that does not exist and ${droppedFacts === 1 ? "was" : "were"} discarded before drafting.`,
        blocking: false, resolved: false, acknowledgedAt: null, source: "validator",
      });
    }
    logger.log(`soap draft: ${facts.length} facts, ${validated.claims.length} claims, ${validated.reviewFlags.length} flags (${validated.blocking} blocking), ${usage.totalTokens} tokens, ${usage.ms} ms`);
    return { ...validated, facts, usage, templateId: template.id, model: provider.model, provider: provider.provider };
  }

  /**
   * Windows of the transcript for fact extraction, keeping GLOBAL line numbers so every citation still resolves. Overlapping a few
   * segments stops a fact that straddles a boundary from being lost. Nothing is ever dropped: every segment is in some window.
   */
  function splitIntoWindows(transcription) {
    const { lines } = numberedTranscript(transcription);
    const rendered = numberedTranscript(transcription).text.split("\n");
    if (rendered.length <= WINDOW_SEGMENTS) return [{ index: 0, text: rendered.join("\n"), from: 1, to: lines.length }];
    const windows = [];
    for (let start = 0; start < rendered.length; start += WINDOW_SEGMENTS - WINDOW_OVERLAP) {
      const slice = rendered.slice(start, start + WINDOW_SEGMENTS);
      if (slice.length === 0) break;
      windows.push({ index: windows.length, text: slice.join("\n"), from: start + 1, to: start + slice.length });
      if (start + WINDOW_SEGMENTS >= rendered.length) break;
    }
    return windows;
  }

  return { generate, splitIntoWindows, get configured() { return provider.configured(); } };
}
