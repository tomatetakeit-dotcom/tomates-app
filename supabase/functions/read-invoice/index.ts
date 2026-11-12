// Edge Function: read-invoice
// Recibe la foto de una factura (JPEG/PNG en base64) y la lee con IA (Claude).
// Devuelve proveedor, número, fecha, líneas y total, y sugiere a qué insumo o
// categoría de gasto corresponde cada línea. NO guarda nada: la persona revisa
// y confirma en la app. Requiere el permiso "compras.gestionar".
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
      .eq("role", prof.role).eq("permission", "compras.gestionar").maybeSingle();
    allowed = !!rp;
  }
  if (!allowed) return json({ error: "No tienes permiso para registrar facturas." }, 403);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY") || "";
  if (!apiKey) return json({ error: "Falta configurar la llave de IA (ANTHROPIC_API_KEY) en Supabase.", code: "no_key" }, 503);
  const model = Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-4-5";

  let body: { image?: string; mediaType?: string; ingredients?: unknown; categories?: unknown };
  try { body = await req.json(); } catch { return json({ error: "Solicitud no válida." }, 400); }
  const image = String(body.image || "");
  const mediaType = ["image/jpeg", "image/png", "image/webp"].includes(String(body.mediaType)) ? String(body.mediaType) : "image/jpeg";
  if (!image || image.length > 7_000_000) return json({ error: "La imagen falta o es demasiado grande." }, 400);
  const ingredients = Array.isArray(body.ingredients) ? body.ingredients.slice(0, 300) : [];
  const categories = Array.isArray(body.categories) ? body.categories.slice(0, 100) : [];

  const prompt = `Eres el asistente contable de una pizzería en Colombia. Lee la factura o recibo de la imagen.
Responde SOLO con un objeto JSON válido (sin texto antes ni después) con esta forma:
{"proveedor":"","nit":"","numero":"","fecha":"AAAA-MM-DD","metodo_pago":"efectivo|transferencia|tarjeta|credito|desconocido",
 "subtotal":0,"iva":0,"total":0,
 "lineas":[{"descripcion":"","cantidad":0,"unidad":"","valor_total":0,"tipo":"insumo|gasto","insumo_id":null,"cantidad_insumo":null,"categoria_gasto":null}],
 "legible":true,"observaciones":""}
Reglas:
- Valores en pesos colombianos como números enteros, sin puntos ni signos ($12.500 → 12500).
- valor_total de cada línea es lo que se pagó por esa línea INCLUYENDO su parte de impuestos, de modo que la suma de las líneas sea igual al total de la factura.
- Si es un insumo de cocina, elige insumo_id SOLO de esta lista (id, nombre, unidad) y convierte la cantidad a la unidad del insumo en cantidad_insumo (por ejemplo 2 kg con unidad g → 2000; 1 L con unidad ml → 1000; 1 docena con unidad und → 12). Si no estás seguro, deja insumo_id en null.
Insumos: ${JSON.stringify(ingredients)}
- Si no es un insumo (servicios, aseo, empaques, arriendo, etc.) usa tipo "gasto" y sugiere categoria_gasto de esta lista: ${JSON.stringify(categories)}.
- Si la fecha no aparece, deja "". Si la imagen no es legible o no es una factura, pon "legible": false y explica en observaciones.`;

  let r: Response;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model, max_tokens: 4000,
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
          { type: "text", text: prompt },
        ] }],
      }),
    });
  } catch (e) {
    return json({ error: "No se pudo contactar el servicio de IA: " + (e as Error).message }, 502);
  }
  const out = await r.json().catch(() => null);
  if (!r.ok) return json({ error: "El servicio de IA respondió con error: " + (out?.error?.message || r.status) }, 502);
  const text = (out?.content || []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return json({ error: "La IA no devolvió datos legibles. Intenta con otra foto." }, 502);
  let parsed: unknown;
  try { parsed = JSON.parse(m[0]); } catch { return json({ error: "La IA devolvió datos incompletos. Intenta de nuevo." }, 502); }
  return json({ ok: true, model, data: parsed });
});
