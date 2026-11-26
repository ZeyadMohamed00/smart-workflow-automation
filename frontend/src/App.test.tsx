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
    if (url.includes("/hooks/")) { execs = [{ id: 5, workflow_id: 1, trigger: "webhook", status: "succeeded", payload: {}, steps: [{ step: "1:notify", ok: true, detail: "recorded" }], error: "" }]; return ok({ execution_id: 5 }); }
    if (url.endsWith("/worker/tick")) return ok({ scheduled: 0, processed: 1 });
    if (url.endsWith("/executions")) return ok(execs);
    return ok({});
  }));
});

test("send test webhook then see execution history", async () => {
  render(<App />);
  await userEvent.click(await screen.findByText("Send test webhook"));
  await waitFor(() => expect(screen.getByText(/1:notify: recorded/)).toBeInTheDocument());
  expect(screen.getByText("succeeded")).toBeInTheDocument();
});

test("create button needs a name", async () => {
  render(<App />);
  await screen.findByText("Flag high-value orders");
  expect(screen.getByText("Create")).toBeDisabled();
});
