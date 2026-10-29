/**
 * Runs the real AgentGuard HTTP handler inside the page.
 *
 * The dashboard (apps/web/app.js) talks to `/v1/*` with fetch and listens
 * on an EventSource. Here both are routed to `createApp(...)` from
 * apps/api — the same handler the Node server uses — wired to a fresh demo
 * world: Guard, Policy Engine, Risk Monitor, vault simulator and agent.
 * Nothing leaves the browser.
 */
import { createApp, bus, type AppContext } from "../../api/src/app.ts";
import { createWorld, type World } from "../../../attacks/world.ts";

let world: World = createWorld();

const ctx: AppContext = {
  mode: "sim",
  ownerToken: "dev-owner-token",
  agentToken: null,
  webDir: "",
  llm: null,
  current: () => ({ guard: world.guard, store: world.store, client: world.client, executor: world.executor, facts: world.facts, vault: world.vault, world }),
  resetWorld: () => {
    world = createWorld({ signer: world.signer });
  },
};

const handle = createApp(ctx);
const realFetch = globalThis.fetch.bind(globalThis);

function headerRecord(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(h ?? {}).forEach((v, k) => (out[k] = v));
  return out;
}

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw, location.href);
  if (url.origin !== location.origin || !url.pathname.startsWith("/v1/")) return realFetch(input, init);

  const body = typeof init?.body === "string" ? [new TextEncoder().encode(init.body)] : [];
  const req = {
    method: (init?.method ?? "GET").toUpperCase(),
    url: url.pathname + url.search,
    headers: headerRecord(init?.headers),
    on() {},
    async *[Symbol.asyncIterator]() {
      yield* body;
    },
  };

  return new Promise<Response>((resolve) => {
    let status = 200;
    let headers: Record<string, string> = {};
    const chunks: string[] = [];
    const res = {
      writeHead(s: number, h?: Record<string, string>) {
        status = s;
        headers = h ?? {};
      },
      write(c: string) {
        chunks.push(c);
      },
      end(c?: string | Uint8Array) {
        if (typeof c === "string") chunks.push(c);
        resolve(new Response(chunks.join(""), { status, headers }));
      },
    };
    void (handle as unknown as (q: typeof req, s: typeof res) => Promise<void>)(req, res);
  });
};

/** The dashboard only uses `onmessage` as a "something changed" signal. */
class InPageEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  private readonly listener = (e: unknown) => setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: (e as { type?: string }).type ?? "event" }) }), 0);
  constructor() {
    bus.on("event", this.listener);
  }
  close() {
    bus.off("event", this.listener);
  }
}
(globalThis as unknown as { EventSource: unknown }).EventSource = InPageEventSource;
(globalThis as unknown as { AGENTGUARD_STANDALONE: boolean }).AGENTGUARD_STANDALONE = true;
