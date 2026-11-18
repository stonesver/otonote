import { evaluateArenaCandidates } from './arena-team-search.mjs';
import { createCalculationScheduler } from './calculation-scheduler.mjs';

self.onmessage = async ({ data: { id, task } }) => {
  try {
    const result = await evaluateArenaCandidates(task, { yieldControl: createCalculationScheduler(),
      onProgress: progress => self.postMessage({ id, type: 'progress', progress }) });
    self.postMessage({ id, type: 'result', result });
  } catch (error) { self.postMessage({ id, type: 'error', message: error.message }); }
};
