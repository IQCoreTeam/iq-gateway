// In-process job queue for RPC-heavy work (Helius gTFA, batch tx, signature scans).
//
// Replaces the old token-bucket limiter. Two priorities so an interactive
// route never sits behind a backfill scan. Live tunables exposed via the
// admin route — operators can adjust concurrency/minTime without restart
// when Helius latency or rate-limit headroom changes.
//
// Persistence: none. If the process dies, in-flight RPC fetches re-run on
// the next request — they are idempotent reads against on-chain data.

export type Priority = "interactive" | "background";

interface PendingJob<T> {
  run: () => Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
  enqueuedAt: number;
}

interface QueueConfig {
  concurrency: number;
  minTimeMs: number;
  maxDepth: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const config: QueueConfig = {
  concurrency: envInt("QUEUE_CONCURRENCY", 50),
  minTimeMs: envInt("QUEUE_MIN_TIME_MS", 20),
  maxDepth: envInt("QUEUE_MAX_DEPTH", 1000),
};

const interactiveQueue: PendingJob<unknown>[] = [];
const backgroundQueue: PendingJob<unknown>[] = [];
let inFlight = 0;
let lastDispatchAt = 0;

const metrics = {
  enqueued: 0,
  completed: 0,
  rejected: 0,
  failed: 0,
  maxWaitMs: 0,
};

function nextJob(): PendingJob<unknown> | undefined {
  return interactiveQueue.shift() ?? backgroundQueue.shift();
}

function schedule(): void {
  while (inFlight < config.concurrency) {
    const job = nextJob();
    if (!job) return;

    const wait = Date.now() - job.enqueuedAt;
    if (wait > metrics.maxWaitMs) metrics.maxWaitMs = wait;

    const now = Date.now();
    const sinceLast = now - lastDispatchAt;
    const delay = sinceLast >= config.minTimeMs ? 0 : config.minTimeMs - sinceLast;
    lastDispatchAt = now + delay;
    inFlight++;

    const fire = () => {
      job.run()
        .then((v) => { metrics.completed++; job.resolve(v); })
        .catch((e) => { metrics.failed++; job.reject(e); })
        .finally(() => {
          inFlight--;
          schedule();
        });
    };
    if (delay === 0) fire();
    else setTimeout(fire, delay);
  }
}

export function enqueueRpc<T>(priority: Priority, run: () => Promise<T>): Promise<T> {
  const queue = priority === "interactive" ? interactiveQueue : backgroundQueue;
  const totalDepth = interactiveQueue.length + backgroundQueue.length;

  if (totalDepth >= config.maxDepth) {
    metrics.rejected++;
    return Promise.reject(new Error(`queue full (depth=${totalDepth}, max=${config.maxDepth})`));
  }

  metrics.enqueued++;
  return new Promise<T>((resolve, reject) => {
    queue.push({
      run: run as () => Promise<unknown>,
      resolve: resolve as (v: unknown) => void,
      reject,
      enqueuedAt: Date.now(),
    });
    schedule();
  });
}

export function getQueueConfig(): QueueConfig {
  return { ...config };
}

export function setQueueConfig(patch: Partial<QueueConfig>): QueueConfig {
  if (patch.concurrency !== undefined) {
    if (!Number.isInteger(patch.concurrency) || patch.concurrency < 1) {
      throw new Error("concurrency must be a positive integer");
    }
    config.concurrency = patch.concurrency;
  }
  if (patch.minTimeMs !== undefined) {
    if (!Number.isFinite(patch.minTimeMs) || patch.minTimeMs < 0) {
      throw new Error("minTimeMs must be a non-negative number");
    }
    config.minTimeMs = patch.minTimeMs;
  }
  if (patch.maxDepth !== undefined) {
    if (!Number.isInteger(patch.maxDepth) || patch.maxDepth < 1) {
      throw new Error("maxDepth must be a positive integer");
    }
    config.maxDepth = patch.maxDepth;
  }
  // A raised concurrency may unblock waiting jobs.
  schedule();
  return { ...config };
}

export function getQueueStats() {
  return {
    config: { ...config },
    pending: {
      interactive: interactiveQueue.length,
      background: backgroundQueue.length,
    },
    inFlight,
    metrics: { ...metrics },
  };
}
