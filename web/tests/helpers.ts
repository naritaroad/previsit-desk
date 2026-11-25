import { vi } from "vitest";

import { type Env, FakePage } from "../src/data/core/env.ts";
import { type KV, MemoryKV } from "../src/data/core/kv.ts";
import { type ChannelFactory, type Elect, memoryChannels, memoryElections } from "../src/data/core/tabs.ts";
import type { MockConfig } from "../src/mocks/config.ts";
import type { MockServer } from "../src/mocks/core.ts";
import { createMockServer, installFetch } from "../src/mocks/start.ts";
import { TurnRunner } from "../src/mocks/turns.ts";

/** A browser shared by several "tabs": same storage, channels and elections, separate page state. */
export interface Browser {
  kv: KV;
  channel: ChannelFactory;
  elect: Elect;
  tab(): Env & { page: FakePage };
}
export function browser(kv: KV = new MemoryKV()): Browser {
  const channel = memoryChannels();
  const elect = memoryElections();
  return {
    kv,
    channel,
    elect,
    tab: () => ({ kv, channel, elect, page: new FakePage(), now: () => Date.now(), random: () => 0 }),
  };
}

export interface Mock {
  server: MockServer;
  runner: TurnRunner;
  stop: () => void;
}
/** The mock server behind this realm's fetch, without latency and with instant turns. */
export function mock(config: Partial<MockConfig> = {}): Mock {
  const server = createMockServer({ config: { latency: 0, pace: 0, ...config } });
  const runner = new TurnRunner(server);
  const undo = installFetch(server);
  return {
    server,
    runner,
    stop: () => {
      undo();
      runner.stop();
      server.closeStreams();
      server.live.close();
    },
  };
}

export const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Waits (real time) until the assertion stops throwing. */
export function until(assertion: () => void, timeout = 6000): Promise<void> {
  return vi.waitFor(assertion, { timeout, interval: 10 });
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
export function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
