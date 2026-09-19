import { USE_MOCK_TRANSCRIPTIONS } from "@/services/transcriptions/config";
import { jobsApi } from "@/services/transcriptions/jobsApi";
import { mockJobsApi } from "@/services/transcriptions/mockJobsApi";
import type { JobsApi } from "@/services/transcriptions/jobsApiTypes";

export const jobs: JobsApi = USE_MOCK_TRANSCRIPTIONS ? mockJobsApi : jobsApi;
