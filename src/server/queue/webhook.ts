// spiderman
import * as crypto from "crypto";
import * as dns from "dns/promises";
import * as http from "http";
import * as https from "https";
import * as net from "net";
import { ErroValidacao } from "../../types";

/** Enderecos que um webhook nao pode alcancar (loopback, rede privada, link-local/metadata de nuvem). */
function enderecoPrivado(ip: string): boolean {
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l.startsWith("::ffff:")) return enderecoPrivado(l.slice(7));
    return l === "::1" || l === "::" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80");
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

/** Validacao sincrona (na criacao da tarefa): so http(s), sem credenciais e sem IP privado literal. */
export function validarUrlWebhook(url: string, permitirRedePrivada: boolean): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ErroValidacao("webhookUrl invalida.");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new ErroValidacao("webhookUrl deve usar http ou https.");
  if (u.username || u.password) throw new ErroValidacao("webhookUrl nao pode conter credenciais.");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!permitirRedePrivada && (host === "localhost" || host.endsWith(".localhost") || (net.isIP(host) && enderecoPrivado(host)))) {
    throw new ErroValidacao("webhookUrl nao pode apontar para rede local/privada.");
  }
  return u;
}

/**
 * Entrega um webhook assinado: corpo JSON + cabecalho
 * `X-Greencode-Signature: sha256=<HMAC-SHA256(segredo, corpo)>`.
 * O lookup proprio resolve o DNS uma unica vez e recusa destino privado: a conexao usa o mesmo IP
 * que foi validado, entao nao ha janela de DNS rebinding. Sem redirecionamentos, timeout de 5s.
 */
export async function entregarWebhook(url: string, segredo: string, evento: object, permitirRedePrivada: boolean): Promise<void> {
  const u = validarUrlWebhook(url, permitirRedePrivada);
  const corpo = JSON.stringify(evento);
  const assinatura = crypto.createHmac("sha256", segredo).update(corpo).digest("hex");
  const lookup = (host: string, opts: { all?: boolean }, cb: (...a: any[]) => void): void => {
    dns.lookup(host, { all: true }).then(
      (enderecos) => {
        if (!permitirRedePrivada && enderecos.some((e) => enderecoPrivado(e.address))) {
          return cb(new Error("destino do webhook resolve para rede privada"));
        }
        if (opts.all) cb(null, enderecos);
        else cb(null, enderecos[0].address, enderecos[0].family);
      },
      (e) => cb(e),
    );
  };
  const enviar = u.protocol === "https:" ? https.request : http.request;
  const status = await new Promise<number>((resolve, reject) => {
    const req = enviar(u, {
      method: "POST",
      lookup,
      timeout: 5000,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(corpo),
        "x-greencode-signature": `sha256=${assinatura}`,
        "user-agent": "greencode-webhook/1",
      },
    } as http.RequestOptions, (resp) => {
      resp.resume();
      resolve(resp.statusCode ?? 0);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(corpo);
  });
  if (status < 200 || status >= 300) throw new Error(`parceiro respondeu HTTP ${status}`);
}
