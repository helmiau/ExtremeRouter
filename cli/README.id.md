<div align="center">

# ExtremeRouter — AI Gateway Control Plane

**Gateway AI self-hosted yang merutekan trafik dari tools coding AI Anda ke 304+ provider dengan terjemahan format, fallback cerdas, pelacakan kuota, dan penghematan token 20–40%.**

Hubungkan Claude Code, Codex, Cursor, Antigravity, Copilot, Gemini, OpenCode, Cline, OpenClaw, dan klien apa pun yang kompatibel OpenAI/Anthropic ke satu endpoint terpadu.

**Bahasa:** [English](README.md) · [Bahasa Indonesia](README.id.md) · [简体中文](README.zh-CN.md)

[![npm](https://img.shields.io/npm/v/@rsalmn/extremerouter.svg)](https://www.npmjs.com/package/@rsalmn/extremerouter)
[![Downloads](https://img.shields.io/npm/dm/@rsalmn/extremerouter.svg)](https://www.npmjs.com/package/@rsalmn/extremerouter)
[![License](https://img.shields.io/npm/l/@rsalmn/extremerouter.svg)](https://github.com/rsalmn/extremerouter/blob/main/LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-rsalmn%2Fextremerouter-blue?logo=github)](https://github.com/rsalmn/extremerouter)

</div>

---

## Daftar Isi

- [Mulai Cepat](#mulai-cepat)
- [Opsi CLI](#opsi-cli)
- [Tools yang Didukung](#tools-yang-didukung)
- [Lokasi Data](#lokasi-data)
- [Docker](#docker)
- [Dokumentasi](#dokumentasi)
- [Lisensi](#lisensi)

---

## Mulai Cepat

**Install global:**

```bash
npm install -g @rsalmn/extremerouter
extremerouter
```

Dashboard terbuka di `http://localhost:20128` (password login pertama default: `123456` — segera ganti).

**Jalankan dengan npx (tanpa install):**

```bash
npx @rsalmn/extremerouter
```

**Hubungkan provider dan mulai menggunakannya:**

1. Dashboard → **Providers** → hubungkan provider (login OAuth, API key, atau cookie browser).
2. Salin API key Anda dari **Endpoint**.
3. Arahkan tools CLI Anda ke gateway:

```
Endpoint: http://localhost:20128/v1
API Key:  [key Anda]
Model:    <provider>/<model>   (mis. kr/claude-sonnet-4.5)
```

---

## Opsi CLI

```bash
extremerouter                  # Mulai dengan pengaturan default
extremerouter -p 8080          # Port kustom (default: 20128)
extremerouter -H 0.0.0.0       # Bind ke semua antarmuka
extremerouter -n               # Jangan buka browser saat start
extremerouter -l ./er.log      # Tulis log ke file
extremerouter -t               # Mulai dalam mode system tray
extremerouter --skip-update    # Lewati pemeriksaan auto-update
extremerouter -h               # Tampilkan bantuan
extremerouter -v               # Tampilkan versi
```

| Opsi | Deskripsi |
|------|-----------|
| `-p, --port <port>` | Port untuk menjalankan server (default: `20128`) |
| `-H, --host <host>` | Host yang di-bind (default: `0.0.0.0` — gunakan `127.0.0.1` untuk lokal saja) |
| `-n, --no-browser` | Jangan buka browser otomatis |
| `-l, --log <file>` | Tulis log request ke file |
| `-t, --tray` | Mulai diminimalkan di system tray |
| `--skip-update` | Lewati pemeriksaan auto-update |
| `-h, --help` | Tampilkan pesan bantuan ini |
| `-v, --version` | Tampilkan versi terpasang |

**Dashboard**: `http://localhost:20128/dashboard`

> **Catatan jaringan:** server me-bind `0.0.0.0` secara default, sehingga dapat diakses di LAN Anda. Untuk lokal saja, mulai dengan `-H 127.0.0.1`.

---

## Tools yang Didukung

Claude Code, Codex, Cursor, Antigravity, Copilot, Cline, OpenCode, OpenClaw, Gemini CLI, Droid, Roo, Kilo Code, Qwen, iFlow, Continue, Zed, Aider — dan klien apa pun yang kompatibel OpenAI/Anthropic. Tanpa plugin; cukup arahkan endpoint ke `http://localhost:20128/v1`.

---

## Lokasi Data

- **macOS / Linux**: `~/.extremerouter/`
- **Windows**: `%APPDATA%/extremerouter/`
- **Docker**: `/app/data/` (mount `$HOME/.extremerouter` agar persisten)

Peluncuran pertama otomatis memigrasikan provider, key, combo, dan settings dari versi lama. Data lama Anda dibiarkan utuh sehingga bisa rollback.

---

## Docker

```bash
docker run -d --name extremerouter -p 20128:20128 \
  -v "$HOME/.extremerouter:/app/data" -e DATA_DIR=/app/data \
  rsalmn/extremerouter:latest
```

---

## Dokumentasi

- **Repository**: https://github.com/rsalmn/extremerouter
- **Issues**: https://github.com/rsalmn/extremerouter/issues
- **Docker Hub**: https://hub.docker.com/r/rsalmn/extremerouter

---

## Lisensi

Lisensi MIT — lihat [LICENSE](LICENSE) untuk detail.
