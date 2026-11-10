import { searchArenaTeams } from './arena-team-search.mjs';
import { evaluateArenaCandidatesParallel } from './arena-team-parallel.mjs';
import { createCalculationScheduler } from './calculation-scheduler.mjs';
import { createCalculationWorkerPool } from './calculation-worker-pool.mjs';
import { createLuckEvaluator } from './arena-luck-evaluator.mjs';
let luck;
self.onmessage = async ({ data: { type, requestId, payload, workers = 1 } }) => {
  if (type === 'stop') { luck?.stop(); return; }
  try {
    if (type === 'continue') {
      const result = await luck.run({ budgetMs: 180000 });
      self.postMessage({ type: 'result', requestId, result }); return;
    }
    luck?.close(); luck = null;
    const yieldControl = createCalculationScheduler();
    const result = await searchArenaTeams(payload, { onProgress: progress => self.postMessage({ type: 'progress', requestId, progress }),
      yieldControl, onLuckSession: session => { luck = session; },
      onSnapshot: result => self.postMessage({ type: 'snapshot', requestId, result }),
      luckOptions: { createEvaluator: input => {
        const size = Math.max(1, Math.min(8, workers));
        if (size === 1) { const evaluate = createLuckEvaluator(input); return { run: task => evaluate(task, { yieldControl }), width: 1, close() {} }; }
        const pool = createCalculationWorkerPool({ size, createWorker: () => {
          const worker = new Worker(new URL('./arena-luck-task-worker.mjs', import.meta.url), { type: 'module' });
          worker.postMessage({ type: 'initialize', input }); return worker;
        } });
        return { run: task => pool.run(task), width: size, close: () => pool.close() };
      } },
      evaluateCandidates: (input, options) => evaluateArenaCandidatesParallel(input, { ...options, size: workers,
        createWorker: () => new Worker(new URL('./arena-team-task-worker.mjs', import.meta.url), { type: 'module' }) }) });
    self.postMessage({ type: 'result', requestId, result });
  } catch (error) { luck?.close(); self.postMessage({ type: 'error', requestId, error: error.message }); }
};
