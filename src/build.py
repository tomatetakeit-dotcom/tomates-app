"""Construye site/index.html a partir de la app original + adaptador Supabase.
Uso: python3 -I build.py <app_original.html> <carpeta_salida> [--mock]
Cada reemplazo debe existir exactamente las veces indicadas; si no, falla.
"""
import sys, pathlib

src = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
out_dir = pathlib.Path(sys.argv[2]); out_dir.mkdir(parents=True, exist_ok=True)
mock = "--mock" in sys.argv
here = pathlib.Path(__file__).parent

def rep(s, old, new, count=1):
    n = s.count(old)
    if n != count:
        raise SystemExit(f"Esperaba {count} coincidencia(s) y hay {n}: {old[:80]!r}")
    return s.replace(old, new)

# 1) Chequeos de rol -> permisos
s = src
s = rep(s, "if(myRole!=='admin'){ wrap.innerHTML=''; return; }", "if(!can('ventas.aprobar_cambios')){ wrap.innerHTML=''; return; }")
s = rep(s, "const needsApproval = editingOrderId && myRole!=='admin';", "const needsApproval = editingOrderId && !can('ventas.editar');")
s = rep(s, "    if(myRole==='admin'){\n      await db.collection('orders').doc(editingOrderId)", "    if(can('ventas.editar')){\n      await db.collection('orders').doc(editingOrderId)")
s = rep(s, "  const today = todayStr();\n  const isAdmin = myRole==='admin';\n  const L = buildCashLedger();", "  const today = todayStr();\n  const isAdmin = can('caja.cuadrar');\n  const L = buildCashLedger();")
s = rep(s, "  const isAdmin = myRole==='admin';\n  if(!isAdmin) ventasView = 'pedidos';", "  const isAdmin = can('informes.ver');\n  if(!isAdmin) ventasView = 'pedidos';")
s = rep(s, "if(ventasView!=='historial' || myRole!=='admin')", "if(ventasView!=='historial' || !can('informes.ver'))")
s = rep(s, "let myRole = 'admin'; // por defecto admin si no hay control de usuarios disponible", "let myRole = ''; // lo define el inicio de sesión")
# Las solicitudes de cambio deben llevar el id de quien las pide (regla de la base de datos)
s = rep(s, "requestedBy: myUid||null,", "requestedBy: myUid,")
# La categoría Domicilios solo la crea quien puede gestionar gastos
s = rep(s, "    if(!db) return;\n    const exists = state.categories.some(c=>c.scope==='gastos' && c.name==='Domicilios');",
           "    if(!db || !can('gastos.gestionar')) return;\n    const exists = state.categories.some(c=>c.scope==='gastos' && c.name==='Domicilios');")

# Menú: sin costo ni margen (esa información es solo del administrador, en la pestaña Análisis)
s = rep(s, """      ${cost!==null ? `<div class="row" style="margin-top:6px">
          <span class="item-meta">Costo: ${fmt(cost)}</span>
          <span class="pill ${marginPct>=40?'good':marginPct>=20?'warn':'bad'}">Margen ${marginPct}%</span>
        </div>` : ''}
""", "")

# Costo por unidad con decimales (los insumos se costean por gramo)
s = rep(s, "Costo unit.: ${fmt(i.currentCost||0)}", "Costo: ${fmtCost(i.currentCost||0)} por ${i.unit}")

# 2) Estilos de acceso, chip de usuario y matriz de permisos
css = (here / "auth.css").read_text(encoding="utf-8") + "\n" + (here / "brand.css").read_text(encoding="utf-8")
head_extra = """<meta name="theme-color" content="#FF3035">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" type="image/png" sizes="48x48" href="brand/icons/favicon-48.png">
<link rel="apple-touch-icon" href="brand/icons/apple-touch-icon.png">
<meta name="apple-mobile-web-app-title" content="Tomates">
<meta name="mobile-web-app-capable" content="yes">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Anton&display=swap">
"""
s = rep(s, "</head>", f"{head_extra}<style>\n{css}\n</style>\n</head>")
s = rep(s, "<title>Tomates App</title>", "<title>Tomates Pizzería</title>")
s = rep(s, "<h1>Tomates App</h1>", "<h1>Tomates Pizzería</h1>")

# 3) Librería Supabase + adaptador antes del script principal; acceso y ajustes después
lib = '<script src="vendor/supabase.js"></script>' if mock else \
      '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.57.4/dist/umd/supabase.js"></script>'
pre = "" if mock else lib + "\n"
if mock:
    pre += "<script>\n" + (here / "mock.js").read_text(encoding="utf-8") + "\n</script>\n"
pre += "<script>\n" + (here / "adapter.js").read_text(encoding="utf-8") + "\n</script>\n"
marker = '<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>'
if mock:
    s = rep(s, marker, pre)  # sin internet en las pruebas
else:
    s = rep(s, marker, marker + "\n" + pre)
post = "<script>\n" + (here / "analysis.js").read_text(encoding="utf-8") + "\n</script>\n"
post += "<script>\n" + (here / "auth.js").read_text(encoding="utf-8") + "\n</script>\n"
post += "<script>\n" + (here / "history.js").read_text(encoding="utf-8") + "\n</script>\n"
post += "<script>\n" + (here / "pwa.js").read_text(encoding="utf-8") + "\n</script>\n"
s = rep(s, "</body>", post + "</body>")

(out_dir / "index.html").write_text(s, encoding="utf-8")
import shutil
for extra in (here.parent / "dist-static", here.parent / "brand"):
    if extra.exists():
        dst = out_dir if extra.name == "dist-static" else out_dir / "brand"
        shutil.copytree(extra, dst, dirs_exist_ok=True)
print("ok", len(s))
