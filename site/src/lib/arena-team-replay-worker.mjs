import { calculateArenaTeamReplay } from './arena-team-replay.mjs';

self.onmessage = ({ data: { requestId, payload } }) => {
  try {
    const result = calculateArenaTeamReplay(payload);
    self.postMessage({ type: 'result', requestId, result });
  } catch (error) {
    self.postMessage({ type: 'error', requestId, error: error.message });
  }
};
