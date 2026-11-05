// Edge Function: invite-user
// Invita a una persona por correo y registra su rol. Solo la puede usar quien tenga
// el permiso "usuarios.gestionar"; solo un administrador puede invitar a otro administrador.
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const ROLES = ["admin", "supervisor", "cajero", "asesor", "domiciliario", "cocina"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  let serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!serviceKey) {
    try { const k = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}"); serviceKey = k.default || Object.values(k)[0] as string || ""; } catch { /* sin llaves */ }
  }
  if (!serviceKey) return json({ error: "La función no tiene llave de servicio configurada." }, 500);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Quién hace la invitación
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: who, error: whoErr } = await admin.auth.getUser(jwt);
  if (whoErr || !who?.user) return json({ error: "Inicia sesión de nuevo." }, 401);
  const callerId = who.user.id;

  const { data: caller } = await admin.from("profiles").select("role").eq("id", callerId).maybeSingle();
  const callerRole = caller?.role;
  let allowed = callerRole === "admin";
  if (!allowed && callerRole) {
    const { data: rp } = await admin.from("role_permissions").select("permission")
      .eq("role", callerRole).eq("permission", "usuarios.gestionar").maybeSingle();
    allowed = !!rp;
  }
  if (!allowed) return json({ error: "No tienes permiso para invitar usuarios." }, 403);

  let body: Record<string, string>;
  try { body = await req.json(); } catch { return json({ error: "Solicitud no válida." }, 400); }
  const email = String(body.email || "").trim().toLowerCase();
  const name = String(body.name || "").trim().slice(0, 120);
  const phone = String(body.phone || "").trim().slice(0, 30);
  const role = String(body.role || "");
  const redirectTo = String(body.redirectTo || "");

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "Correo no válido." }, 400);
  if (!ROLES.includes(role)) return json({ error: "Rol no válido." }, 400);
  if (role === "admin" && callerRole !== "admin") {
    return json({ error: "Solo un administrador puede invitar a otro administrador." }, 403);
  }

  // ¿Ya tiene cuenta? Si ya entró alguna vez, se le cambia el rol desde la lista.
  // Si nunca entró (invitación sin aceptar), se reenvía la invitación.
  const { data: existing } = await admin.from("profiles").select("id, role, last_seen_at").eq("email", email).maybeSingle();
  if (existing) {
    const { data: au } = await admin.auth.admin.getUserById(existing.id);
    if (existing.last_seen_at || au?.user?.last_sign_in_at) {
      return json({ error: "Esa persona ya tiene cuenta. Cambia su rol en la lista de usuarios." }, 409);
    }
    if (existing.role === "admin" && callerRole !== "admin") {
      return json({ error: "Solo un administrador puede reenviar la invitación de un administrador." }, 403);
    }
    // Se borra la cuenta sin usar para crearla de nuevo con los datos actualizados
    await admin.auth.admin.deleteUser(existing.id);
  }

  const { error: invErr } = await admin.from("invitations").upsert({
    email, name, phone, role, invited_by: callerId, accepted_at: null,
  });
  if (invErr) return json({ error: "No se pudo guardar la invitación." }, 500);

  const { error: mailErr } = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo: redirectTo || undefined,
    data: { name },
  });
  if (mailErr) return json({ error: "No se pudo enviar el correo: " + mailErr.message }, 500);
  return json({ ok: true });
});
