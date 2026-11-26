import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { App } from "./App";

const wf = { id: 1, name: "Flag high-value orders", trigger_type: "webhook", interval_minutes: null, conditions: [{ field: "amount", op: "gt", value: 500 }], actions: [{ type: "notify" }], enabled: true, webhook_path: "/hooks/abc" };
let execs: unknown[] = [];
beforeEach(() => {
  execs = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (url.endsWith("/workflows")) return ok([wf]);
    if (url.includes("/hooks/")) { execs = [{ id: 5, workflow_id: 1, trigger: "webhook", status: "succeeded", payload: { amount: 900 }, steps: [{ step: "1:notify", ok: true, detail: "recorded" }], error: "" }]; return ok({ execution_id: 5 }); }
    if (url.endsWith("/worker/tick")) return ok({ scheduled: 0, processed: 1 });
    if (url.endsWith("/executions")) return ok(execs);
    return ok({});
  }));
});

test("send test webhook then see execution history with step detail", async () => {
  render(<App />);
  await userEvent.click(await screen.findByText("Workflows", { selector: "button *, button" }));
  await userEvent.click(await screen.findByText("Send test webhook"));
  await userEvent.click(await screen.findByText("Send and run worker"));
  await screen.findByText("Execution history", { selector: "h1" });
  await userEvent.click(await screen.findByText("#5"));
  await waitFor(() => expect(screen.getByText(/recorded/)).toBeInTheDocument());
});

test("builder create button needs a name and template fills it", async () => {
  render(<App />);
  await userEvent.click(await screen.findByText("Builder", { selector: "button *, button" }));
  expect(screen.getByText("Create")).toBeDisabled();
  await userEvent.click(screen.getByText("Escalate large orders"));
  expect(screen.getByText("Create")).toBeEnabled();
});
