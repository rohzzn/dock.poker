export function createRateLimiter({ windowMs, maxRequests, buildMessage }) {
  const buckets = new Map();

  function cleanup(now = Date.now()) {
    for (const [key, bucket] of buckets.entries()) {
      if (now - bucket.windowStartedAt >= windowMs) {
        buckets.delete(key);
      }
    }
  }

  const cleanupTimer = setInterval(() => {
    cleanup();
  }, windowMs);

  cleanupTimer.unref?.();

  return function rateLimit(request, response, next) {
    const key = request.ip || request.socket.remoteAddress || "unknown";
    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || now - bucket.windowStartedAt >= windowMs) {
      buckets.set(key, {
        count: 1,
        windowStartedAt: now
      });
      next();
      return;
    }

    if (bucket.count >= maxRequests) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.windowStartedAt + windowMs - now) / 1000));
      response.set("Retry-After", String(retryAfterSeconds));
      response.status(429).json({
        message: buildMessage(retryAfterSeconds)
      });
      return;
    }

    bucket.count += 1;
    next();
  };
}
