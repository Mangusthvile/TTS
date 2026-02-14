import { useCallback, useState } from "react";
import type { JobRecord, UiMode } from "../../../types";
import { listAllJobs, cancelJob as cancelJobService, retryJob as retryJobService, deleteJob as deleteJobService, clearJobs as clearJobsService, jobRunnerHealthCheck } from "../../../services/jobRunnerService";
import { getLogger } from "../../../utils/logger";

const jobLog = getLogger("Jobs");

export function useJobs(args: { uiMode: UiMode; refreshUploadQueueCount: () => Promise<void>; logJobs: boolean }) {
  const { uiMode, refreshUploadQueueCount, logJobs } = args;
  const [jobs, setJobs] = useState<JobRecord[]>([]);

  const refreshJobs = useCallback(async () => {
    try {
      const all = await listAllJobs(uiMode);
      setJobs(all);
      jobLog.info("refresh", {
        count: all.length,
        jobs: all.map((j) => ({
          jobId: j.jobId,
          status: j.status,
          workRequestId: (j as any).progressJson?.workRequestId ?? null,
        })),
      });
      await refreshUploadQueueCount();
      await jobRunnerHealthCheck(uiMode);
    } catch (e) {
      // ignore
    }
  }, [uiMode, refreshUploadQueueCount, logJobs]);

  const cancelJob = useCallback((jobId: string) => cancelJobService(jobId, uiMode), [uiMode]);
  const retryJob = useCallback((jobId: string) => retryJobService(jobId, uiMode), [uiMode]);
  const deleteJob = useCallback((jobId: string) => deleteJobService(jobId, uiMode), [uiMode]);
  const clearJobs = useCallback((statuses: string[]) => clearJobsService(statuses, uiMode), [uiMode]);

  return { jobs, setJobs, refreshJobs, cancelJob, retryJob, deleteJob, clearJobs };
}
