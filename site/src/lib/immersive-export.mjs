export const EXPORT_SIZE = Object.freeze({ width: 1920, height: 1080 });
export const PNG_SIZE = Object.freeze({ width: 3840, height: 2160 });

export function pngOutputSize(maxDimension = 8192) {
  if (maxDimension < EXPORT_SIZE.width) throw new Error('png-resolution-unavailable');
  return maxDimension >= PNG_SIZE.width ? PNG_SIZE : EXPORT_SIZE;
}

/** Keep export sampling independent of the preview size and device pixel ratio. */
export function pngRenderSize(maxDimension = 8192) {
  const scale = Math.min(3, Math.floor(maxDimension / EXPORT_SIZE.width));
  if (scale < 1) throw new Error('png-resolution-unavailable');
  return { width: EXPORT_SIZE.width * scale, height: EXPORT_SIZE.height * scale };
}

export function downsamplePng(source, size = PNG_SIZE) {
  const target = document.createElement('canvas');
  target.width = size.width; target.height = size.height;
  const context = target.getContext('2d', { alpha: true });
  if (!context) throw new Error('png-context-unavailable');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  // Copy synchronously, before WebGL can clear its drawing buffer. Preserve alpha.
  context.drawImage(source, 0, 0, target.width, target.height);
  return new Promise((resolve, reject) => target.toBlob(blob => {
    target.width = target.height = 1;
    if (blob) resolve(blob); else reject(new Error('png-failed'));
  }, 'image/png'));
}

/** Save the official scene poster when the reconstructed camera is approximate. */
export async function posterPng(url, { signal, fetcher = fetch, decode = createImageBitmap } = {}) {
  const response = await fetcher(url, { signal });
  if (!response.ok) throw new Error(`poster HTTP ${response.status}`);
  const image = await decode(await response.blob());
  try {
    signal?.throwIfAborted();
    const canvas = document.createElement('canvas');
    canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('png-context-unavailable');
    context.drawImage(image, 0, 0);
    const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('png-failed')), 'image/png'));
    signal?.throwIfAborted();
    return { blob, size: { width: image.width, height: image.height } };
  } finally { image.close?.(); }
}

export function webmMimeType(Recorder = globalThis.MediaRecorder) {
  if (!Recorder?.isTypeSupported) return null;
  return ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    .find(type => Recorder.isTypeSupported(type)) ?? null;
}

/** Record one real-time cycle. Cancellation never returns a partial download. */
export function recordCanvas(canvas, duration, { signal, render, progress = () => {}, Recorder = globalThis.MediaRecorder } = {}) {
  const mimeType = webmMimeType(Recorder);
  if (!mimeType || !canvas.captureStream) return Promise.reject(new Error('webm-unavailable'));
  if (signal?.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'));
  return new Promise((resolve, reject) => {
    let stream, recorder, frame, timer, started, failure, settled = false;
    const chunks = [];
    const cleanup = () => {
      cancelAnimationFrame(frame); clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (recorder?.state === 'recording') recorder.stop();
      stream?.getTracks().forEach(track => track.stop());
    };
    const finish = () => {
      if (settled) return;
      settled = true; cleanup();
      if (failure) reject(failure);
      else if (!chunks.length) reject(new Error('empty-recording'));
      else resolve(new Blob(chunks, { type: mimeType }));
    };
    const abort = () => {
      failure = new DOMException('Cancelled', 'AbortError');
      if (recorder?.state === 'recording') recorder.stop();
      else finish();
    };
    try {
      render(0);
      stream = canvas.captureStream(30);
      recorder = new Recorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = event => { failure = event.error ?? new Error('recording-failed'); finish(); };
      recorder.onstop = finish;
      recorder.onstart = () => {
        started = performance.now();
        const tick = now => {
          if (settled || failure) return;
          const time = Math.min((now - started) / 1000, duration);
          try { render(Math.min(time, duration - 1 / 120)); progress(time / duration); }
          catch (error) { failure = error; finish(); return; }
          if (time >= duration) recorder.stop();
          else frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
      };
      signal?.addEventListener('abort', abort, { once: true });
      // A lost context or suspended tab must not leave a recording running forever.
      timer = setTimeout(abort, duration * 1000 + 10_000);
      recorder.start(250);
    } catch (error) { failure = error; finish(); }
  });
}
