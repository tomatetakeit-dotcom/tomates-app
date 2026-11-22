// Edge Function: read-payment
// Lee con IA (Claude) el comprobante de un pago por QR / transferencia (foto, captura o PDF)
// y devuelve banco, valor, fecha, hora, referencia, destinatario y si la transacción fue exitosa.
// NO confirma nada: la app compara con el pedido y el administrador confirma.
// Requiere el permiso "ventas.cobrar" o "pagos.confirmar".
// Secretos: ANTHROPIC_API_KEY (obligatorio) y ANTHROPIC_MODEL (opcional).
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  let serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!serviceKey) {
    try { const k = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}"); serviceKey = k.default || Object.values(k)[0] as string || ""; } catch { /* sin llaves */ }
  }
  if (!serviceKey) return json({ error: "La función no tiene llave de servicio configurada." }, 500);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: who, error: whoErr } = await admin.auth.getUser(jwt);
  if (whoErr || !who?.user) return json({ error: "Inicia sesión de nuevo." }, 401);
  const { data: prof } = await admin.from("profiles").select("role").eq("id", who.user.id).maybeSingle();
  let allowed = prof?.role === "admin";
  if (!allowed && prof?.role) {
    const { data: rp } = await admin.from("role_permissions").select("permission")
      .eq("role", prof.role).in("permission", ["ventas.cobrar", "pagos.confirmar"]).limit(1);
    allowed = !!(rp && rp.length);
  }
  if (!allowed) return json({ error: "No tienes permiso para registrar pagos." }, 403);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY") || "";
  if (!apiKey) return json({ error: "La lectura con IA no está activa: falta la llave (ANTHROPIC_API_KEY) en Supabase.", code: "no_key" }, 503);
  const model = Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-4-5";

  let body: { file?: string; mediaType?: string; expected?: number; accounts?: unknown; today?: string };
  try { body = await req.json(); } catch { return json({ error: "Solicitud no válida." }, 400); }
  const file = String(body.file || "");
  const isPdf = String(body.mediaType) === "application/pdf";
  const mediaType = isPdf ? "application/pdf" : (["image/jpeg", "image/png", "image/webp"].includes(String(body.mediaType)) ? String(body.mediaType) : "image/jpeg");
  if (!file || file.length > 11_000_000) return json({ error: "El comprobante falta o es demasiado grande." }, 400);
  const accounts = Array.isArray(body.accounts) ? body.accounts.slice(0, 10) : [];

  const prompt = `Eres el asistente de caja de una pizzería en Colombia. Lee el comprobante de pago (transferencia, QR, Nequi, Daviplata, Bancolombia, Bre-B, Bold u otro banco).
Responde SOLO con un objeto JSON válido (sin texto antes ni después) con esta forma:
{"es_comprobante":true,"exitosa":true,"banco_app":"","valor":0,"fecha":"AAAA-MM-DD","hora":"HH:MM",
 "referencia":"","destinatario_nombre":"","destinatario_cuenta":"","remitente_nombre":"","medio":"","legible":true,"observaciones":""}
Reglas:
- valor en pesos colombianos como número entero, sin puntos ni signos ($45.000 → 45000).
- referencia: el número de comprobante, aprobación, transacción o referencia tal como aparece (sin espacios). Si hay varios, el más largo/único.
- destinatario_cuenta: solo los últimos 4 dígitos que se vean de la cuenta, celular o llave de quien RECIBE el dinero.
- exitosa: false si dice rechazada, fallida, pendiente o en proceso.
- fecha en formato AAAA-MM-DD (hoy es ${String(body.today || "")}); hora en 24 h. Si no aparecen, deja "".
- Si la imagen no es un comprobante de pago o no se puede leer, pon "es_comprobante": false o "legible": false y explica en observaciones.
- Señala en observaciones cualquier cosa sospechosa (textos superpuestos, cifras editadas, captura de otra captura).
Valor esperado del pedido: ${Number(body.expected) || 0}. Cuentas de destino del negocio (para comparar): ${JSON.stringify(accounts)}.`;

  const content = [
    isPdf ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: file } }
          : { type: "image", source: { type: "base64", media_type: mediaType, data: file } },
    { type: "text", text: prompt },
  ];
  let r: Response;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 1200, messages: [{ role: "user", content }] }),
    });
  } catch (e) {
    return json({ error: "No se pudo contactar el servicio de IA: " + (e as Error).message }, 502);
  }
  const out = await r.json().catch(() => null);
  if (!r.ok) return json({ error: "El servicio de IA respondió con error: " + (out?.error?.message || r.status) }, 502);
  const text = (out?.content || []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return json({ error: "La IA no pudo leer el comprobante. Escribe la referencia a mano." }, 502);
  let parsed: unknown;
  try { parsed = JSON.parse(m[0]); } catch { return json({ error: "La IA devolvió datos incompletos. Intenta de nuevo." }, 502); }
  return json({ ok: true, model, data: parsed });
});
