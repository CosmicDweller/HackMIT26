import { mockSoapNote, mockTranscript } from "@/lib/mockData";
import type { SoapNote, TranscriptChunk, VoiceProfile } from "@/types";

/**
 * Stub API client for the core pipeline (voice enrollment, recording upload,
 * transcript, SOAP note). None of these endpoints are in API_contract.md yet —
 * tracked as an open question on issue #3. Swap each function body for a real
 * fetch() once the backend contract is agreed; keep the signatures stable so
 * callers don't need to change.
 */

function delay<T>(value: T, ms = 600): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

export async function enrollVoiceProfile(
  label: string,
  _audio: Blob,
): Promise<VoiceProfile> {
  return delay({
    id: crypto.randomUUID(),
    label,
    createdAt: new Date().toISOString(),
  });
}

export async function uploadVisitRecording(
  _sessionId: string,
  _audio: Blob,
): Promise<{ accepted: true }> {
  return delay({ accepted: true }, 400);
}

export async function getTranscript(
  _sessionId: string,
): Promise<TranscriptChunk[]> {
  return delay(mockTranscript, 900);
}

export async function getSoapNote(_sessionId: string): Promise<SoapNote> {
  return delay(mockSoapNote, 900);
}
