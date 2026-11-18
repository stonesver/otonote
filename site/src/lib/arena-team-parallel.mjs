import { createCalculationWorkerPool } from './calculation-worker-pool.mjs';
import { evaluateArenaCandidates } from './arena-team-search.mjs';

/** Partition complete teams; each worker retains all songs and skill orders. */
export async function evaluateArenaCandidatesParallel(input, { size, createWorker, onProgress, yieldControl }) {
  if (size < 2) return evaluateArenaCandidates(input, { onProgress, yieldControl });
  const count = Math.min(size, input.candidates.length), width = Math.ceil(input.candidates.length / count);
  const chunks = Array.from({ length: count }, (_, i) => input.candidates.slice(i * width, (i + 1) * width)).filter(c => c.length);
  const pool = createCalculationWorkerPool({ size: chunks.length, createWorker });
  const completed = chunks.map(() => 0);
  try {
    const results = await Promise.all(chunks.map((candidates, i) => pool.run({ ...input, candidates }, progress => {
      completed[i] = progress.completed;
      onProgress?.({ ...progress, completed: completed.reduce((a, b) => a + b, 0),
        total: input.candidates.length * input.songs.length, candidates: input.candidates.length, workers: chunks.length });
    })));
    return { evaluated: results.flatMap(r => r.evaluated), omitted: results.flatMap(r => r.omitted) };
  } finally { pool.close(); }
}
