import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { AuthGate } from "./auth";

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });

test("shows login, registers, then shows the app with a log out button", async () => {
  const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify({ access_token: "tok", token_type: "bearer", user: { id: 1, email: "a@b.co", name: "Ann" } }), { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);
  render(<AuthGate title="App"><p>secret area</p></AuthGate>);
  expect(screen.queryByText("secret area")).toBeNull();
  await userEvent.click(screen.getByText("New here? Create an account"));
  await userEvent.type(screen.getByLabelText("Name"), "Ann");
  await userEvent.type(screen.getByLabelText("Email"), "a@b.co");
  await userEvent.type(screen.getByLabelText("Password"), "correct-horse-1");
  await userEvent.click(screen.getByRole("button", { name: "Create account" }));
  await waitFor(() => expect(screen.getByText("secret area")).toBeTruthy());
  expect(localStorage.getItem("auth_token")).toBe("tok");
  expect(screen.getByText("Log out")).toBeTruthy();
  expect(String(fetchMock.mock.calls[0][0])).toContain("/auth/register");
});

test("shows the server error on a failed login", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: "Wrong email or password" }), { status: 401 })));
  render(<AuthGate title="App"><p>secret area</p></AuthGate>);
  await userEvent.type(screen.getByLabelText("Email"), "a@b.co");
  await userEvent.type(screen.getByLabelText("Password"), "whatever1");
  await userEvent.click(screen.getByRole("button", { name: "Log in" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Wrong email or password");
});

test("guest mode skips login", async () => {
  render(<AuthGate title="App"><p>secret area</p></AuthGate>);
  await userEvent.click(screen.getByText("Continue as guest (demo data)"));
  expect(screen.getByText("secret area")).toBeTruthy();
});
