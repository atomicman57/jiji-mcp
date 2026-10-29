import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { createHash } from "node:crypto";
const base = process.env.JIJI_TEST_ORIGIN || "https://jiji.test";
test(
  "cloud OAuth pairing, PKCE, isolation, and browser routing",
  { timeout: 180000 },
  async () => {
    const mf = process.env.JIJI_TEST_ORIGIN
      ? null
      : new Miniflare(
          convertV4MiniflareOptions({
            name: "jiji",
            modules: true,
            scriptPath: new URL(
              "../work/cloud-build/worker.js",
              import.meta.url,
            ).pathname,
            compatibilityDate: "2026-10-01",
            compatibilityFlags: [
              "nodejs_compat",
              "global_fetch_strictly_public",
            ],
            d1Databases: ["MCP_STORAGE"],
            durableObjects: {
              BRIDGES: { className: "JijiBridge", useSQLite: true },
            },
          }),
        );
    const sockets = [];
    try {
      if (mf) {
        const db = (await mf.getBindings()).MCP_STORAGE;
        for (const sql of readFileSync(
          new URL("../cloud/d1-schema.sql", import.meta.url),
          "utf8",
        )
          .split(";")
          .filter((s) => s.trim()))
          await db.prepare(sql).run();
      }
      const dispatch = (path, init = {}) =>
        mf
          ? mf.dispatchFetch(base + path, init)
          : fetch(base + path, {
              ...init,
              signal: init.signal || AbortSignal.timeout(45000),
            });
      const queuedJobs = [],
        waiters = [];
      async function connectSocket(token = "a".repeat(64)) {
        if (!mf)
          throw new Error(
            "WebSocket integration test requires local Miniflare; live checks use the native companion.",
          );
        const response = await dispatch("/bridge/socket", {
          headers: { Upgrade: "websocket", Authorization: "Bearer " + token },
        });
        assert.equal(response.status, 101);
        const socket = response.webSocket;
        sockets.push(socket);
        const ready = new Promise((resolve) =>
          socket.addEventListener("message", (event) => {
            const message = JSON.parse(event.data);
            if (message.type === "ready") resolve();
            if (message.type === "job") {
              if (waiters.length)
                waiters.shift()(Response.json({ jobs: [message.job] }));
              else queuedJobs.push(message.job);
            }
          }),
        );
        socket.accept();
        await ready;
        return socket;
      }
      const companion = await connectSocket();
      const nextJobResponse = () =>
        queuedJobs.length
          ? Promise.resolve(Response.json({ jobs: [queuedJobs.shift()] }))
          : new Promise((resolve) => waiters.push(resolve));
      const browser = (path, body = {}, token = "a".repeat(64)) => {
        if (path === "/bridge/result" && token === "a".repeat(64)) {
          const { id, ...result } = body;
          companion.send(
            JSON.stringify({
              type: "result",
              id,
              result: body.result ?? result,
            }),
          );
          return Promise.resolve(Response.json({ ok: true }));
        }
        return dispatch(path, {
          method: "POST",
          headers: {
            Authorization: "Bearer " + token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
      };
      assert.equal(
        (
          await dispatch("/bridge/socket", {
            headers: { Upgrade: "websocket" },
          })
        ).status,
        401,
      );
      assert.equal((await browser("/bridge/poll")).status, 426);
      assert.equal(
        (
          await dispatch("/bridge/socket", {
            headers: {
              Upgrade: "websocket",
              Authorization: "Bearer " + "a".repeat(64),
              Origin: "https://hostile.example",
            },
          })
        ).status,
        403,
      );
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
      const challenge = createHash("sha256")
        .update(verifier)
        .digest("base64url");
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
      assert.equal(page.headers.get("referrer-policy"), "same-origin");
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
      const callback = result
        .match(/href="([^"]+)"/)[1]
        .replaceAll("&#38;", "&");
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
      let tokens = await tokenResponse.json();
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
      assert.equal(list.result.tools.length, 24);
      // Reply preparation travels through the relay; the mocked companion only
      // returns a pending plan. No human approval or Jiji mutation is performed.
      const reply = rpc("tools/call", {
        name: "jiji_prepare_conversation_message",
        arguments: { key: "a".repeat(24), message: "Exact mock reply" },
      });
      const replyJob = (await (await nextJobResponse()).json()).jobs[0];
      assert.equal(replyJob.request.action, "prepare_conversation_message");
      assert.equal(replyJob.request.message, "Exact mock reply");
      await browser("/bridge/result", {
        id: replyJob.id,
        result: {
          id: "mock-plan",
          state: "pending",
          approval_url: "http://127.0.0.1/approve/mock-plan",
        },
      });
      const replyAnswer = await (await reply).json();
      assert.equal(replyAnswer.result.isError, undefined);
      assert.equal(
        JSON.parse(replyAnswer.result.content[0].text).state,
        "pending",
      );
      const poll = nextJobResponse();
      const search = rpc("tools/call", {
        name: "jiji_search",
        arguments: { query: "router", limit: 1 },
      });
      const jobs = await (await poll).json();
      assert.equal(jobs.jobs.length, 1);
      const job = jobs.jobs[0];
      assert.match(job.path, /query=router/);
      const wrong = await connectSocket("b".repeat(64));
      wrong.send(
        JSON.stringify({
          type: "result",
          id: job.id,
          result: { status: 200, body: {} },
        }),
      );
      assert.equal(
        await Promise.race([
          search.then(() => false),
          new Promise((resolve) => setTimeout(() => resolve(true), 40)),
        ]),
        true,
      );
      wrong.close(1000);
      const delivered = await browser("/bridge/result", {
        id: job.id,
        status: 200,
        body: {
          adverts_list: {
            count: 2,
            adverts: [
              {
                guid: "abcdefgh23456789",
                title: "Another router",
                url: "/second.html",
                price_obj: { value: 200 },
              },
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
      assert.match(answer.result.content[0].text, /Another router/);
      const nextCursor = JSON.parse(answer.result.content[0].text).next_cursor;
      assert.ok(nextCursor);
      const userId = createHash("sha256").update("a".repeat(64)).digest("hex");
      await mf.unsafeEvictDurableObject("jiji", "JijiBridge", {
        name: userId,
        webSockets: "hibernate",
      });
      assert.equal(
        (await (await browser("/bridge/status")).json()).connected,
        true,
      );
      const nextPage = await (
        await rpc("tools/call", {
          name: "jiji_next_page",
          arguments: { cursor: nextCursor, limit: 1 },
        })
      ).json();
      assert.match(nextPage.result.content[0].text, /Test router/);
      // Buffered cursors do not exercise the socket after hibernation.
      // A fresh browser job must complete through the retained connection too.
      const resumedStatus = rpc("tools/call", {
        name: "jiji_connection_status",
        arguments: {},
      });
      const resumedJobs = await (await nextJobResponse()).json();
      assert.equal(resumedJobs.jobs[0].request.action, "status");
      await browser("/bridge/result", {
        id: resumedJobs.jobs[0].id,
        result: { connected: true, signed_in: true },
      });
      const resumedAnswer = await (await resumedStatus).json();
      assert.equal(resumedAnswer.result.isError, undefined);
      assert.equal(
        JSON.parse(resumedAnswer.result.content[0].text).signed_in,
        true,
      );
      // Older grants cannot gain private account access through a client header.
      const denied = await dispatch("/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + tokens.access_token,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "X-Jiji-Account-Access": "1",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "jiji_account_data",
            arguments: { resource: "balance" },
          },
        }),
      });
      const deniedBody = await denied.json();
      assert.equal(deniedBody.result.isError, true);
      assert.match(deniedBody.result.content[0].text, /not been granted/);
      // Reconnect and explicitly opt in to the expanded account features.
      const secondPair = await (await browser("/bridge/pair")).json();
      const secondPage = await dispatch("/authorize?" + authQuery);
      const secondHtml = await secondPage.text();
      assert.match(secondHtml, /name="account_access"/);
      const secondApprove = await dispatch("/authorize", {
        method: "POST",
        headers: {
          Origin: base,
          Cookie: secondPage.headers.get("set-cookie").split(";")[0],
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          handle: secondHtml.match(/name="handle" value="([^"]+)"/)[1],
          code: secondPair.code,
          decision: "approve",
          account_access: "yes",
        }),
      });
      const secondCallback = (await secondApprove.text())
        .match(/href="([^"]+)"/)[1]
        .replaceAll("&#38;", "&");
      const secondTokens = await dispatch("/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: client.client_id,
          code: new URL(secondCallback).searchParams.get("code"),
          redirect_uri: "https://client.example/callback",
          code_verifier: verifier,
          resource: base,
        }),
      });
      assert.equal(secondTokens.status, 200);
      tokens = await secondTokens.json();
      const accountPoll = nextJobResponse();
      const accountCall = rpc("tools/call", {
        name: "jiji_account_data",
        arguments: { resource: "balance" },
      });
      const accountJob = (await (await accountPoll).json()).jobs[0];
      assert.equal(accountJob.request.resource, "balance");
      await browser("/bridge/result", {
        id: accountJob.id,
        result: { status: 200, body: { balance: 123 } },
      });
      assert.match(
        (await (await accountCall).json()).result.content[0].text,
        /123/,
      );
      // Approval IDs and transport IDs must never overwrite each other.
      const planId = "11111111-1111-4111-8111-111111111111";
      const planPoll = nextJobResponse();
      const planCall = rpc("tools/call", {
        name: "jiji_action_status",
        arguments: { id: planId },
      });
      const planJob = (await (await planPoll).json()).jobs[0];
      assert.notEqual(planJob.id, planId);
      assert.equal(planJob.request.id, planId);
      await browser("/bridge/result", {
        id: planJob.id,
        result: { id: planId, state: "pending" },
      });
      assert.match(
        (await (await planCall).json()).result.content[0].text,
        new RegExp(planId),
      );
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
      const interruptedJob = nextJobResponse();
      const interruptedCall = rpc("tools/call", {
        name: "jiji_action_status",
        arguments: { id: planId },
      });
      await interruptedJob;
      companion.close(1000);
      const interrupted = await (await interruptedCall).json();
      assert.equal(interrupted.result.isError, true);
      assert.match(interrupted.result.content[0].text, /not retried/);
      await browser("/bridge/disconnect");
    } finally {
      for (const socket of sockets)
        if (socket.readyState === 1) socket.close(1000);
      await mf?.dispose();
    }
  },
);
