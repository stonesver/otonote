import { sampleArenaLuckSong } from './arena-luck-distribution.mjs';
import { createCalculationScheduler } from './calculation-scheduler.mjs';

self.onmessage = async ({ data }) => {
  try {
    const result = await sampleArenaLuckSong(data, {
      yieldControl: createCalculationScheduler(),
      onProgress: progress => self.postMessage({ type: 'progress', progress })
    });
    self.postMessage({ type: 'result', result });
  } catch (error) { self.postMessage({ type: 'error', error: error.message }); }
};
