<script lang="ts">
  import { onMount } from "svelte";

  const ARC_EXPLORER = "https://testnet.arcscan.app/tx/";
  const ARB_SEPOLIA_EXPLORER = "https://sepolia.arbiscan.io/tx/";
  const BASE_SEPOLIA_EXPLORER = "https://sepolia.basescan.org/tx/";
  const REFRESH_MS = 2000;

  type AnyRecord = Record<string, any>;
  type ConnectionMode = "live" | "dead" | "idle";
  type ConfirmAction = {
    title: string;
    body: string;
    confirmLabel: string;
    run: () => Promise<void>;
  };

  let state: AnyRecord | null = null;
  let refreshing = false;
  let connectionMode: ConnectionMode = "idle";
  let connectionText = "connecting";
  let errorText = "";
  let copyStatus = "";
  let confirmAction: ConfirmAction | null = null;
  let actionBusy = "";
  let nebiusHealth: AnyRecord | null = null;
  let nebiusBusy = "";

  $: now = state?.now_ms || Date.now();
  $: account = state?.account || {};
  $: risk = state?.risk || {};
  $: wallet = state?.agent_wallet || {};
  $: spend = Array.isArray(wallet.spend) ? wallet.spend : [];
  $: paidSpend = spend.filter((item: AnyRecord) => item.status === "paid");
  $: spendTotal = paidSpend.reduce((sum: number, item: AnyRecord) => sum + Number(item.amount_usdc || 0), 0);
  $: counters = state?.counters || {};
  $: traces = Array.isArray(state?.traces) ? state.traces : [];
  $: trades = traces.filter((trace: AnyRecord) => trace.side !== "hold");
  $: cctp = state?.cctp || {};
  $: cctpBridges = Array.isArray(cctp.bridges) ? cctp.bridges : [];
  $: circleBridge = state?.circle_bridge || {};
  $: circleBridgeRoute = circleBridge.route || {};
  $: circleTransfers = Array.isArray(circleBridge.transfers) ? circleBridge.transfers : [];
  $: dailyPnl = Number(risk.daily_pnl_usd || 0);
  $: lossLimit = Math.abs(Number(risk.daily_loss_threshold_usd || 0));
  $: pnlFillPct = lossLimit > 0 ? Math.min(100, Math.max(0, ((lossLimit + dailyPnl) / lossLimit) * 100)) : 0;
  $: pnlFillColor = pnlFillPct > 50 ? "var(--green)" : pnlFillPct > 20 ? "var(--amber)" : "var(--red)";
  $: accountReady = Number(account.value_usd || 0) > 0;
  $: walletReady = Boolean(wallet.address && wallet.chain);
  $: nebiusReady = Boolean(nebiusHealth?.models_endpoint?.model_available);
  $: nebiusLiveOk = nebiusHealth?.live_completion ? Boolean(nebiusHealth.live_completion.ok) : null;
  $: loopBlockedReason = !accountReady
    ? "HL_EMPTY"
    : !walletReady
      ? "WALLET_MISSING"
      : !nebiusReady
        ? "NEBIUS_MODEL_MISSING"
        : risk.kill_switch_tripped
          ? "RISK_HALTED"
          : "";
  $: loopState = loopBlockedReason ? "blocked" : "ready";
  $: loopStateText = loopBlockedReason || "READY";

  onMount(() => {
    void refresh();
    void refreshNebiusHealth(false);
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => window.clearInterval(timer);
  });

  async function refresh(): Promise<void> {
    if (refreshing) return;
    refreshing = true;
    try {
      const response = await fetch("/state", { cache: "no-store" });
      if (!response.ok) throw new Error("state endpoint returned " + response.status);
      state = await response.json() as AnyRecord;
      connectionMode = "live";
      connectionText = "live";
      errorText = "";
    } catch (error) {
      connectionMode = "dead";
      connectionText = "disconnected";
      errorText = error instanceof Error ? error.message : String(error);
    } finally {
      refreshing = false;
    }
  }

  async function refreshNebiusHealth(live = false): Promise<void> {
    nebiusBusy = live ? "live" : "models";
    try {
      const response = await fetch(`/nebius/health${live ? "?live=1" : ""}`, { cache: "no-store" });
      nebiusHealth = await response.json() as AnyRecord;
    } catch (error) {
      nebiusHealth = {
        enabled: true,
        models_endpoint: {
          ok: false,
          model_available: false,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    } finally {
      nebiusBusy = "";
    }
  }

  function ask(action: ConfirmAction): void {
    confirmAction = action;
  }

  async function runConfirmed(): Promise<void> {
    if (!confirmAction) return;
    const action = confirmAction;
    confirmAction = null;
    await action.run();
  }

  async function triggerCctp(): Promise<void> {
    actionBusy = "cctp";
    try {
      const response = await fetch("/cctp/trigger?amount_usdc=1.0", { method: "POST" });
      const body = await response.json() as AnyRecord;
      if (!response.ok || !body.ok) throw new Error(body.error || "bridge request failed");
      await refresh();
    } catch (error) {
      connectionMode = "dead";
      connectionText = "bridge error";
      errorText = error instanceof Error ? error.message : String(error);
    } finally {
      actionBusy = "";
    }
  }

  async function triggerCircleBridge(): Promise<void> {
    actionBusy = "circle-bridge";
    try {
      const response = await fetch("/circle-bridge/trigger?amount_usdc=1.0", { method: "POST" });
      const body = await response.json() as AnyRecord;
      if (!response.ok || !body.ok) throw new Error(body.error || "bridge request failed");
      await refresh();
    } catch (error) {
      connectionMode = "dead";
      connectionText = "bridge error";
      errorText = error instanceof Error ? error.message : String(error);
    } finally {
      actionBusy = "";
    }
  }

  async function copy(value: unknown): Promise<void> {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(String(value));
      copyStatus = "Copied";
    } catch {
      copyStatus = "Copy failed";
    }
  }

  function money(value: unknown, dp = 2): string {
    const n = Number(value);
    if (!Number.isFinite(n)) return "--";
    const sign = n < 0 ? "-$" : "$";
    return sign + Math.abs(n).toFixed(dp).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  function numberText(value: unknown, dp = 4): string {
    const n = Number(value);
    if (!Number.isFinite(n)) return "--";
    return n.toFixed(dp);
  }

  function integer(value: unknown): string {
    return Number(value || 0).toLocaleString();
  }

  function duration(seconds: unknown): string {
    const s = Number(seconds);
    if (!Number.isFinite(s) || s < 0) return "--";
    if (s < 60) return Math.trunc(s) + "s";
    if (s < 3600) return Math.floor(s / 60) + "m " + Math.trunc(s % 60) + "s";
    return Math.floor(s / 3600) + "h " + Math.floor((s % 3600) / 60) + "m";
  }

  function clock(ms: unknown): string {
    if (!ms) return "--";
    return new Date(Number(ms)).toLocaleTimeString("en-US", { hour12: false });
  }

  function short(value: unknown, head = 8, tail = 6): string {
    if (!value) return "--";
    const text = String(value);
    if (text.length <= head + tail + 3) return text;
    return text.slice(0, head) + "..." + text.slice(-tail);
  }

  function classForSide(side: unknown): string {
    if (side === "long") return "long";
    if (side === "short") return "short";
    if (side === "close") return "close";
    return "hold";
  }

  function statusClass(status: unknown): string {
    if (status === "success" || status === "paid") return "success";
    if (status === "failed") return "failed";
    if (status === "skipped") return "skipped";
    return "pending";
  }

  function normalizeTx(hash: unknown): string | null {
    if (!hash) return null;
    const raw = String(hash);
    if (raw.includes("skipped")) return null;
    return raw.startsWith("0x") ? raw : "0x" + raw;
  }

  function txHref(hash: unknown, explorer: string): string | null {
    const tx = normalizeTx(hash);
    return tx ? `${explorer}${tx}` : null;
  }
</script>

<div class="page">
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <div class="logo">HYPERFLOW</div>
        <div class="brand-sub">Runtime</div>
      </div>
      <div class="top-actions" aria-label="Runtime status">
        <span class="mini-stat">network <strong>{state?.network || "testnet"}</strong></span>
        <span class="mini-stat">uptime <strong>{duration(state?.uptime_seconds)}</strong></span>
        <span class="mini-stat">sync <strong>{clock(now)}</strong></span>
        <span class="status-pill"><span class="dot {connectionMode}"></span><strong>{connectionText}</strong></span>
        <button class="refresh-btn" type="button" disabled={refreshing} aria-busy={refreshing} onclick={() => void refresh()}>
          Sync
        </button>
      </div>
    </header>

    {#if errorText}
      <div class="banner" role="alert">
        <span>{errorText}</span>
        <button type="button" onclick={() => void refresh()}>Retry</button>
      </div>
    {/if}

    <main>
      <section class="hero-grid" aria-label="Agent readiness">
        <section class="panel command-panel">
          <div class="panel-head">
            <div>
              <div class="panel-title">Agent loop</div>
              <div class="panel-meta">x402 -> Nebius -> risk -> HL</div>
            </div>
            <span class="badge {loopState === 'ready' ? 'success' : 'pending'}">{loopStateText}</span>
          </div>
          <div class="stage-grid">
            <div class="stage {walletReady ? 'ready' : 'blocked'}">
              <span>Circle wallet</span>
              <strong>{walletReady ? wallet.chain : "--"}</strong>
              <small>{short(wallet.address, 10, 8)}</small>
            </div>
            <div class="stage {paidSpend.length ? 'ready' : 'pending'}">
              <span>Paid x402</span>
              <strong>{integer(paidSpend.length)}</strong>
              <small>{money(spendTotal, 4)} spent</small>
            </div>
            <div class="stage {nebiusLiveOk === false ? 'blocked' : nebiusReady ? 'ready' : 'pending'}">
              <span>Nebius agent</span>
              <strong>{nebiusLiveOk === false ? "HTTP 402" : nebiusReady ? "V4 Pro" : "--"}</strong>
              <small>{nebiusLiveOk === false ? "PAYMENT_REQUIRED" : nebiusHealth?.models_endpoint?.error ? short(nebiusHealth.models_endpoint.error, 24, 18) : nebiusHealth?.model || "CHECKING"}</small>
            </div>
            <div class="stage {accountReady ? 'ready' : 'blocked'}">
              <span>Hyperliquid</span>
              <strong>{money(account.value_usd)}</strong>
              <small>{accountReady ? "FUNDED" : "HL_EMPTY"}</small>
            </div>
          </div>
        </section>

        <aside class="panel diagnostics-panel">
          <div class="panel-head">
            <div class="panel-title">Runtime checks</div>
            <button class="copy-btn compact" type="button" disabled={nebiusBusy === "live"} aria-busy={nebiusBusy === "live"} onclick={() => void refreshNebiusHealth(true)}>
              Verify Nebius
            </button>
          </div>
          <div class="check-list">
            <div class="check-row"><span>HL account</span><strong class={accountReady ? "pos" : "warn"}>{accountReady ? "funded" : "empty"}</strong></div>
            <div class="check-row"><span>Agent wallet</span><strong class={walletReady ? "pos" : "warn"}>{walletReady ? wallet.chain : "missing"}</strong></div>
            <div class="check-row"><span>Nebius model</span><strong class={nebiusReady ? "pos" : "warn"}>{nebiusReady ? "available" : "checking"}</strong></div>
            <div class="check-row"><span>Live Nebius</span><strong class={nebiusLiveOk === false ? "neg" : nebiusLiveOk ? "pos" : "muted"}>{nebiusLiveOk === null ? "unchecked" : nebiusLiveOk ? "ok" : "HTTP 402"}</strong></div>
          </div>
        </aside>
      </section>

      <section class="metrics" aria-label="Agent metrics">
        <article class="panel metric">
          <div class="panel-title">Account value</div>
          <div class="big-num">{money(account.value_usd)}</div>
          <div class="subline">withdrawable {money(account.withdrawable_usd)}</div>
        </article>

        <article class="panel metric">
          <div class="panel-title">Daily PnL</div>
          <div class="big-num {dailyPnl > 0 ? 'pos' : dailyPnl < 0 ? 'neg' : 'muted'}">{dailyPnl >= 0 ? "+" : ""}{money(dailyPnl)}</div>
          <div class="gauge" aria-hidden="true"><div class="gauge-fill" style={`width:${pnlFillPct}%;background:${pnlFillColor}`}></div></div>
          <div class="gauge-legend"><span>{lossLimit > 0 ? "-" + money(lossLimit) : "--"}</span><span>0</span></div>
        </article>

        <article class="panel metric">
          <div class="panel-title">Position</div>
          {#if state?.position}
            <div class="big-num {state.position.side === 'long' ? 'pos' : 'neg'}">{String(state.position.side || "").toUpperCase()}</div>
            <div class="subline">
              {numberText(state.position.size_btc, 5)} {state.position.coin || ""} @ {money(state.position.entry_px, 0)}
              <span class={Number(state.position.unrealized_pnl_usd || 0) >= 0 ? "pos" : "neg"}>
                {Number(state.position.unrealized_pnl_usd || 0) >= 0 ? "+" : ""}{money(state.position.unrealized_pnl_usd, 4)}
              </span>
            </div>
          {:else}
            <div class="big-num muted">FLAT</div>
            <div class="subline">no exposure</div>
          {/if}
        </article>

        <article class="panel metric">
          <div class="panel-title">Risk state</div>
          <div class="big-num {risk.kill_switch_tripped ? 'neg' : 'pos'}">{risk.kill_switch_tripped ? "HALTED" : "ARMED"}</div>
          <div class="subline">{risk.kill_switch_tripped ? risk.kill_switch_reason || "kill switch tripped" : "daily limit " + money(risk.daily_loss_threshold_usd)}</div>
        </article>

        <article class="panel metric">
          <div class="panel-title">Paid services</div>
          <div class="big-num">{integer(paidSpend.length)}</div>
          <div class="subline">recent spend {money(spendTotal, 4)}</div>
        </article>
      </section>

      <section class="panel" aria-label="Circle Agent Wallet">
        <div class="panel-head">
          <div class="panel-title">Circle Agent Wallet</div>
          <div class="panel-meta">payment identity</div>
        </div>
        <div class="wallet-card">
          <div>
            <div class="quiet">wallet address</div>
            <div class="wallet-address">{wallet.address || "--"}</div>
          </div>
          <div class="wallet-grid">
            <div class="wallet-stat"><span>chain</span><strong>{wallet.chain || "--"}</strong></div>
            <div class="wallet-stat"><span>per-call cap</span><strong>{money(wallet.max_usdc_per_call, 4)}</strong></div>
            <div class="wallet-stat"><span>recent paid calls</span><strong>{integer(paidSpend.length)}</strong></div>
          </div>
        </div>
      </section>

      <section class="workspace">
        <div class="stack">
          <section class="panel" aria-label="Payment ledger">
            <div class="panel-head">
              <div class="panel-title">Spend ledger</div>
              <div class="panel-meta">{spend.length} rows</div>
            </div>
            <div class="table-wrap">
              <div class="table">
                <div class="table-row header spend-row">
                  <span>time</span><span>amount</span><span>status</span><span>chain</span><span>service</span><span>why paid</span><span>receipt</span>
                </div>
                {#if !state}
                  <div class="loading" aria-label="Loading spend ledger"></div>
                {:else if !spend.length}
                  <div class="empty">No Agent Wallet payments recorded yet.</div>
                {:else}
                  {#each spend.slice(0, 20) as item}
                    <div class="table-row spend-row">
                      <span class="muted">{clock(item.created_at_ms)}</span>
                      <span>{item.amount_usdc == null ? "--" : money(item.amount_usdc, 4)}</span>
                      <span><span class="badge {statusClass(item.status)}">{item.status || "pending"}</span></span>
                      <span class="muted">{item.chain || "--"}</span>
                      <span title={item.service_url || ""}>{item.service_url ? short(item.service_url, 24, 18) : "--"}</span>
                      <span class="muted" title={item.reason || ""}>{short(item.reason || "--", 34, 24)}</span>
                      <span>
                        {#if item.receipt}
                          <button class="copy-btn" type="button" aria-label="Copy payment receipt" onclick={() => void copy(item.receipt)}>{short(item.receipt, 6, 4)}</button>
                        {:else}
                          <span class="quiet">--</span>
                        {/if}
                      </span>
                    </div>
                  {/each}
                {/if}
              </div>
            </div>
          </section>

          <section class="panel" aria-label="Trade tape">
            <div class="panel-head">
              <div class="panel-title">Trade tape</div>
              <div class="panel-meta">{trades.length} rows</div>
            </div>
            <div class="table-wrap">
              <div class="table">
                <div class="table-row header trade-row">
                  <span>time</span><span>trace</span><span>action</span><span>size</span><span>price</span><span>lev</span><span>notes</span><span>paid signal</span>
                </div>
                {#if !state}
                  <div class="loading" aria-label="Loading trade tape"></div>
                {:else if !trades.length}
                  <div class="empty">No executed trades in the recent trace window.</div>
                {:else}
                  {#each trades as trace}
                    {@const paidTx = txHref(trace.payment_tx_hash, ARC_EXPLORER)}
                    <div class="table-row trade-row">
                      <span class="muted">{clock(trace.created_at_ms)}</span>
                      <span class="muted">{trace.trace_id_short || "--"}</span>
                      <span><span class="badge {classForSide(trace.side)}">{String(trace.side || "hold").toUpperCase()}</span></span>
                      <span>{trace.fill_size == null ? "--" : numberText(trace.fill_size, 5)}</span>
                      <span>{trace.fill_price ? money(trace.fill_price, 0) : "--"}</span>
                      <span class="muted">{trace.leverage ? Number(trace.leverage).toFixed(1) + "x" : "--"}</span>
                      <span class="muted">
                        {#if trace.exec_error}
                          <span class="neg">{short(trace.exec_error, 24, 18)}</span>
                        {:else if trace.tp_px && trace.sl_px}
                          TP {money(trace.tp_px, 0)} / SL {money(trace.sl_px, 0)}
                        {:else}
                          --
                        {/if}
                      </span>
                      <span>
                        {#if paidTx}
                          <a href={paidTx} target="_blank" rel="noopener noreferrer">{short(normalizeTx(trace.payment_tx_hash))}</a>
                        {:else if trace.agent_wallet_spend?.receipt}
                          <button class="copy-btn" type="button" aria-label="Copy agent wallet receipt" onclick={() => void copy(trace.agent_wallet_spend.receipt)}>{short(trace.agent_wallet_spend.receipt, 6, 4)}</button>
                        {:else}
                          <span class="quiet">--</span>
                        {/if}
                      </span>
                    </div>
                  {/each}
                {/if}
              </div>
            </div>
          </section>
        </div>

        <aside class="stack">
          <section class="panel" aria-label="Counters">
            <div class="panel-head">
              <div class="panel-title">Loop counters</div>
              <div class="panel-meta">current process</div>
            </div>
            <div class="wallet-grid padded">
              <div class="wallet-stat"><span>signals</span><strong>{integer(counters.signals_received)}</strong></div>
              <div class="wallet-stat"><span>opened</span><strong>{integer(counters.trades_opened)}</strong></div>
              <div class="wallet-stat"><span>closed</span><strong>{integer(counters.trades_closed)}</strong></div>
            </div>
          </section>

          <section class="panel" aria-label="Signal stream">
            <div class="panel-head">
              <div class="panel-title">Signal stream</div>
              <div class="panel-meta">latest decisions</div>
            </div>
            {#if !state}
              <div class="loading" aria-label="Loading signal stream"></div>
            {:else if !traces.length}
              <div class="empty">No decisions yet.</div>
            {:else}
              {#each traces.slice(0, 14) as trace}
                {@const confidence = Number(trace.signal_confidence || 0)}
                {@const pct = Math.round(Math.max(0, Math.min(1, confidence)) * 100)}
                <div class="signal-row">
                  <div class="signal-main">
                    <span class="muted">{clock(trace.created_at_ms)}</span>
                    <span class="badge {classForSide(trace.side)}">{String(trace.side || "hold").toUpperCase()}</span>
                    {#if trace.hold_reason}<span class="quiet">{trace.hold_reason}</span>{/if}
                    {#if trace.nebius_review}<span class="chip">Nebius <strong>{trace.nebius_review.approved ? "ok" : "veto"}</strong></span>{/if}
                  </div>
                  <div class="conf" aria-label={`Signal confidence ${pct} percent`}>
                    <div class="conf-track"><div class="conf-fill" style={`width:${pct}%`}></div></div>
                    <span class="muted">{confidence ? confidence.toFixed(2) : "--"}</span>
                  </div>
                </div>
              {/each}
            {/if}
          </section>
        </aside>
      </section>

      <section class="ops-grid" aria-label="Funding and bridge operations">
      {#if cctp.enabled}
        <section class="panel" aria-label="CCTP bridges">
          <div class="panel-head">
            <div>
              <div class="panel-title">CCTP bridges</div>
              <div class="panel-meta">Arc Testnet -> Arbitrum Sepolia - {cctpBridges.length} bridges</div>
            </div>
            {#if cctp.trigger_enabled}
              <button class="danger-btn" type="button" disabled={actionBusy === "cctp"} aria-busy={actionBusy === "cctp"} onclick={() => ask({
                title: "Bridge to Arbitrum Sepolia",
                body: "Trigger a real 1.0 USDC CCTP transfer from Arc Testnet to Arbitrum Sepolia.",
                confirmLabel: "Trigger bridge",
                run: triggerCctp,
              })}>{actionBusy === "cctp" ? "Bridge in progress" : "Trigger 1 USDC top-up"}</button>
            {/if}
          </div>
          <div class="table-wrap">
            <div class="table">
              <div class="table-row header bridge-row">
                <span>time</span><span>amount</span><span>status</span><span>attest</span><span>approve</span><span>burn</span><span>mint</span>
              </div>
              {#if !cctpBridges.length}
                <div class="empty">No CCTP bridge rows yet.</div>
              {:else}
                {#each cctpBridges as bridge}
                  {@const approveHref = txHref(bridge.approve_tx, ARC_EXPLORER)}
                  {@const burnHref = txHref(bridge.burn_tx, ARC_EXPLORER)}
                  {@const mintHref = txHref(bridge.mint_tx, ARB_SEPOLIA_EXPLORER)}
                  <div class="table-row bridge-row">
                    <span class="muted">{clock(bridge.started_at_ms)}</span>
                    <span>{money(bridge.amount_usdc, 2)}</span>
                    <span><span class="badge {statusClass(bridge.status)}">{bridge.status || "pending"}</span></span>
                    <span class="muted">{bridge.attestation_received_ms && bridge.started_at_ms ? Math.round((bridge.attestation_received_ms - bridge.started_at_ms) / 1000) + "s" : "--"}</span>
                    <span>{#if approveHref}<a href={approveHref} target="_blank" rel="noopener noreferrer">{short(normalizeTx(bridge.approve_tx))}</a>{:else}<span class="quiet">--</span>{/if}</span>
                    <span>{#if burnHref}<a href={burnHref} target="_blank" rel="noopener noreferrer">{short(normalizeTx(bridge.burn_tx))}</a>{:else}<span class="quiet">--</span>{/if}</span>
                    <span>{#if mintHref}<a href={mintHref} target="_blank" rel="noopener noreferrer">{short(normalizeTx(bridge.mint_tx))}</a>{:else}<span class="quiet">--</span>{/if}</span>
                  </div>
                {/each}
              {/if}
            </div>
          </div>
        </section>
      {/if}

      {#if circleBridge.enabled}
        <section class="panel" aria-label="Agent wallet bridge">
          <div class="panel-head">
            <div>
              <div class="panel-title">Agent wallet bridge</div>
              <div class="panel-meta">{circleBridgeRoute.from_chain || "ARC-TESTNET"} -> {circleBridgeRoute.to_chain || "BASE-SEPOLIA"} - {circleTransfers.length} transfers</div>
            </div>
            {#if circleBridge.trigger_enabled}
              <button class="danger-btn" type="button" disabled={actionBusy === "circle-bridge"} aria-busy={actionBusy === "circle-bridge"} onclick={() => ask({
                title: "Bridge to Agent Wallet",
                body: "Trigger a real 1.0 USDC bridge from Arc Testnet to the Base Sepolia Agent Wallet.",
                confirmLabel: "Bridge Arc -> Base",
                run: triggerCircleBridge,
              })}>{actionBusy === "circle-bridge" ? "Bridge in progress" : "Bridge Arc -> Base"}</button>
            {/if}
          </div>
          <div class="table-wrap">
            <div class="table">
              <div class="table-row header circle-bridge-row">
                <span>time</span><span>route</span><span>amount</span><span>status</span><span>burn</span><span>mint</span><span>recipient / error</span>
              </div>
              {#if !circleTransfers.length}
                <div class="empty">No Arc to Base bridge transfers recorded yet.</div>
              {:else}
                {#each circleTransfers as transfer}
                  {@const burnHref = txHref(transfer.burn_tx, ARC_EXPLORER)}
                  {@const mintHref = txHref(transfer.mint_tx, BASE_SEPOLIA_EXPLORER)}
                  <div class="table-row circle-bridge-row">
                    <span class="muted">{clock(transfer.created_at_ms)}</span>
                    <span class="muted">{transfer.from_chain || circleBridgeRoute.from_chain} -> {transfer.to_chain || circleBridgeRoute.to_chain}</span>
                    <span>{money(transfer.amount_usdc, 2)}</span>
                    <span><span class="badge {statusClass(transfer.status)}">{transfer.status || "pending"}</span></span>
                    <span>{#if burnHref}<a href={burnHref} target="_blank" rel="noopener noreferrer">{short(normalizeTx(transfer.burn_tx))}</a>{:else}<span class="quiet">--</span>{/if}</span>
                    <span>{#if mintHref}<a href={mintHref} target="_blank" rel="noopener noreferrer">{short(normalizeTx(transfer.mint_tx))}</a>{:else}<span class="quiet">--</span>{/if}</span>
                    <span>
                      {#if transfer.error}
                        <span class="neg" title={transfer.error}>{short(transfer.error, 22, 20)}</span>
                      {:else if transfer.recipient_address}
                        <button class="copy-btn" type="button" aria-label="Copy bridge recipient" onclick={() => void copy(transfer.recipient_address)}>{short(transfer.recipient_address, 6, 4)}</button>
                      {:else}
                        <span class="quiet">--</span>
                      {/if}
                    </span>
                  </div>
                {/each}
              {/if}
            </div>
          </div>
        </section>
      {/if}
      </section>

      <div class="screen-reader" aria-live="polite">{copyStatus}</div>
    </main>

    <footer>HyperFlow - Circle Agent Wallet - Hyperliquid - CCTP</footer>
  </div>
</div>

{#if confirmAction}
  <div class="modal-backdrop">
    <button class="modal-scrim" type="button" aria-label="Cancel bridge action" onclick={() => (confirmAction = null)}></button>
    <div class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
      <div class="panel-title" id="confirm-title">{confirmAction.title}</div>
      <p>{confirmAction.body}</p>
      <div class="confirm-actions">
        <button type="button" onclick={() => (confirmAction = null)}>Cancel</button>
        <button class="danger-btn" type="button" onclick={() => void runConfirmed()}>{confirmAction.confirmLabel}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .padded {
    padding: 12px;
  }

  .modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: grid;
    place-items: center;
    padding: 16px;
  }

  .modal-scrim {
    position: absolute;
    inset: 0;
    min-height: 0;
    width: 100%;
    border: 0;
    border-radius: 0;
    background: rgba(0, 0, 0, 0.58);
  }

  .confirm-dialog {
    position: relative;
    width: min(420px, 100%);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius);
    background: var(--surface);
    padding: 16px;
    box-shadow: var(--shadow);
  }

  .confirm-dialog p {
    margin: 12px 0 16px;
    color: var(--text);
  }

  .confirm-actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    flex-wrap: wrap;
  }
</style>
