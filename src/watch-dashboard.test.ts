/// <reference types="node" />
import { describe, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import { runInNewContext } from "node:vm";
import { getWatchDashboardHtml } from "./watch-dashboard";

async function dashboard(options: { paid?: boolean; failBaseline?: boolean; manual?: boolean; monitorCount?: number } = {}) {
  const { document, window } = parseHTML(getWatchDashboardHtml());
  const storage = new Map<string, string>();
  const calls: { path: string; body: Record<string, any>; headers: Record<string, string> }[] = [];
  const saved: Record<string, any>[] = [];
  const location = { origin: "https://groundtruth.test", href: "" };
  // linkedom does not implement these browser presentation APIs.
  window.HTMLElement.prototype.scrollIntoView = () => {};
  const schedule = document.getElementById("schedule")!;
  Object.defineProperty(schedule, "value", { value: "daily", writable: true });
  const fetch = vi.fn(async (path: string, init: any) => {
    const body = JSON.parse(init.body || "{}");
    calls.push({ path, body, headers: init.headers });
    let data: any;
    if (path === "/api/watch/access") data = {
      apiKey: "gt_free_test_private", accessTier: options.paid ? "team" : "free_monitor",
      activeMonitorLimit: options.paid ? 10 : 3, monthlyQuota: options.paid ? 5000 : 100,
      allowedSchedules: options.paid ? ["manual", "hourly", "daily", "weekly"] : ["manual", "daily", "weekly"],
    };
    else if (path.startsWith("/api/checkout")) data = { checkoutUrl: "https://checkout.stripe.com/test" };
    else if (path === "/api/preview-monitor") data = { status: "baseline_ready", baseline: { pricesFound: ["$9", "$29", "$99"], plansDetected: ["Monitor", "Team", "Scale"] } };
    else if (body.action === "list_monitors") data = { monitors: saved, total: options.monitorCount ?? saved.length, active_monitor_limit: 3, remaining_active_slots: 3 - (options.monitorCount ?? saved.length) };
    else if (body.action === "create_monitor") {
      const monitor = { id: "mon_test", ...body.arguments, last_run_at: "2026-09-05T01:00:00Z" };
      saved.push(monitor); data = monitor;
    } else if (body.action === "run_monitor_now") data = options.failBaseline ? { error: "Source returned HTTP 404" } : { status: "unchanged", run_at: "2026-09-05T01:00:00Z", new_value: JSON.stringify({ pricesFound: ["$19"], plansDetected: ["Pro"] }) };
    else throw new Error("Unexpected request: " + path);
    return { ok: true, json: async () => data };
  });
  runInNewContext(document.querySelector("script")!.textContent!, {
    document, fetch, location, console, crypto: { randomUUID: () => "test-browser" },
    localStorage: { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    navigator: { clipboard: { writeText: vi.fn() } }, confirm: () => true,
  });
  await vi.waitFor(() => expect(document.getElementById("create")!.hasAttribute("disabled")).toBe(false));
  return { document, window, calls, location, schedule };
}

describe("Watch dashboard customer flows", () => {
  it("starts with an empty source and previews real pricing without saving a monitor", async () => {
    const { document, calls } = await dashboard();
    expect(document.getElementById("target")!.getAttribute("value")).toBeNull();
    await (document.getElementById("demo") as any).onclick();
    expect(document.getElementById("result-summary")!.textContent).toContain("$9, $29, $99");
    expect(calls.find(call => call.path === "/api/preview-monitor")!.body.target_value).toBe("https://groundtruth.test/pricing");
    expect(calls.some(call => call.body.action === "create_monitor")).toBe(false);
  });

  it.each(["good", "better", "best"])("opens plan selection before checking out %s with the same private key", async (plan) => {
    const { document, calls, location } = await dashboard();
    await (document.getElementById("upgrade") as any).onclick();
    expect(document.getElementById("plans")!.hidden).toBe(false);
    expect(calls.some(call => call.path.startsWith("/api/checkout"))).toBe(false);
    await (document.querySelector(`[data-plan="${plan}"]`) as any).onclick();
    const checkout = calls.find(call => call.path === `/api/checkout?plan=${plan}`)!;
    expect(checkout.headers["X-API-Key"]).toBe("gt_free_test_private");
    expect(checkout.path).not.toContain("gt_free_");
    expect(location.href).toBe("https://checkout.stripe.com/test");
  });

  it("surfaces the paid value when one free monitor slot remains", async () => {
    const { document } = await dashboard({ monitorCount: 2 });
    expect(document.getElementById("growth-prompt")!.hidden).toBe(false);
    expect(document.getElementById("growth-prompt")!.textContent).toContain("One free monitor slot left");
    expect(document.getElementById("upgrade")!.textContent).toContain("$9/mo");
  });

  it("opens plan choices instead of making a doomed fourth-monitor request", async () => {
    const { document, window, calls } = await dashboard({ monitorCount: 3 });
    (document.getElementById("target") as any).value = "https://another-competitor.test/pricing";
    document.getElementById("create-form")!.dispatchEvent(new window.Event("submit", { cancelable: true }));
    expect(document.getElementById("plans")!.hidden).toBe(false);
    expect(document.getElementById("notice")!.textContent).toContain("watchlist is full");
    expect(calls.some(call => call.body.action === "create_monitor")).toBe(false);
  });

  it.each([false, true])("exposes hourly scheduling only when the server grants it (paid=%s)", async (paid) => {
    const { document } = await dashboard({ paid });
    expect((document.querySelector('option[value="hourly"]') as any).disabled).toBe(!paid);
    expect(document.getElementById("upgrade")!.hidden).toBe(paid);
    expect(document.getElementById("create")!.textContent).toBe(paid ? "Create monitor" : "Create free monitor");
  });

  it.each([false, true])("keeps first-check success and failure actionable (failed=%s)", async (failBaseline) => {
    const { document, window, calls } = await dashboard({ failBaseline });
    (document.getElementById("target") as any).value = "https://competitor.test/pricing";
    document.getElementById("create-form")!.dispatchEvent(new window.Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(document.getElementById("create")!.hasAttribute("disabled")).toBe(false));
    expect(document.querySelectorAll("article.monitor").length).toBe(1);
    expect(calls.filter(call => call.body.action === "create_monitor")).toHaveLength(1);
    expect(document.getElementById("notice")!.textContent).toContain(failBaseline ? "Monitor saved, but its first check did not complete" : "Next check due");
    if (failBaseline) expect(document.getElementById("notice")!.textContent).toContain("Use Run now");
    else expect(document.getElementById("result-summary")!.textContent).toContain("$19");
  });

  it("does not promise automatic checks for a manual monitor", async () => {
    const { document, window, schedule } = await dashboard();
    (schedule as any).value = "manual";
    document.getElementById("create-form")!.dispatchEvent(new window.Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(document.getElementById("create")!.hasAttribute("disabled")).toBe(false));
    expect(document.getElementById("notice")!.textContent).toContain("Use Run now whenever");
    expect(document.getElementById("notice")!.textContent).not.toContain("Next check due");
  });
});
