# Scripts NEON · Migración WhatsApp

Scripts de uso único para llevar el historial del 6573 al CRM antes de migrar a Cloud API.

## scrape-wa-history.js — Importar historial

Usa `whatsapp-web.js` para iterar todos los chats de WhatsApp Web del 6573 y subirlos al CRM (tabla `wa_messages` en D1).

### Requisitos

- Node.js 18+
- Chrome instalado (whatsapp-web.js lo lanza headless)
- El celular del 6573 con WhatsApp Business funcionando
- Token de admin del CRM (de la sesión de Gaspar)

### Setup (una sola vez)

```bash
cd scripts/
npm install
```

### Obtener el token del CRM

1. Abrí el CRM en tu navegador (https://gasparmv.github.io/ni-ventas/)
2. Logueate como **Gaspar**
3. Abrí **DevTools** (F12) → tab **Application** → **Local Storage**
4. Buscá la key `auth_token` y copiá el valor (string largo)
5. Guardalo en `scripts/.crm-token`:

```bash
echo "eyJxxxx...el_token_largo" > .crm-token
```

### Correr

```bash
node scrape-wa-history.js
```

Va a aparecer un QR en la terminal. **Escanealo con WhatsApp Business del celular del 6573**:

1. Abrí WhatsApp Business
2. Ajustes → Dispositivos vinculados → Vincular un dispositivo
3. Apuntá la cámara al QR de la terminal
4. Listo, dejá la PC corriendo

El script va a ir mostrando progreso por chat. Total estimado: 1-4 horas según volumen.

### Output esperado

```
🚀 NEON · Scraper de WhatsApp History
✅ Autenticado
✅ WhatsApp Web listo. Listando chats...
📋 487 chats encontrados.
🎯 412 chats individuales para procesar.

  [1/412] 📥 5491155604999 (Pedro Gomez)...
     ✓ 234 mensajes leídos · 234 insertados · 0 duplicados · 0 errores
  [2/412] 📥 5491155667788 (Maria Lopez)...
     ✓ 89 mensajes leídos · 89 insertados · 0 duplicados · 0 errores
  ...

🎉 DONE
   Chats procesados: 412
   Mensajes insertados: 18234
   Mensajes duplicados (ya en CRM): 56
   Errores: 0
```

### Si se corta

El script guarda progreso en `.scrape-progress.json`. Si se corta a la mitad, **simplemente volvé a correrlo**: retoma desde donde quedó (skip los chats ya procesados).

### Si lo querés correr de cero

```bash
rm -rf .wa-session/ .scrape-progress.json
```

### Limitaciones conocidas

- **WhatsApp Web no expone todo el historial profundo**: solo carga lo que ya está sincronizado en el celular. Para volcar mensajes muy viejos (años) hay que primero asegurarse que el celular tiene el historial cargado (se carga al scrollear hacia arriba en cada chat antes de scrapear).
- **Media (imágenes, audios)**: por ahora solo se importa el placeholder `[imagen]`, `[audio]`, etc. Los archivos en sí no se descargan a R2 (sería ~10GB+ y muy lento). El texto y timestamps quedan completos.
- **Mensajes encriptados / eliminados**: aparecen como `[revoke]` o se omiten.
- **Grupos y status**: se filtran (solo chats 1:1).

### Después de correr

Los chats van a aparecer automáticamente en el CRM (sección Chat WA) con todo su historial.

---

## Plan de migración completo

1. **Hoy domingo**:
   - Correr `scrape-wa-history.js` con la PC prendida
   - Tarda 1-4 hs según volumen
2. **Cuando termine**:
   - Verificar en el CRM que aparecen los chats con historial
3. **Lunes temprano**:
   - Hacer la migración del 6573: ON_PREMISE → CLOUD_API
   - Joaco deja de usar WA Business
   - Todo el WhatsApp del negocio pasa a vivir en el CRM
