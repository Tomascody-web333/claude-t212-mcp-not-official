import { AuthorizationError, CimdFetchError } from "@cloudflare/workers-oauth-provider";
import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";
import type { Account, Env, Props, T212Env } from "./env";
import { T212Error, t212 } from "./t212";

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}

// The only inline script allowed by the CSP (guards against double submit); keep in sync with SCRIPT_HASH.
const SCRIPT = "document.querySelector('form').addEventListener('submit',function(e){var b=e.submitter;if(window.__sent){e.preventDefault();return}if(b&&b.value==='approve'){window.__sent=1;b.textContent='Connecting… do not click again';}});";
const SCRIPT_HASH = "AAxLcVYQJ4osVlDbfEig3al5svndpkHk/kMo0KPGGGw=";

const SECURITY_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${SCRIPT_HASH}'; form-action 'self'; frame-ancestors 'none'`,
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

// Dark theme based on the Homeserver-LAB site (theme colour #0b0f14); accent colours are approximations.
const STYLE = `
:root{color-scheme:dark;--bg:#0b0f14;--panel:#111821;--panel2:#0d141c;--border:#223042;--text:#e6edf3;--muted:#8b98a5;--accent:#4ea1ff;--accent-h:#7ab8ff;--err:#f87171;--warn:#fbbf24}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.top{border-bottom:1px solid var(--border);padding:14px 16px}
.top div{max-width:520px;margin:0 auto;display:flex;align-items:baseline;gap:10px}
.brand{font-weight:700;font-size:1.05rem}.brand b{color:var(--accent)}
.sub{color:var(--muted);font-size:.85rem}
main{max-width:520px;margin:24px auto;padding:0 16px 40px}
.card{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:20px}
h1{font-size:1.35rem;margin:0 0 10px}
p{margin:10px 0}
a{color:var(--accent)}
label{display:block;margin:14px 0 6px;font-weight:600;font-size:.95rem}
input[type=text],input[type=password]{width:100%;padding:11px 12px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:10px;font-size:16px}
input:focus{outline:2px solid var(--accent);outline-offset:1px}
fieldset{border:1px solid var(--border);border-radius:12px;margin:14px 0;background:var(--panel2)}
legend{padding:0 6px;color:var(--muted)}
.modes input[type=radio],.row input{accent-color:var(--accent);margin:7px 9px 7px 0}
.modes label.m{display:inline;font-weight:400;margin:0}
.row{display:flex;align-items:flex-start;margin:12px 0}.row label{margin:5px 0 0;font-weight:400;color:var(--muted)}
.f-demo,.f-live{display:none}
#m-demo:checked~.f-demo,#m-both:checked~.f-demo,#m-live:checked~.f-live,#m-both:checked~.f-live{display:block}
.err{background:#2a1416;border:1px solid #6b2a2f;color:#ffd7d7;padding:11px 12px;border-radius:10px;margin:12px 0}
.warn{background:#2a2412;border:1px solid #6b5a22;color:#ffe9a8;padding:11px 12px;border-radius:10px;margin:14px 0;font-size:.92rem}
.hint{color:var(--muted);font-size:.9rem}
.btns{display:flex;gap:10px;margin-top:6px}
button,.btn{padding:11px 18px;border-radius:10px;border:1px solid var(--border);font-size:16px;font-weight:600;cursor:pointer;text-decoration:none;display:inline-block}
.ok{background:var(--accent);color:#06121f;border-color:var(--accent)}.ok:hover,.btn:hover{background:var(--accent-h)}
.no{background:transparent;color:var(--text)}
.done{text-align:center}
.done .btn{background:var(--accent);color:#06121f;border-color:var(--accent);margin-top:14px}
`;

const HEADER = `<header class="top"><div><span class="brand">Homeserver-<b>LAB</b></span><span class="sub">Trading 212 × Claude</span></div></header>`;

function shell(title: string, body: string, extraHead = ""): string {
  return `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#0b0f14">
${extraHead}<title>${esc(title)}</title>
<style>${STYLE}</style>
${HEADER}
<main>${body}</main></html>`;
}

