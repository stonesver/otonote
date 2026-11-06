import { searchArenaTeams } from './arena-team-search.mjs';
import { evaluateArenaCandidatesParallel } from './arena-team-parallel.mjs';
import { createCalculationScheduler } from './calculation-scheduler.mjs';
self.onmessage = async ({ data: { requestId, payload, workers = 1 } }) => {
  try {
    const result = await searchArenaTeams(payload, { onProgress: progress => self.postMessage({ type: 'progress', requestId, progress }),
      yieldControl: createCalculationScheduler(),
      evaluateCandidates: (input, options) => evaluateArenaCandidatesParallel(input, { ...options, size: workers,
        createWorker: () => new Worker(new URL('./arena-team-task-worker.mjs', import.meta.url), { type: 'module' }) }) });
    self.postMessage({ type: 'result', requestId, result });
  } catch (error) { self.postMessage({ type: 'error', requestId, error: error.message }); }
};
