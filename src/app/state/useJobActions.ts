import { useCallback } from "react";
import type { AppState } from "../../../types";
import {
  cancelJob as cancelJobService,
  retryJob as retryJobService,
  deleteJob as deleteJobService,
  clearJobs as clearJobsService,
  forceStartJob as forceStartJobService,
  getJobById,
  getWorkInfo,
} from "../../../services/jobRunnerService";

export function useJobActions(opts: {
  stateRef: React.MutableRefObject<AppState>;
  refreshJobs: () => Promise<void>;
  setJobs: React.Dispatch<React.SetStateAction<import("../../../types").JobRecord[]>>;
  pushNotice: (n: {
    message: string;
    type: "info" | "success" | "error" | "reconnect";
    ms?: number;
  }) => void;
}) {
  const { stateRef, refreshJobs, setJobs, pushNotice } = opts;

  const getUiMode = useCallback(() => stateRef.current.readerSettings.uiMode, [stateRef]);

  const handleCancelJob = useCallback(
    async (jobId: string) => {
      try {
        await cancelJobService(jobId, getUiMode());
        await refreshJobs();
        pushNotice({ type: "info", message: "Job canceled" });
      } catch (e: any) {
        pushNotice({
          type: "error",
          message: `Cancel failed: ${String(e?.message ?? e) || "An error occurred"}`,
        });
      }
    },
    [refreshJobs, pushNotice, stateRef, getUiMode]
  );

  const handleRetryJob = useCallback(
    async (jobId: string) => {
      try {
        await retryJobService(jobId, getUiMode());
        await refreshJobs();
        pushNotice({ type: "success", message: "Job retried" });
      } catch (e: any) {
        pushNotice({
          type: "error",
          message: `Retry failed: ${String(e?.message ?? e) || "An error occurred"}`,
        });
      }
    },
    [refreshJobs, pushNotice, stateRef, getUiMode]
  );

  const handleDeleteJob = useCallback(
    async (jobId: string) => {
      try {
        await deleteJobService(jobId, getUiMode());
        await refreshJobs();
      } catch (e: any) {
        pushNotice({
          type: "error",
          message: `Remove failed: ${String(e?.message ?? e) || "An error occurred"}`,
        });
      }
    },
    [refreshJobs, pushNotice, stateRef, getUiMode]
  );

  const handleRefreshSingleJob = useCallback(
    async (jobId: string) => {
      try {
        const job = await getJobById(jobId, getUiMode());
        if (job) {
          setJobs((prev) => {
            const idx = prev.findIndex((j) => j.jobId === jobId);
            if (idx === -1) return prev;
            const copy = [...prev];
            copy[idx] = job;
            return copy;
          });
        } else {
          await refreshJobs();
        }
      } catch {
        await refreshJobs();
      }
    },
    [refreshJobs, setJobs, getUiMode]
  );

  const handleForceStartJob = useCallback(
    async (jobId: string) => {
      try {
        await forceStartJobService(jobId, getUiMode());
        await refreshJobs();
      } catch (e: any) {
        pushNotice({
          type: "error",
          message: `Force start failed: ${String(e?.message ?? e) || "An error occurred"}`,
        });
      }
    },
    [refreshJobs, pushNotice, stateRef, getUiMode]
  );

  const handleShowWorkInfo = useCallback(
    async (jobId: string) => {
      try {
        const info = await getWorkInfo(jobId, getUiMode());
        alert(`WorkInfo for ${jobId}:\n${JSON.stringify(info, null, 2)}`);
      } catch (e: any) {
        pushNotice({
          type: "error",
          message: `WorkInfo failed: ${String(e?.message ?? e) || "An error occurred"}`,
        });
      }
    },
    [pushNotice, getUiMode]
  );

  const handleClearJobs = useCallback(
    async (statuses: string[]) => {
      try {
        await clearJobsService(statuses, getUiMode());
        await refreshJobs();
      } catch {
        // ignore
      }
    },
    [refreshJobs, getUiMode]
  );

  return {
    handleCancelJob,
    handleRetryJob,
    handleDeleteJob,
    handleRefreshSingleJob,
    handleForceStartJob,
    handleShowWorkInfo,
    handleClearJobs,
  };
}
