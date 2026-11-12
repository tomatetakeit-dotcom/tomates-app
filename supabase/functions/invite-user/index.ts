// Edge Function: invite-user
// Invita a una persona por correo y registra su rol, o crea un usuario SIN correo
// (nombre de usuario + contraseña temporal), o cambia la contraseña de alguien.
// Solo la puede usar quien tenga el permiso "usuarios.gestionar"; solo un administrador
// puede crear o tocar a otro administrador.
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const ROLES = ["admin", "supervisor", "cajero", "asesor", "domiciliario", "cocina"];
const USERNAME_DOMAIN = "usuarios.tomates.invalid";  // dominio reservado: nunca recibe correos

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
  const action = String(body.action || "invite");

  // ---------- Usuario sin correo: nombre de usuario + contraseña temporal ----------
  if (action === "create_username") {
    const username = String(body.username || "").trim().toLowerCase();
    const password = String(body.password || "");
    const uname = String(body.name || "").trim().slice(0, 120);
    const urole = String(body.role || "");
    if (!/^[a-z0-9][a-z0-9._-]{2,29}$/.test(username)) {
      return json({ error: "Usuario no válido: 3 a 30 caracteres, letras minúsculas, números, punto, guion o guion bajo." }, 400);
    }
    if (password.length < 8) return json({ error: "La contraseña debe tener mínimo 8 caracteres." }, 400);
    if (!ROLES.includes(urole)) return json({ error: "Rol no válido." }, 400);
    if (urole === "admin" && callerRole !== "admin") return json({ error: "Solo un administrador puede crear otro administrador." }, 403);
    const uemail = `${username}@${USERNAME_DOMAIN}`;
    const { data: dup } = await admin.from("profiles").select("id").eq("email", uemail).maybeSingle();
    if (dup) return json({ error: "Ese nombre de usuario ya existe." }, 409);
    const { error: iErr } = await admin.from("invitations").upsert({
      email: uemail, name: uname || username, phone: "", role: urole, invited_by: callerId, accepted_at: new Date().toISOString(),
    });
    if (iErr) return json({ error: "No se pudo registrar el usuario." }, 500);
    const { error: cErr } = await admin.auth.admin.createUser({
      email: uemail, password, email_confirm: true,
      user_metadata: { name: uname || username, username, must_change_password: true },
    });
    if (cErr) return json({ error: "No se pudo crear el usuario: " + cErr.message }, 500);
    return json({ ok: true, username });
  }

  // ---------- Cambiar la contraseña de una persona (queda como temporal) ----------
  if (action === "set_password") {
    const userId = String(body.userId || "");
    const password = String(body.password || "");
    if (password.length < 8) return json({ error: "La contraseña debe tener mínimo 8 caracteres." }, 400);
    if (userId === callerId) return json({ error: "Cambia tu propia contraseña desde tu sesión." }, 400);
    const { data: target } = await admin.from("profiles").select("id, role").eq("id", userId).maybeSingle();
    if (!target) return json({ error: "Usuario no encontrado." }, 404);
    if (target.role === "admin" && callerRole !== "admin") return json({ error: "Solo un administrador puede cambiar la contraseña de otro administrador." }, 403);
    const { data: au } = await admin.auth.admin.getUserById(userId);
    const meta = { ...(au?.user?.user_metadata || {}), must_change_password: true };
    const { error: pErr } = await admin.auth.admin.updateUserById(userId, { password, user_metadata: meta });
    if (pErr) return json({ error: "No se pudo cambiar la contraseña: " + pErr.message }, 500);
    return json({ ok: true });
  }

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
