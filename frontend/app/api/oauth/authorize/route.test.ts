import { describe, test, expect, mock } from "bun:test";

let authenticatedUser: { id: string } | null = null;
mock.module("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: authenticatedUser }, error: null }),
    },
  }),
}));

import { GET } from "./route";
import { NextRequest } from "next/server";

process.env["JWT_SECRET"] = "test-secret";

function makeRequest(params: Record<string, string>): NextRequest {
  const url = new URL("http://localhost:3000/api/oauth/authorize");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new NextRequest(url);
}

const validParams = {
  response_type: "code",
  client_id: "claude-code",
  redirect_uri: "http://localhost:3000/callback",
  code_challenge: "abc123challenge",
  code_challenge_method: "S256",
  state: "random-state",
};

describe("GET /api/oauth/authorize", () => {
  test("redirects to login with __oauth_pkce cookie for valid request", async () => {
    const res = await GET(makeRequest(validParams));
    expect(res.status).toBe(307);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/login");
    expect(location).toContain("next=/api/oauth/callback");
    const cookieHeader = res.headers.get("set-cookie") ?? "";
    expect(cookieHeader).toContain("__oauth_pkce");
    expect(cookieHeader).toContain("HttpOnly");
  });

  test("returns 400 for wrong response_type", async () => {
    const res = await GET(makeRequest({ ...validParams, response_type: "token" }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("unsupported_response_type");
  });

  test("returns 400 when code_challenge missing", async () => {
    const { code_challenge, ...rest } = validParams;
    const res = await GET(makeRequest(rest));
    expect(res.status).toBe(400);
  });

  test("returns 400 when code_challenge_method is not S256", async () => {
    const res = await GET(makeRequest({ ...validParams, code_challenge_method: "plain" }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("invalid_request");
  });

  test("state is optional — defaults to empty string", async () => {
    const { state, ...rest } = validParams;
    const res = await GET(makeRequest(rest));
    expect(res.status).toBe(307);
  });

  test("skips login for an authenticated user and preserves the PKCE cookie", async () => {
    authenticatedUser = { id: "test-user" };
    try {
      const res = await GET(makeRequest(validParams));
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe("http://localhost:3000/api/oauth/callback");
      expect(res.headers.get("set-cookie") ?? "").toContain("__oauth_pkce");
    } finally {
      authenticatedUser = null;
    }
  });
});
