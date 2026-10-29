// AgentGuard dashboard. Vanilla JS, no build step. All text goes through
// textContent (via h()), never innerHTML, so nothing from the journal can
// inject markup.

const $ = (id) => document.getElementById(id);

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const YOCTO = 10n ** 24n;
function near(yocto) {
  const v = BigInt(yocto ?? 0);
  const whole = v / YOCTO;
  const frac = (v % YOCTO).toString().padStart(24, "0").slice(0, 3).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}
const pct = (part, total) => (total === 0n ? 0 : Number((BigInt(part) * 10000n) / total) / 100);
const time = (iso) => new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const VERDICT = { allow: "Разрешено", warn: "Нужен владелец", block: "Заблокировано" };

let health = null;
let token = "";
const expanded = new Set();
const seen = new Set();

function toast(msg) {
  for (const old of document.querySelectorAll(".toast")) old.remove();
  const t = h("div", { class: "toast", role: "status" }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 4200);
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------------------------------------------------------------- mandate
const short = (s, n = 10) => (s && s.length > n + 4 ? `${s.slice(0, n)}…` : s);

function figure(k, v, unit, s) {
  return h("div", { class: "figure" },
    h("span", { class: "k" }, k),
    h("span", { class: "v" }, v, unit ? h("small", {}, unit) : null),
    s ? h("span", { class: "s" }, s) : null);
}

function renderMandate(mandates, policy, decisions) {
  const box = $("mandate");
  const m = mandates[0];
  $("freeze").setAttribute("aria-pressed", String(policy.frozen));
  $("freeze").textContent = policy.frozen ? "Разморозить выплаты" : "Заморозить выплаты";
  $("state").className = `state${policy.frozen ? " frozen" : ""}`;
  $("state").textContent = policy.frozen ? "выплаты заморожены" : "выплаты открыты";
  if (!m) {
    box.replaceChildren(h("p", { class: "empty" }, "Мандатов нет. Создайте мандат через POST /v1/mandates."));
    return;
  }
  const budget = BigInt(m.budget_yocto);
  const spent = BigInt(m.spent_yocto);
  const reserved = BigInt(m.reserved_yocto);
  const left = budget - spent - reserved;
  const mine = decisions.filter((d) => d.proposal.mandate_id === m.id);
  const allowed = mine.filter((d) => d.verdict === "allow").length;
  const blocked = mine.filter((d) => d.verdict === "block").length;
  const settled = mine.filter((d) => d.execution && (d.execution.status === "success" || d.execution.status === "pending_onchain_approval")).reverse();

  box.replaceChildren(...[
    h("h1", { class: "mandate-title" }, m.goal),
    h("p", { class: "mandate-meta" },
      h("span", {}, "мандат ", h("b", {}, m.id)),
      h("span", {}, "действует до ", h("b", {}, new Date(m.expires_at).toLocaleDateString("ru-RU"))),
      h("span", {}, "не больше ", h("b", {}, `${near(m.per_tx_max_yocto)} NEAR`), " за платёж"),
      h("span", {}, "получатели ", h("b", {}, m.allowed_receivers.join(", ")))),
    h("div", { class: "figures" },
      figure("Потрачено", near(spent), "NEAR", `из ${near(budget)} NEAR бюджета`),
      figure("В резерве", near(reserved), "NEAR", "подписи выданы, не исполнены"),
      figure("Осталось", near(left > 0n ? left : 0n), "NEAR", m.vault_remaining_yocto !== null ? `контракт видит ${near(m.vault_remaining_yocto)} NEAR` : null),
      figure("Решений", String(mine.length), null, [`разрешено ${allowed}, `, blocked ? h("b", {}, `заблокировано ${blocked}`) : "заблокировано 0"])),
    h("div", { class: "budget" },
      h("div", { class: "track", role: "img", "aria-label": `Потрачено ${near(spent)} из ${near(budget)} NEAR, в резерве ${near(reserved)}` },
        settled.map((d) => h("span", { class: "seg", style: `width:${pct(d.proposal.amount_yocto, budget)}%`, title: `${near(d.proposal.amount_yocto)} NEAR для ${d.proposal.receiver}` })),
        reserved > 0n ? h("span", { class: "res", style: `width:${pct(reserved, budget)}%` }) : null),
      h("div", { class: "scale", "aria-hidden": "true" }, h("span", {}, "0"), h("span", {}, `${near(budget / 2n)}`), h("span", {}, `${near(budget)} NEAR`))),
    policy.frozen ? h("p", { class: "frozen-banner" }, "Все выплаты заморожены. Ни AgentGuard, ни контракт не пропустят ни одного платежа.") : null,
  ].filter(Boolean));
}

// ---------------------------------------------------------------- journal
function pipClass(hit) {
  return hit.ok ? "pip" : `pip fail-${hit.severity}`;
}

function outcomeLine(d) {
  if (d.execution) {
    const ok = d.execution.status === "success";
    const text = ok
      ? `Переведено, транзакция ${short(d.execution.tx_hash, 14)}`
      : d.execution.status === "pending_onchain_approval"
        ? "Контракт ждёт одобрения владельца"
        : `Контракт отказал: ${d.execution.error}`;
    return h("span", { class: `outcome ${ok ? "ok" : "bad"}` }, text);
  }
  if (d.verdict === "allow") return h("span", { class: "outcome" }, d.authorization && d.authorization.expires_at_ms < Date.now() ? "Подпись выдана, не использована, истекла" : "Подпись выдана агенту");
  if (d.approval === "approved") return h("span", { class: "outcome ok" }, "Владелец одобрил, создано новое решение");
  if (d.approval === "rejected") return h("span", { class: "outcome bad" }, "Владелец отклонил");
  return null;
}

async function renderDetail(d, holder) {
  const full = await api("GET", `/v1/decisions/${encodeURIComponent(d.decision_id)}`);
  const result = h("span", { class: "replay-result", "aria-live": "polite" });
  const replayBtn = h("button", {
    class: "btn",
    type: "button",
    onclick: async () => {
      replayBtn.disabled = true;
      try {
        const r = await api("POST", `/v1/decisions/${encodeURIComponent(d.decision_id)}/replay`);
        result.className = `replay-result ${r.match ? "ok" : "bad"}`;
        result.textContent = r.match ? "Проверка повторена: тот же вердикт, те же правила, тот же хеш входа" : `Расхождение: вердикт ${r.replayed_verdict}, хеш входа ${r.input_hash_match ? "совпал" : "не совпал"}`;
      } catch (e) {
        toast(e.message);
      } finally {
        replayBtn.disabled = false;
      }
    },
  }, "Повторить проверку");

  const mark = (hit) => (hit.ok ? "✓" : hit.severity === "info" ? "i" : "✕");
  holder.replaceChildren(
    h("table", { class: "trace" },
      h("tbody", {}, full.rule_hits.map((hit) =>
        h("tr", { class: hit.ok ? "" : "failed" },
          h("td", { class: `mark ${hit.ok ? "ok" : `fail-${hit.severity}`}`, "aria-label": hit.ok ? "выполнено" : "нарушено" }, mark(hit)),
          h("td", { class: "rule" }, hit.rule),
          h("td", { class: "txt" }, hit.detail))))),
    h("dl", { class: "facts" },
      h("dt", {}, "Риск получателя"), h("dd", {}, `${full.input.risk.score}/100: ${full.input.risk.signals.filter((s) => s.points !== 0).map((s) => s.detail).join("; ") || "сигналов риска нет"}`),
      h("dt", {}, "Адрес взят из"), h("dd", {}, { mandate: "мандата", user: "задачи владельца", tool_output: "ответа внешнего инструмента", model: "текста модели" }[full.input.proposal.provenance] ?? full.input.proposal.provenance),
      h("dt", {}, "Слова агента"), h("dd", {}, full.input.proposal.justification || "нет", " (не влияют на решение)"),
      h("dt", {}, "Хеш входа"), h("dd", { class: "mono" }, full.input_hash),
      full.authorization ? [h("dt", {}, "Подписанное сообщение"), h("dd", { class: "mono" }, full.authorization.message)] : null),
    h("div", { class: "detail-actions" }, replayBtn, result),
  );
}

function renderJournal(decisions) {
  $("rows-empty").hidden = decisions.length > 0;
  const rows = decisions.map((d) => {
    const top = d.verdict !== "allow" ? d.reasons[0] : null;
    const holder = h("div", { class: "detail" });
    const isOpen = expanded.has(d.decision_id);
    holder.hidden = !isOpen;
    const btn = h("button", {
      class: "row-btn",
      type: "button",
      "aria-expanded": String(isOpen),
      onclick: async () => {
        const open = !expanded.has(d.decision_id);
        if (open) expanded.add(d.decision_id); else expanded.delete(d.decision_id);
        btn.setAttribute("aria-expanded", String(open));
        holder.hidden = !open;
        if (open) await renderDetail(d, holder).catch((e) => toast(e.message));
      },
    },
      h("span", { class: "when" }, time(d.created_at)),
      h("span", { class: `verdict ${d.verdict}` }, VERDICT[d.verdict]),
      h("span", { class: "what" }, h("strong", {}, `${near(d.proposal.amount_yocto)} NEAR`), h("span", { class: "to" }, ` для ${d.proposal.receiver}`)),
      h("span", { class: "pips", "aria-hidden": "true" }, d.rule_hits.map((hit) => h("span", { class: pipClass(hit), title: hit.rule }))),
      top ? h("span", { class: "reason" }, top) : null,
      outcomeLine(d));
    const li = h("li", { class: `row${seen.has(d.decision_id) ? "" : " new"}`, "data-verdict": d.verdict }, btn, holder);
    if (isOpen) renderDetail(d, holder).catch(() => {});
    return li;
  });
  decisions.forEach((d) => seen.add(d.decision_id));
  $("rows").replaceChildren(...rows);
}

// ---------------------------------------------------------------- approvals
async function renderApprovals() {
  const { approvals } = await api("GET", "/v1/approvals");
  $("approvals-empty").hidden = approvals.length > 0;
  $("approvals").replaceChildren(...approvals.map((d) => {
    const decide = (approve) => async (ev) => {
      ev.target.disabled = true;
      try {
        const r = await api("POST", `/v1/approvals/${encodeURIComponent(d.decision_id)}`, { approve });
        toast(approve ? (r.result.verdict === "allow" ? "Одобрено, агент получил подпись" : `Одобрено, но правила снова не пропустили: ${r.result.reasons[0]}`) : "Отклонено");
      } catch (e) {
        toast(e.message);
      }
      refresh();
    };
    return h("li", { class: "approval" },
      h("p", { class: "amt" }, `${near(d.proposal.amount_yocto)} NEAR `, h("span", {}, `для ${d.proposal.receiver}`)),
      h("p", { class: "why" }, d.reasons.join(". ")),
      h("div", { class: "btns" },
        h("button", { class: "btn btn-approve", type: "button", onclick: decide(true) }, "Одобрить"),
        h("button", { class: "btn btn-reject", type: "button", onclick: decide(false) }, "Отклонить")));
  }));
}

// ---------------------------------------------------------------- vault
async function renderVault() {
  const v = await api("GET", "/v1/vault");
  if (!v.contract_id) {
    $("vault").replaceChildren(h("p", { class: "hint" }, v.note || "Состояние контракта читается в эксплорере."));
    return;
  }
  const m = v.mandates[0];
  $("vault").replaceChildren(
    h("dl", { class: "vault-facts" },
      h("dt", {}, "Контракт"), h("dd", { class: "mono" }, v.contract_id),
      h("dt", {}, "Баланс"), h("dd", {}, `${near(v.balance_yocto)} NEAR`),
      h("dt", {}, "Статус"), h("dd", {}, v.frozen ? "Заморожен" : "Работает"),
      m ? [h("dt", {}, "Бюджет мандата"), h("dd", {}, `использовано ${near(m.committed)} из ${near(m.budget)} NEAR`)] : null),
    h("ul", { class: "vault-events", "aria-label": "События контракта" },
      v.events.slice(-8).reverse().map((e) => h("li", {}, `${new Date(e.at_ms).toLocaleTimeString("ru-RU")}  `, h("span", { class: "ev" }, e.event), e.data.amount ? `  ${near(e.data.amount)} NEAR` : ""))),
  );
}

// ---------------------------------------------------------------- scenarios
async function renderScenarios() {
  const { scenarios } = await api("GET", "/v1/demo/scenarios");
  $("scenarios").replaceChildren(...scenarios.map((s) => {
    const res = h("p", { class: "res", "aria-live": "polite" });
    const run = h("button", { class: "run", type: "button", "aria-label": `Запустить сценарий ${s.id}` }, "Запустить");
    run.addEventListener("click", () => runScenario(s, run, res));
    return h("li", { class: "scenario", title: s.attack }, h("span", { class: "t" }, s.title), run, h("span", { class: "e" }, s.expected), res);
  }));
}

async function runScenario(s, btn, res) {
  btn.disabled = true;
  res.className = "res";
  res.textContent = "Выполняется…";
  try {
    const r = await api("POST", `/v1/demo/scenarios/${s.id}/run`);
    res.className = `res ${r.result.passed ? "pass" : "fail"}`;
    res.textContent = `${r.result.passed ? "Как ожидалось" : "Не совпало"}: ${r.result.actual}. Остановил: ${r.result.stopped_by.join(", ")}`;
    expanded.clear();
  } catch (e) {
    res.className = "res fail";
    res.textContent = e.message;
  } finally {
    btn.disabled = false;
    refresh();
  }
  return res.className.includes("pass");
}

$("run-all").addEventListener("click", async (ev) => {
  ev.target.disabled = true;
  let pass = 0;
  const items = [...$("scenarios").children];
  const { scenarios } = await api("GET", "/v1/demo/scenarios");
  for (const [i, s] of scenarios.entries()) {
    const li = items[i];
    if (await runScenario(s, li.querySelector(".run"), li.querySelector(".res"))) pass++;
  }
  toast(`${pass} из ${scenarios.length} сценариев прошли как ожидалось`);
  ev.target.disabled = false;
});

// ---------------------------------------------------------------- agent & freeze
for (const btn of document.querySelectorAll("[data-agent]")) {
  btn.addEventListener("click", async () => {
    const log = $("agent-log");
    log.hidden = false;
    log.textContent = "Агент запущен…";
    btn.disabled = true;
    try {
      const { run_id } = await api("POST", "/v1/agent/run", { mode: btn.dataset.agent });
      for (;;) {
        await new Promise((r) => setTimeout(r, 400));
        const r = await api("GET", `/v1/agent/runs/${run_id}`);
        log.textContent = r.log.join("\n") || "Агент думает…";
        if (r.status !== "running") {
          if (r.status === "error") log.textContent += `\nОшибка: ${r.error}`;
          break;
        }
      }
    } catch (e) {
      log.textContent = e.message;
    } finally {
      btn.disabled = false;
      refresh();
    }
  });
}

$("freeze").addEventListener("click", async () => {
  const frozen = $("freeze").getAttribute("aria-pressed") !== "true";
  try {
    await api("POST", "/v1/freeze", { frozen });
    toast(frozen ? "Выплаты заморожены" : "Выплаты разморожены");
  } catch (e) {
    toast(e.message);
  }
  refresh();
});

// ---------------------------------------------------------------- boot
let pending = null;
function refresh() {
  clearTimeout(pending);
  pending = setTimeout(() => {
    Promise.all([api("GET", "/v1/mandates"), api("GET", "/v1/policy"), api("GET", "/v1/decisions")])
      .then(([{ mandates }, policy, { decisions }]) => {
        renderMandate(mandates, policy, decisions);
        renderJournal(decisions);
      })
      .then(() => Promise.all([renderApprovals(), renderVault()]))
      .catch((e) => toast(e.message));
  }, 120);
}

async function boot() {
  try {
    health = await api("GET", "/v1/health");
  } catch {
    $("env").textContent = "API недоступен. Запустите pnpm dev.";
    return;
  }
  const sim = health.mode === "sim";
  $("env").textContent = sim
    ? (globalThis.AGENTGUARD_STANDALONE
      ? "Демо в браузере. AgentGuard, ИИ-агент и симулятор контракта работают прямо на этой странице, деньги ненастоящие."
      : `Локальный режим: контракт ${health.contract_id} работает в симуляторе`)
    : `Testnet: контракт ${health.contract_id}`;
  if (sim) token = health.dev_owner_token;
  else {
    $("token-wrap").hidden = false;
    try { token = localStorage.getItem("agentguard-owner-token") || ""; } catch { token = ""; }
    $("token").value = token;
    $("token").addEventListener("change", (e) => {
      token = e.target.value;
      try { localStorage.setItem("agentguard-owner-token", token); } catch { /* storage unavailable */ }
    });
  }
  $("agent-llm").hidden = !health.llm;
  $("scenarios-wrap").hidden = !sim;
  if (sim) await renderScenarios();
  refresh();
  const es = new EventSource("/v1/events");
  es.onmessage = () => refresh();
  setInterval(refresh, 15000);
}

boot();
