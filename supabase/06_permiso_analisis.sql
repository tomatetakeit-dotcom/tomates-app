-- TOMATES APP — v6: permiso para la pestaña "Análisis" (ventas vs compras y márgenes)
-- No se asigna a ningún rol: solo el administrador lo tiene (el admin siempre tiene todos los permisos).
-- Si algún día se quiere dar a otro rol, se marca en Usuarios → Permisos por rol.
insert into public.permissions (key, module, label, sort) values
  ('analisis.ver', 'Análisis', 'Ver análisis exclusivo: ventas vs compras, costo de lo vendido y márgenes', 105)
on conflict (key) do update set module = excluded.module, label = excluded.label, sort = excluded.sort;
select key, label from public.permissions where key = 'analisis.ver';
