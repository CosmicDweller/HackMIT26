import { useEffect, useState } from "react";
import { jobs as jobsApi } from "@/services/transcriptions/jobsService";
import type { TranscriptionJob } from "@/types";

const ACTIVE_STATUSES = new Set(["queued", "preparing", "uploading", "transcribing"]);

/** Jobs still in flight — lets the doctor find and reopen an unfinished job after navigating away. */
export function useActiveJobs() {
  const [activeJobs, setActiveJobs] = useState<TranscriptionJob[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    jobsApi
      .list()
      .then((list) => {
        if (!cancelled) setActiveJobs(list.filter((j) => ACTIVE_STATUSES.has(j.status)));
      })
      .catch(() => {
        if (!cancelled) setActiveJobs([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return activeJobs;
}
