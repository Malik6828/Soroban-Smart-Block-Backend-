/**
 * Ambient declaration for the optional NATS client. The `nats` package is not
 * a hard dependency (NATS JetStream is an optional distributed-processing
 * transport); this keeps typechecking green without pulling the runtime dep
 * into every install. Mirror of src/types/redis.d.ts pattern.
 *
 * Surfaces mirror nats.js v2 (NatsConnection#stats, JetStreamManager via
 * `jetstream()`, pull consumers via JetStreamClient#pull) as used by
 * src/indexer/nats-queue.ts.
 */
declare module 'nats' {
  export interface Stats {
    inBytes: number;
    outBytes: number;
    inMsgs: number;
    outMsgs: number;
    reconnects: number;
  }

  export interface NatsConnection {
    jetstream(opts?: object): JetStreamClient;
    close(): Promise<void>;
    drain(): Promise<void>;
    closed(): Promise<void>;
    isClosed(): boolean;
    stats(): Stats;
    info: unknown;
  }

  export interface StreamInfo {
    config: { name: string; subjects?: string[] };
    state: { messages: number; consumer_count: number };
  }

  /** JetStream account manager (accessed as `js.streams.*` at call sites). */
  export interface JetStreamManager {
    add(cfg?: StreamConfig): Promise<StreamInfo>;
    update(cfg?: StreamConfig): Promise<StreamInfo>;
    info(name: string): Promise<StreamInfo>;
    delete(name: string): Promise<boolean>;
    list(): { [Symbol.asyncIterator](): AsyncIterator<StreamInfo> };
  }

  export interface JetStreamClient {
    /** `js.streams.<op>()` — JetStreamManager-style access used by the queue. */
    streams: JetStreamManager;
    publish(subject: string, data?: Uint8Array, options?: object): Promise<PubAck>;
    subscribe(subject: string, options?: object): unknown;
    /**
     * Create (or attach to) a pull consumer and return its async iterator of
     * JetStream messages.
     */
    pull(
      subject: string,
      opts?: { batch?: number; max_timeout?: number; idle_heartbeat?: number; config?: object },
    ): Promise<AsyncIterable<JsMsg>>;
    deleteStream(name: string): Promise<void>;
  }

  export interface PubAck {
    stream: string;
    seq: number;
    duplicate?: boolean;
  }

  export interface JsMsg {
    data: Uint8Array;
    seq: number;
    subject: string;
    ack(): void;
    nak(delay?: number): void;
    term(): void;
  }

  export interface StreamConfig {
    name: string;
    subjects?: string[];
    retention?: 'limits' | 'workqueue' | 'interest';
    max_msg_size?: number;
    max_age?: number;
    num_replicas?: number;
    duplicate_window?: number;
    storage?: 'file' | 'memory';
    discard?: 'old' | 'new';
    description?: string;
  }

  export interface JetStreamOptions {
    name: string;
    subjects: string[];
    max_age?: number;
    max_msg_size?: number;
    duplicate_window?: number;
    max_timeout?: number;
  }

  export function connect(options: {
    servers: string[];
    timeout?: number;
    reconnect?: boolean;
    maxReconnectAttempts?: number;
    reconnectDelayHandler?: () => number;
  }): Promise<NatsConnection>;

  export function parseDuration(input: string): number;

  export function jetstream(conn: NatsConnection, opts?: object): JetStreamClient;
  export function StringCodec(): {
    encode(input: string): Uint8Array;
    decode(data: Uint8Array): string;
  };
}
