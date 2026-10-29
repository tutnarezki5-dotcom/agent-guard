import type { ActionProposal, Category, Mandate } from "../../../packages/schema/src/index.ts";
import { CATEGORIES, nearToYocto } from "../../../packages/schema/src/index.ts";
import { guardedPay, type Executor, type GuardClient, type GuardedPayResult } from "../../../packages/sdk/src/index.ts";

/**
 * The AI agent. It plans with an LLM through tool calls, but it holds no
 * signing power: every payment goes through `guardedPay` → AgentGuard →
 * vault. Provenance of each receiver address is decided HERE, by the
 * runtime, from what the agent actually saw — never by the model.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ModelTurn {
  content: string;
  tool_calls: ToolCall[];
}

export interface Model {
  readonly name: string;
  next(messages: ChatMessage[], tools: ToolSpec[]): Promise<ModelTurn>;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** The agent's view of the web. In the demo it is a fixed map; it may contain attacks. */
export type Web = (url: string) => Promise<string>;

export const TOOLS: ToolSpec[] = [
  {
    name: "http_get",
    description: "Fetch a web page or API document and return its text.",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "propose_payment",
    description: "Propose a NEAR payment. AgentGuard decides; you will get the verdict and reasons back.",
    parameters: {
      type: "object",
      properties: {
        receiver: { type: "string", description: "NEAR account id" },
        amount_near: { type: "string", description: "Decimal NEAR amount, e.g. \"0.2\"" },
        category: { type: "string", enum: [...CATEGORIES] },
        justification: { type: "string" },
      },
      required: ["receiver", "amount_near", "category", "justification"],
    },
  },
  {
    name: "finish",
    description: "Stop and report the outcome to the owner.",
    parameters: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
  },
];

export interface AgentRunOptions {
  task: string;
  mandate: Mandate;
  model: Model;
  guard: GuardClient;
  executor: Executor;
  web: Web;
  maxSteps?: number;
  onWarn?: "wait" | "return";
  log?: (line: string) => void;
}

export interface AgentRunResult {
  summary: string;
  payments: GuardedPayResult[];
  transcript: ChatMessage[];
}

export async function runAgent(o: AgentRunOptions): Promise<AgentRunResult> {
  const log = o.log ?? (() => {});
  const seenToolOutput: string[] = [];
  const payments: GuardedPayResult[] = [];
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "You are a purchasing agent. You may only spend through the propose_payment tool.",
        `Mandate ${o.mandate.id}: ${o.mandate.goal}.`,
        `Allowed receivers: ${o.mandate.allowed_receivers.join(", ")}. Allowed categories: ${o.mandate.allowed_categories.join(", ")}.`,
        "AgentGuard checks every payment. If it blocks one, do not try to work around it; report back with finish.",
      ].join("\n"),
    },
    { role: "user", content: o.task },
  ];

  for (let step = 0; step < (o.maxSteps ?? 8); step++) {
    const turn = await o.model.next(messages, TOOLS);
    messages.push({ role: "assistant", content: turn.content, tool_calls: turn.tool_calls });
    if (turn.tool_calls.length === 0) return { summary: turn.content, payments, transcript: messages };

    for (const call of turn.tool_calls) {
      let result: string;
      if (call.name === "finish") {
        const summary = String(call.arguments.summary ?? "");
        log(`agent: finish — ${summary}`);
        return { summary, payments, transcript: messages };
      } else if (call.name === "http_get") {
        const url = String(call.arguments.url ?? "");
        result = await o.web(url).catch((e: unknown) => `ERROR: ${e instanceof Error ? e.message : String(e)}`);
        seenToolOutput.push(result);
        log(`agent: http_get ${url}`);
      } else if (call.name === "propose_payment") {
        result = await proposePayment(call.arguments, o, seenToolOutput, payments, log);
      } else {
        result = `ERROR: unknown tool ${call.name}`;
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }
  return { summary: "stopped: step limit reached", payments, transcript: messages };
}

/** Runtime-side provenance: where did this address come from? */
export function provenanceOf(receiver: string, mandate: Mandate, task: string, toolOutputs: string[]): ActionProposal["provenance"] {
  if (mandate.allowed_receivers.includes(receiver)) return "mandate";
  if (toolOutputs.some((t) => t.includes(receiver))) return "tool_output";
  if (task.includes(receiver)) return "user";
  return "model";
}

async function proposePayment(args: Record<string, unknown>, o: AgentRunOptions, toolOutputs: string[], payments: GuardedPayResult[], log: (l: string) => void): Promise<string> {
  const receiver = String(args.receiver ?? "");
  let amount_yocto: string;
  try {
    amount_yocto = nearToYocto(String(args.amount_near ?? ""));
  } catch {
    return "ERROR: amount_near must be a decimal string like \"0.2\"";
  }
  const proposal = {
    mandate_id: o.mandate.id,
    action: "transfer",
    receiver,
    amount_yocto,
    category: (CATEGORIES as readonly string[]).includes(String(args.category)) ? (args.category as Category) : "other",
    justification: String(args.justification ?? ""),
    provenance: provenanceOf(receiver, o.mandate, o.task, toolOutputs),
  };
  try {
    const r = await guardedPay(proposal, { guard: o.guard, executor: o.executor, onWarn: o.onWarn ?? "wait" });
    payments.push(r);
    log(`agent: propose ${args.amount_near} NEAR → ${receiver}: ${r.status} (${r.decision.verdict})`);
    if (r.status === "executed") {
      return `${r.execution.status === "success" ? "PAID" : `NOT PAID (${r.execution.status})`}. tx=${r.execution.tx_hash ?? "-"} ${r.execution.error ?? ""}`.trim();
    }
    return `${r.status.toUpperCase()}. AgentGuard reasons: ${r.decision.reasons.join(" | ")}`;
  } catch (e) {
    return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
  }
}
