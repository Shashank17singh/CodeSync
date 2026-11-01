import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client'

const LATENCY_BUCKETS = [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 1]

export interface MetricSources {
  activeRooms: () => number
  connections: () => number
}

export class CollabMetrics {
  readonly registry = new Registry()
  // Time on this server, from a frame arriving to its fan-out being written. The latency a user
  // sees also includes the network, and the load test measures that end to end.
  readonly frameSeconds = new Histogram({
    name: 'codesync_collab_frame_seconds',
    help: 'Time spent handling one client frame',
    buckets: LATENCY_BUCKETS,
    registers: [this.registry],
  })
  readonly frames = new Counter({
    name: 'codesync_collab_frames_total',
    help: 'Client frames accepted',
    registers: [this.registry],
  })
  readonly rejected = new Counter({
    name: 'codesync_collab_rejected_total',
    help: 'Client frames refused, by reason',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  })

  constructor(sources: MetricSources) {
    collectDefaultMetrics({ register: this.registry })
    new Gauge({
      name: 'codesync_collab_active_rooms',
      help: 'Rooms open on this instance',
      registers: [this.registry],
      collect() {
        this.set(sources.activeRooms())
      },
    })
    new Gauge({
      name: 'codesync_collab_connected_users',
      help: 'WebSocket connections on this instance',
      registers: [this.registry],
      collect() {
        this.set(sources.connections())
      },
    })
  }
}
