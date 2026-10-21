"""Short-lived read snapshots; mutations always use the live repository."""
import threading
import time


class ArchiveSnapshot:
    def __init__(self, read, *, ttl=30, clock=time.monotonic):
        self.read, self.ttl, self.clock = read, ttl, clock
        self.lock = threading.Lock()
        self.value, self.expires = None, 0

    def get(self):
        # Single flight: concurrent cold reads share one R2 download/parse.
        with self.lock:
            if self.value is not None and self.clock() < self.expires:
                return self.value
            self.value = None
            state = self.read()
            # Full source baselines are for detection, never for the admin UI.
            state.pop('baselines', None)
            state.pop('leases', None)
            self.value = state
            self.expires = self.clock() + self.ttl
            return state

    def invalidate(self):
        with self.lock:
            self.value, self.expires = None, 0
