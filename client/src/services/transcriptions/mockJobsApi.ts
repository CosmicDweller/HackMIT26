import { TranscribeApiError } from "@/services/transcribeApi";
import { createMockTranscription, requireUserId } from "@/services/transcriptions/mockTranscriptionsStore";
import { autoStartSoapGeneration } from "@/services/soap/mockSoapStore";
import type { JobsApi } from "@/services/transcriptions/jobsApiTypes";
import type { JobStatus, TranscriptionJob } from "@/types";

/**
 * MOCK jobs backend — simulates the async job lifecycle
 * (queued -> preparing -> uploading -> transcribing -> completed/failed)
 * with realistic timing, so the polling UI can be built and demoed before
 * the real /api/transcription-jobs* endpoints are wired in. Disable via
 * VITE_USE_MOCK_TRANSCRIPTIONS=false.
 */

interface StoredJob extends TranscriptionJob {
  ownerId: string;
}

const jobs = new Map<string, StoredJob>();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toPublic(job: StoredJob): TranscriptionJob {
  const { ownerId: _ownerId, ...rest } = job;
  return { ...rest };
}

async function requireOwnedJob(jobId: string, ownerId: string): Promise<StoredJob> {
  const job = jobs.get(jobId);
  if (!job || job.ownerId !== ownerId) {
    throw new TranscribeApiError({ error: "Job not found.", code: "NOT_FOUND" });
  }
  return job;
}

async function runJob(job: StoredJob, audioEmpty: boolean) {
  const stages: { status: JobStatus; ms: number }[] = [
    { status: "preparing", ms: 500 },
    { status: "uploading", ms: 400 },
    { status: "transcribing", ms: 1300 },
  ];

  for (const stage of stages) {
    await delay(stage.ms);
    // Job may have been deleted or retried away mid-flight.
    if (jobs.get(job.jobId) !== job) return;
    job.status = stage.status;
  }

  await delay(300);
  if (jobs.get(job.jobId) !== job) return;

  if (audioEmpty) {
    job.status = "failed";
    job.error = { code: "INVALID_AUDIO", message: "That audio couldn't be processed." };
    return;
  }

  const transcription = createMockTranscription(job.ownerId);
  autoStartSoapGeneration(transcription.id, job.ownerId);
  job.status = "completed";
  job.transcriptionId = transcription.id;
}

export const mockJobsApi: JobsApi = {
  async create(audio) {
    const ownerId = await requireUserId();
    const jobId = `job_${crypto.randomUUID()}`;
    const job: StoredJob = {
      jobId,
      status: "queued",
      progressPercent: null,
      transcriptionId: null,
      error: null,
      createdAt: new Date().toISOString(),
      ownerId,
    };
    jobs.set(jobId, job);
    runJob(job, audio.size === 0);
    return toPublic(job);
  },

  async get(jobId) {
    const ownerId = await requireUserId();
    return toPublic(await requireOwnedJob(jobId, ownerId));
  },

  async list() {
    const ownerId = await requireUserId();
    return [...jobs.values()]
      .filter((j) => j.ownerId === ownerId)
      .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
      .slice(0, 50)
      .map(toPublic);
  },

  async retry(jobId) {
    const ownerId = await requireUserId();
    const job = await requireOwnedJob(jobId, ownerId);
    if (job.status !== "failed") {
      throw new TranscribeApiError({ error: "Job is not in a failed state.", code: "INVALID_REQUEST" });
    }
    job.status = "queued";
    job.error = null;
    job.transcriptionId = null;
    runJob(job, false);
    return toPublic(job);
  },

  async remove(jobId) {
    const ownerId = await requireUserId();
    const job = await requireOwnedJob(jobId, ownerId);
    if (job.status !== "completed" && job.status !== "failed") {
      throw new TranscribeApiError({ error: "Job is still running.", code: "INVALID_REQUEST" });
    }
    jobs.delete(jobId);
  },
};
