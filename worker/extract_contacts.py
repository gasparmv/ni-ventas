#!/usr/bin/env python3
"""
Extrae contactos del CSV del form, normaliza teléfonos a E.164 sin '+',
extrae el primer nombre, excluye ganadores, y emite un JSON listo para
enviar a /admin/wa/send-bulk con per-recipient params.
"""
import csv, json, re, sys

WINNERS = {
    'ivana callero',
    'guillermo siero',
    'renzo gonzalez quiroga',
}

def norm_name(s):
    return (s or '').strip().lower()

def first_name(full_name):
    if not full_name:
        return ''
    parts = full_name.strip().split()
    if not parts:
        return ''
    fn = parts[0]
    # Capitalize: 'maria jose' -> 'Maria'
    return fn.capitalize()

def normalize_ar_phone(raw):
    """E.164 sin '+'. Mismo criterio que normalizeArPhone() del worker."""
    n = re.sub(r'\D', '', str(raw or ''))
    if not n:
        return None
    if n.startswith('00'):
        n = n[2:]
    if n.startswith('54'):
        if not n.startswith('549'):
            n = '549' + n[2:]
    else:
        if n.startswith('15'):
            n = n[2:]
        if n.startswith('0'):
            n = n[1:]
        n = '549' + n
    if len(n) < 11 or len(n) > 14:
        return None
    return n

def main():
    src = sys.argv[1] if len(sys.argv) > 1 else '/tmp/form.csv'
    out = sys.argv[2] if len(sys.argv) > 2 else '/tmp/recipients.json'

    rows = []
    with open(src, newline='', encoding='utf-8') as f:
        rd = csv.DictReader(f)
        for r in rd:
            rows.append(r)

    headers = list(rows[0].keys()) if rows else []
    name_col = next((h for h in headers if 'nombre' in h.lower()), None)
    phone_col = next((h for h in headers if 'telefono' in h.lower() or 'teléfono' in h.lower() or 'numero' in h.lower() or 'número' in h.lower()), None)
    if not name_col or not phone_col:
        print(f"No pude identificar columnas. Headers: {headers}", file=sys.stderr)
        sys.exit(1)

    seen_phones = set()
    recipients = []
    excluded_winners = 0
    invalid_phone = 0
    invalid_name = 0
    duplicates = 0

    for r in rows:
        nombre = (r.get(name_col) or '').strip()
        tel = (r.get(phone_col) or '').strip()
        if not nombre:
            invalid_name += 1
            continue
        if norm_name(nombre) in WINNERS:
            excluded_winners += 1
            continue
        phone = normalize_ar_phone(tel)
        if not phone:
            invalid_phone += 1
            continue
        if phone in seen_phones:
            duplicates += 1
            continue
        seen_phones.add(phone)
        recipients.append({
            'phone': phone,
            'params': [first_name(nombre)]
        })

    with open(out, 'w', encoding='utf-8') as f:
        json.dump({'phones': recipients}, f, ensure_ascii=False)

    summary = {
        'total_rows': len(rows),
        'recipients_valid': len(recipients),
        'excluded_winners': excluded_winners,
        'invalid_phone': invalid_phone,
        'invalid_name': invalid_name,
        'duplicates': duplicates,
        'output': out
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()
