/** Export only public artwork on this site; never load account-supplied URLs. */
export function shareArtworkUrl(value, base = globalThis.location?.href) {
  if (typeof value !== 'string' || !value || !base) return null;
  try {
    const url = new URL(value, base), origin = new URL(base);
    return ['http:', 'https:'].includes(url.protocol) && url.origin === origin.origin
      && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function loadImage(url, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const image = new Image();
    const finish = (value, error) => {
      clearTimeout(timer);signal?.removeEventListener('abort', abort);
      image.onload = image.onerror = null;
      if (!value) image.src = '';
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(null, new DOMException('图片生成已取消。', 'AbortError'));
    const timer = setTimeout(() => finish(null), 5000);
    signal?.addEventListener('abort', abort, {once:true});
    image.crossOrigin = 'anonymous';image.referrerPolicy = 'no-referrer';image.decoding = 'async';
    image.onload = () => finish(image.naturalWidth && image.naturalHeight ? image : null);
    image.onerror = () => finish(null);
    image.src = url;
  });
}

export async function loadShareArtwork(card, {signal} = {}) {
  const urls = [...new Set([card.artwork,card.image].map(value => shareArtworkUrl(value)).filter(Boolean))];
  for (const url of urls) {
    const image = await loadImage(url, signal);
    if (image) return image;
  }
  signal?.throwIfAborted();
  return null;
}
