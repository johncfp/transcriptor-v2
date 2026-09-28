import { useEffect, useState } from "react";
import type { Job } from "../../shared/jobs";

/** The live job list, kept in sync with the main process. */
export function useJobs(): Job[] | null {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  useEffect(() => {
    let active = true;
    void window.api.listJobs().then((j) => active && setJobs(j));
    // Copy the array: the main process sends the same list object each time.
    const off = window.api.onJobsChanged((j) => setJobs([...j]));
    return () => {
      active = false;
      off();
    };
  }, []);
  return jobs;
}
