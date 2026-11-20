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

const SECURITY_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

function page(details: ConsentDescription | null, handle: string, needsPassword: boolean, error?: string): string {
  const origin = details?.clientDomain
    ? `Publicado por <strong>${esc(details.clientDomain)}</strong>.`
    : "Esta app registou-se a si própria; o nome não está verificado.";
  const intro = details
    ? `<p><strong>${esc(details.clientName)}</strong> quer aceder à tua conta. ${origin} O acesso será enviado para <strong>${esc(details.redirectHost)}</strong>.</p>`
    : "<p>Corrige os dados e tenta de novo (o pedido original do Claude continua a aguardar).</p>";
  return `<!doctype html>
<html lang="pt"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ligar Trading 212</title>
<style>
 body{font:16px/1.5 system-ui,sans-serif;max-width:480px;margin:32px auto;padding:0 16px;color:#111}
 label{display:block;margin:14px 0 4px;font-weight:600}
 input[type=text],input[type=password]{width:100%;padding:10px;border:1px solid #bbb;border-radius:8px;box-sizing:border-box}
 .row{display:flex;gap:8px;align-items:flex-start;margin:10px 0;font-weight:400}
 .err{background:#fde8e8;border:1px solid #e0a0a0;padding:10px;border-radius:8px}
 .warn{background:#fff6e0;border:1px solid #e6c36a;padding:10px;border-radius:8px;margin:12px 0}
 fieldset{border:1px solid #ccc;border-radius:8px;margin:14px 0}
 button{padding:10px 16px;border-radius:8px;border:0;font-size:16px;cursor:pointer}
 .ok{background:#111;color:#fff}.no{background:#eee}
</style>
<h1>Ligar a Trading 212</h1>
${intro}
${details?.redirectIsLoopback ? '<div class="warn"><strong>Isto envia acesso para uma app no teu computador.</strong> Continua só se acabaste de a iniciar.</div>' : ""}
${error ? `<div class="err">${esc(error)}</div>` : ""}
<form method="post">
 <input type="hidden" name="handle" value="${esc(handle)}">
 <fieldset><legend><strong>DEMO</strong> — dinheiro simulado</legend>
  <label for="dk">API Key (demo)</label>
  <input id="dk" name="demoKey" type="text" autocomplete="off">
  <label for="ds">API Secret (demo)</label>
  <input id="ds" name="demoSecret" type="password" autocomplete="off">
 </fieldset>
 <fieldset><legend><strong>LIVE</strong> — dinheiro REAL</legend>
  <label for="lk">API Key (live)</label>
  <input id="lk" name="liveKey" type="text" autocomplete="off">
  <label for="ls">API Secret (live)</label>
  <input id="ls" name="liveSecret" type="password" autocomplete="off">
  <div class="row"><input type="checkbox" id="r" name="liveReadOnly" value="1"><label for="r" style="margin:0;font-weight:400">Conta LIVE só em leitura (bloqueia criar/cancelar ordens e pies no dinheiro real)</label></div>
 </fieldset>
 <p>Preenche uma ou as duas. Com as duas ligadas, o Claude tem de indicar em cada ação se é <em>demo</em> ou <em>live</em>.</p>
 ${needsPassword ? '<label for="p">Palavra-passe de configuração</label><input id="p" name="setupPassword" type="password" autocomplete="off" required>' : ""}
 <div class="warn">As chaves ficam guardadas cifradas e só são usadas para falar com a Trading 212. As chaves DEMO e LIVE são diferentes (geradas em ambientes diferentes da app). Cria cada chave só com as permissões de que precisas.</div>
 <p><button class="ok" name="decision" value="approve">Ligar</button> <button class="no" name="decision" value="deny" formnovalidate>Cancelar</button></p>
</form></html>`;
}

function message(text: string, status = 400): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><p>${esc(text)}</p>`, { status, headers: SECURITY_HEADERS });
}

async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const needsPassword = Boolean(env.SETUP_PASSWORD);

  try {
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
      const demo: Account | undefined = field("demoKey") || field("demoSecret") ? { apiKey: field("demoKey"), apiSecret: field("demoSecret") } : undefined;
      const live: Account | undefined = field("liveKey") || field("liveSecret") ? { apiKey: field("liveKey"), apiSecret: field("liveSecret") } : undefined;
      const liveReadOnly = form.get("liveReadOnly") === "1";

      // Valida tudo ANTES de consumir o handle, para poder mostrar o erro na mesma página.
      const problem = await validate(env, form, { demo, live });
      if (problem) {
        // O handle continua válido (não foi consumido): mostra o formulário outra vez com o erro.
        return new Response(page(null, handle, needsPassword, problem), { status: 400, headers: SECURITY_HEADERS });
      }

      const approved = await oauth.approveConsent(request, handle);
      const userId = (await sha256(`${demo?.apiKey ?? ""}|${live?.apiKey ?? ""}`)).slice(0, 24);
      const props: Props = { userId, demo, live, liveReadOnly };
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request,
        userId,
        metadata: { demo: Boolean(demo), live: Boolean(live), liveReadOnly },
        scope: approved.request.scope,
        props,
      });
      approved.headers.set("Location", redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    }

    return new Response("Method not allowed", { status: 405 });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError) return message(error.description ?? "Pedido de autorização inválido.");
    if (error instanceof CimdFetchError) return message("Não foi possível verificar esta aplicação.");
    throw error;
  }
}

async function validate(env: Env, form: FormData, accounts: { demo?: Account; live?: Account }): Promise<string | null> {
  if (env.SETUP_PASSWORD) {
    const given = String(form.get("setupPassword") ?? "");
    if (!(await safeEqual(given, env.SETUP_PASSWORD))) return "Palavra-passe de configuração incorreta.";
  }
  if (!accounts.demo && !accounts.live) return "Preenche as chaves de pelo menos uma conta (DEMO ou LIVE).";
  for (const name of ["demo", "live"] as const satisfies readonly T212Env[]) {
    const acc = accounts[name];
    if (!acc) continue;
    const label = name.toUpperCase();
    if (!acc.apiKey || !acc.apiSecret) return `Conta ${label}: preenche a API Key e o API Secret.`;
    try {
      await t212({ ...acc, env: name }, "GET", "/equity/account/summary");
    } catch (e) {
      if (e instanceof T212Error && e.status === 401) {
        return `A Trading 212 recusou as chaves da conta ${label}. Confirma que a chave é mesmo desse ambiente (demo e live são diferentes).`;
      }
      if (e instanceof T212Error && e.status === 403) {
        return `Conta ${label}: a chave não tem permissão para ler o resumo da conta. Ativa as permissões de leitura na T212.`;
      }
      return `Conta ${label}: não consegui validar as chaves: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return null;
}

export const authHandler = {
  fetch(request: Request, env: Env): Promise<Response> | Response {
    const { pathname } = new URL(request.url);
    if (pathname === "/authorize") return handleAuthorize(request, env);
    if (pathname === "/") return new Response("Trading 212 MCP server. Liga-o no Claude em Conectores.", { status: 200 });
    return new Response("Not found", { status: 404 });
  },
};
