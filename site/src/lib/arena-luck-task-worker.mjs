import { createLuckEvaluator } from './arena-luck-evaluator.mjs';
import { createCalculationScheduler } from './calculation-scheduler.mjs';
let evaluate;
self.onmessage = async ({ data }) => {
  if (data.type === 'initialize') { evaluate = createLuckEvaluator(data.input); return; }
  try {
    const result = await evaluate(data.task, { yieldControl: createCalculationScheduler() });
    self.postMessage({ id: data.id, type: 'result', result }, result.rows?.map(row => row.packed.buffer) ?? []);
  } catch (error) { self.postMessage({ id: data.id, type: 'error', message: error.message }); }
};