function page(details: ConsentDescription | null, handle: string, needsPassword: boolean, error?: string): string {
  const origin = details?.clientDomain
    ? `Published by <strong>${esc(details.clientDomain)}</strong>.`
    : "This app registered itself; its name is not verified.";
  const intro = details
    ? `<p><strong>${esc(details.clientName)}</strong> wants to access your account. ${origin} Access will be sent to <strong>${esc(details.redirectHost)}</strong>.</p>`
    : "<p>Fix the details and try again (Claude's original request is still waiting).</p>";
  const body = `<div class="card">
<h1>Connect Trading 212</h1>
${intro}
${details?.redirectIsLoopback ? '<div class="warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started it.</div>' : ""}
${error ? `<div class="err">${esc(error)}</div>` : ""}
<form method="post">
 <input type="hidden" name="handle" value="${esc(handle)}">
 <div class="modes">
 <p><strong>Which account do you want to connect?</strong></p>
 <input type="radio" id="m-demo" name="mode" value="demo" checked><label class="m" for="m-demo"><strong>DEMO</strong> — simulated money</label><br>
 <input type="radio" id="m-live" name="mode" value="live"><label class="m" for="m-live"><strong>LIVE</strong> — real money</label><br>
 <input type="radio" id="m-both" name="mode" value="both"><label class="m" for="m-both"><strong>Both</strong> (demo and live)</label>
 <fieldset class="f-demo"><legend><strong>DEMO</strong> — simulated money</legend>
  <label for="dk">API Key (demo)</label>
  <input id="dk" name="demoKey" type="text" autocomplete="off" autocapitalize="off" spellcheck="false">
  <label for="ds">API Secret (demo)</label>
  <input id="ds" name="demoSecret" type="password" autocomplete="off">
 </fieldset>
 <fieldset class="f-live"><legend><strong>LIVE</strong> — REAL money</legend>
  <label for="lk">API Key (live)</label>
  <input id="lk" name="liveKey" type="text" autocomplete="off" autocapitalize="off" spellcheck="false">
  <label for="ls">API Secret (live)</label>
  <input id="ls" name="liveSecret" type="password" autocomplete="off">
  <div class="row"><input type="checkbox" id="r" name="liveReadOnly" value="1"><label for="r">LIVE account read-only (blocks placing/cancelling orders and pies with real money)</label></div>
 </fieldset>
 </div>
 <p class="hint">When both are connected, Claude must say whether each action is on <em>demo</em> or <em>live</em>.</p>
 ${needsPassword ? '<label for="p">Setup password</label><input id="p" name="setupPassword" type="password" autocomplete="off" required>' : ""}
 <div class="warn">Your keys are stored encrypted and only used to talk to Trading 212. DEMO and LIVE keys are different (generated in different environments of the app). Create each key with only the permissions you need.</div>
 <div class="btns"><button class="ok" name="decision" value="approve">Connect</button><button class="no" name="decision" value="deny" formnovalidate>Cancel</button></div>
</form>
</div>
<script>${SCRIPT}</script>`;
  return shell("Connect Trading 212", body);
}

function donePage(redirectTo: string): string {
  const url = esc(redirectTo);
  const body = `<div class="card done">
<h1>✅ Connected</h1>
<p>Returning to Claude… If nothing happens, tap the button. You can then close this page.</p>
<a class="btn" href="${url}">Back to Claude</a>
</div>`;
  return shell("Trading 212 connected", body, `<meta http-equiv="refresh" content="0;url=${url}">\n`);
}

function message(text: string, status = 400): Response {
  return new Response(shell("Trading 212", `<div class="card"><p>${esc(text)}</p></div>`), { status, headers: SECURITY_HEADERS });
}

