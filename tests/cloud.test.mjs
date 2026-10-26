import { test } from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { createHash } from "node:crypto";
const base = process.env.JIJI_TEST_ORIGIN || "https://jiji.test";
test("cloud OAuth pairing, PKCE, isolation, and browser routing", async () => {
  const mf = process.env.JIJI_TEST_ORIGIN
    ? null
    : new Miniflare(
        convertV4MiniflareOptions({
          name: "jiji",
          modules: true,
          scriptPath: new URL("../work/cloud-build/worker.js", import.meta.url)
            .pathname,
          compatibilityDate: "2026-10-01",
          compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
          kvNamespaces: ["OAUTH_KV"],
          durableObjects: {
            BRIDGES: { className: "JijiBridge", useSQLite: true },
          },
        }),
      );
  try {
    const dispatch = (path, init = {}) =>
      mf ? mf.dispatchFetch(base + path, init) : fetch(base + path, init);
    const browser = (path, body = {}, token = "a".repeat(64)) =>
      dispatch(path, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const unauth = await dispatch("/mcp", { method: "POST" });
    assert.equal(unauth.status, 401);
    assert.match(unauth.headers.get("www-authenticate"), /resource_metadata/);
    const pair = await (await browser("/bridge/pair")).json();
    assert.match(pair.code, /^[a-f0-9]{20}$/);
    const reg = await dispatch("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Test agent",
        redirect_uris: ["https://client.example/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    assert.equal(reg.status, 201);
    const client = await reg.json();
    const verifier = "x".repeat(64);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authQuery = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: "https://client.example/callback",
      scope: "jiji:read offline_access",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "test-state",
      resource: base,
    });
    const page = await dispatch("/authorize?" + authQuery);
    assert.equal(page.status, 200);
    const text = await page.text();
    const handle = text.match(/name="handle" value="([^"]+)"/)[1];
    const cookie = page.headers.get("set-cookie").split(";")[0];
    const approve = await dispatch("/authorize", {
      method: "POST",
      headers: {
        Origin: base,
        Cookie: cookie,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        handle,
        code: pair.code,
        decision: "approve",
      }),
    });
    const result = await approve.text();
    assert.match(result, /Jiji connected/);
    const callback = result.match(/href="([^"]+)"/)[1].replaceAll("&#38;", "&");
    const code = new URL(callback).searchParams.get("code");
    assert.ok(code);
    const tokenResponse = await dispatch("/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.client_id,
        code,
        redirect_uri: "https://client.example/callback",
        code_verifier: verifier,
        resource: base,
      }),
    });
    assert.equal(tokenResponse.status, 200);
    const tokens = await tokenResponse.json();
    assert.ok(tokens.access_token);
    const rpc = (method, params, id = 1) =>
      dispatch("/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + tokens.access_token,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      });
    const list = await (await rpc("tools/list", {})).json();
    assert.equal(list.result.tools.length, 5);
    const poll = browser("/bridge/poll");
    const search = rpc("tools/call", {
      name: "jiji_search",
      arguments: { query: "router" },
    });
    const jobs = await (await poll).json();
    assert.equal(jobs.jobs.length, 1);
    const job = jobs.jobs[0];
    assert.match(job.path, /query=router/);
    const wrong = await browser(
      "/bridge/result",
      { id: job.id, status: 200, body: {} },
      "b".repeat(64),
    );
    assert.equal(wrong.status, 410);
    const delivered = await browser("/bridge/result", {
      id: job.id,
      status: 200,
      body: {
        adverts_list: {
          count: 1,
          adverts: [
            {
              guid: "abcdefgh12345678",
              title: "Test router",
              url: "/test.html",
              price_obj: { value: 100 },
            },
          ],
        },
      },
    });
    assert.equal(delivered.status, 200);
    const answer = await (await search).json();
    assert.match(answer.result.content[0].text, /Test router/);
    const replay = await dispatch("/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.client_id,
        code,
        redirect_uri: "https://client.example/callback",
        code_verifier: verifier,
        resource: base,
      }),
    });
    assert.notEqual(replay.status, 200);
    await browser("/bridge/disconnect");
  } finally {
    await mf?.dispose();
  }
});
