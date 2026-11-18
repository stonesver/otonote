import type {OptimizerCommand, OptimizerMessage} from './optimizer-types.ts';

export function createOptimizerWorker() {
  return new Worker(new URL('../production-optimizer-worker.ts', import.meta.url), {type: 'module'});
}
export function sendOptimizerCommand(worker: Pick<Worker, 'postMessage'>, command: OptimizerCommand): void {
  worker.postMessage(command);
}
export function receiveOptimizerMessages(worker: Worker, receive: (message: OptimizerMessage) => void): void {
  worker.onmessage = (event: MessageEvent<OptimizerMessage>) => receive(event.data);
}
