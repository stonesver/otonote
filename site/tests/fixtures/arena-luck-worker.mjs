import { parentPort } from 'node:worker_threads';
globalThis.self = { postMessage: (value, transfer) => parentPort.postMessage(value, transfer) };
await import('../../src/lib/arena-luck-task-worker.mjs');
parentPort.on('message', data => self.onmessage({ data }));