async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const needsPassword = Boolean(env.SETUP_PASSWORD);

  try {
    console.log(`[auth] ${request.method} /authorize`); // TEMP-LOG
    if (request.method === "GET") {
      const authRequest = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) consent.headers.set(k, v);
      return new Response(page(details, consent.handle, needsPassword), { headers: consent.headers });
    }

    if (request.method === "POST") {
      const form = await request.formData();
      const handle = String(form.get("handle") ?? "");

      if (form.get("decision") !== "approve") {
        const denied = await oauth.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }

      const field = (n: string) => String(form.get(n) ?? "").trim();
      const mode = field("mode");
      const wantDemo = mode === "demo" || mode === "both";
      const wantLive = mode === "live" || mode === "both";
      // Only the account(s) chosen in the menu count; fields from other options are ignored.
      const demo: Account | undefined = wantDemo ? { apiKey: field("demoKey"), apiSecret: field("demoSecret") } : undefined;
      const live: Account | undefined = wantLive ? { apiKey: field("liveKey"), apiSecret: field("liveSecret") } : undefined;
      const liveReadOnly = wantLive && form.get("liveReadOnly") === "1";

      // Validate everything BEFORE consuming the handle, so an error can be shown on the same page.
      const tStart = Date.now(); // TEMP-LOG
      console.log(`[auth] POST received mode=${mode} demo=${Boolean(demo)} live=${Boolean(live)}`); // TEMP-LOG
      const problem = await validate(env, form, { demo, live });
      console.log(`[auth] validate ${problem ? "FAILED: " + problem : "ok"} in ${Date.now() - tStart}ms`); // TEMP-LOG
      if (problem) {
        // The handle is still valid (not consumed): show the form again with the error.
        return new Response(page(null, handle, needsPassword, problem), { status: 400, headers: SECURITY_HEADERS });
      }

      const tApprove = Date.now(); // TEMP-LOG
      const approved = await oauth.approveConsent(request, handle);
      console.log(`[auth] approveConsent in ${Date.now() - tApprove}ms`); // TEMP-LOG
      const userId = (await sha256(`${demo?.apiKey ?? ""}|${live?.apiKey ?? ""}`)).slice(0, 24);
      const props: Props = { userId, demo, live, liveReadOnly };
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request,
        userId,
        metadata: { demo: Boolean(demo), live: Boolean(live), liveReadOnly },
        scope: approved.request.scope,
        props,
      });
      console.log(`[auth] completeAuthorization ok, total ${Date.now() - tStart}ms`); // TEMP-LOG
      // Instead of a silent 302 (on mobile it leaves the stale form open), show a completion page
      // with an automatic redirect and a button back to Claude.
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) approved.headers.set(k, v);
      return new Response(donePage(redirectTo), { status: 200, headers: approved.headers });
    }

    return new Response("Method not allowed", { status: 405 });
  } catch (error) {
    console.log(`[auth] ERROR: ${error instanceof Error ? error.name + ": " + error.message : String(error)}`); // TEMP-LOG
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError) return message(error.description ?? "Invalid authorization request.");
    if (error instanceof CimdFetchError) return message("Could not verify this application.");
    throw error;
  }
}

async function validate(env: Env, form: FormData, accounts: { demo?: Account; live?: Account }): Promise<string | null> {
  if (env.SETUP_PASSWORD) {
    const given = String(form.get("setupPassword") ?? "");
    if (!(await safeEqual(given, env.SETUP_PASSWORD))) return "Incorrect setup password.";
  }
  if (!accounts.demo && !accounts.live) return "Choose which account you want to connect (DEMO, LIVE or both).";
  const checks = (["demo", "live"] as const satisfies readonly T212Env[]).map(async (name): Promise<string | null> => {
    const acc = accounts[name];
    if (!acc) return null;
    const label = name.toUpperCase();
    if (!acc.apiKey || !acc.apiSecret) return `${label} account: enter the API Key and the API Secret.`;
    try {
      await t212({ ...acc, env: name }, "GET", "/equity/account/summary");
    } catch (e) {
      if (e instanceof T212Error && e.status === 401) {
        return `Trading 212 rejected the ${label} keys. Make sure the key really belongs to that environment (demo and live keys are different).`;
      }
      if (e instanceof T212Error && e.status === 403) {
        return `${label} account: the key has no permission to read the account summary. Enable the read permissions in Trading 212.`;
      }
      return `${label} account: could not validate the keys: ${e instanceof Error ? e.message : String(e)}`;
    }
    return null;
  });
  // The two accounts have separate rate limits, so they are validated in parallel.
  const problems = (await Promise.all(checks)).filter((p): p is string => p !== null);
  if (problems.length) return problems.join(" ");
  return null;
}

export const authHandler = {
  fetch(request: Request, env: Env): Promise<Response> | Response {
    const { pathname } = new URL(request.url);
    if (pathname === "/authorize") return handleAuthorize(request, env);
    if (pathname === "/") return new Response("Trading 212 MCP server. Connect it in Claude under Connectors.", { status: 200 });
    return new Response("Not found", { status: 404 });
  },
};
