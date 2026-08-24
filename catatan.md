# 📋 Catatan Sesi Debugging & Refactoring
**Tanggal:** 25 Agustus 2026
**Repo:** K-sRouter-CLI
**Node:** v26.4.0 (Termux/Android)

---

## 1. Investigasi Awal

### Yang dikerjakan
- Listing seluruh struktur repo (`bin/`, `lib/`, `script/`, root files)
- Baca semua file kunci: `index.js`, `package.json`, `lib/*.js` (19 file total)
- Test eksekusi `node index.js`

### Hasil test pertama
```
INDEX_FAIL: KROUTER_BACKEND_URL env var not set   ← misleading!
ReferenceError: __filename is not defined          ← error asli
```
`node index.js` gagal exit code 1.

### Anomali lingkungan yang berhasil dipecahkan
| Anomali | Penjelasan | Status |
|---------|-----------|--------|
| Banner `◇ injected env ... [www.vestauth.com]` | Iklan rotasi **resmi** dari dotenv v17.4.2 (`lib/main.js`), promosi project baru pembuat dotenv (motdotla) | ✅ Bukan malware |
| Test kadang lolos kadang crash | `node -e "..."` tanpa flag = mode CJS, `__filename` nempel di `globalThis` sehingga module ESM ikut kebaca. Jangan pakai cara ini untuk test ESM | ✅ Pakai `--input-type=module` |
| `.npmrc` rusak | Isi `all="low-scripts=9router"` + `allow-scripts=9router` — bukan ditulis kode repo | ⚠️ Belum dibenerin |

---

## 2. Bug List yang Ditemukan

| # | Severity | Lokasi | Masalah |
|---|----------|--------|---------|
| 1 | 🔴 BLOCKER | `lib/env.js:5-6` | Pakai `__filename`/`__dirname` (global CJS) di file ESM → `ReferenceError`. Variabel `_filename`/`_dirname` sudah didefinisi tapi tidak dipakai |
| 2 | 🟠 High | `package.json` | `bin` menunjuk `./lib/cli.js` yang **tidak ada** — CLI asli di `./bin/cli.js` |
| 3 | 🟠 High | `index.js` | `getRequiredEnv()` dipanggil top-level → SDK gagal di-import kalau env belum diset |
| 4 | 🟡 Medium | `lib/db.js` | `require('better-sqlite3')` — CJS require di project ESM + native module (melanggar aturan stack) + sudah terhapus dari node_modules |
| 5 | 🔴 Critical | `bin/cli.js:48` | `getRequiredEnv()` top-level tanpa graceful handling |
| 6 | 🔴 Critical | `lib/shell.js` | 6 bug sekaligus (lihat detail di bawah) |
| 7 | 🟡 Minor | `lib/memory.js` | `clearProjectMemory()` memanggil `db.clearProjects()` yang **tidak ada** di db.js |
| 8 | 🟢 Smell | `lib/prompt-parser.js` | Blok kode duplikat (`let parsed; try {...}` muncul 2x) — unreachable tapi berantakan |

### Detail bug shell.js
1. `execFile` dipakai tapi tidak pernah di-import dari `child_process`
2. `_approvalResolve`, `_approvalReject`, `_pendingCommand` — undefined variables (peninggalan refactor setengah jalan)
3. `crypto.randomUUID()` tanpa import crypto
4. `notify.hitl()` — fungsi yang benar `notifyHITL()`, plus typo `reqld` vs `reqId`
5. Duplikat deklarasi `hasPendingShellApproval()`
6. Promise approval di `run()` struktur bracket kacau

---

## 3. Fix yang Dilakukan

### Commit `5671cf2` — Fix dasar SDK
- ✅ `lib/env.js`: rename `__filename`→`_filename`, `__dirname`→`_dirname`
- ✅ `index.js`: env resolve jadi lazy via `backendUrl()` — import aman tanpa .env
- ✅ `package.json`: bin path diperbaiki ke `./bin/cli.js`
- ✅ Tambah `.env.example` sebagai template

### Commit `4a2160e` — Migrasi database
- ✅ `lib/db.js`: `better-sqlite3` → `node:sqlite` (`DatabaseSync`)
- ✅ API identik: `prepare().run()/get()/all()`, return shape `{changes, lastInsertRowid}`
- ✅ Drop `better-sqlite3` dari dependencies (zero native modules)

### Commit `c1ab20d` — Fix shell.js + db.js
- ✅ `lib/shell.js`: tambah import `execFile` + `crypto`, hapus semua dead code, fix notify API, fix typo, rapikan promise approval
- ✅ `lib/db.js`: tambah fungsi `clearProjects()`

### Bonus
- ✅ `bin/cli.js`: bootstrap block dengan pesan error ramah kalau env belum diset
- ✅ `.env`: dibuat ulang (gitignored), siap diisi `KROUTER_BACKEND_URL`

---

## 4. Verifikasi

| Test | Hasil |
|------|-------|
| `node index.js` (load normal) | ✅ Exit 0, bersih |
| `status()` tanpa env | ✅ Throw `KROUTER_BACKEND_URL env var not set` (lazy resolve bekerja) |
| `status()` dengan URL dummy | ✅ `Backend server is unreachable.` (URL mengalir sampai core request) |
| DB insert/stats/learning/decision/project/conversation | ✅ ALL_DB_PASS (7/7) |
| `shell.runSafe` injection guard | ✅ Block `rm -rf` attempt |
| `shell.runSafe` eksekusi normal | ✅ Output benar |
| `memory.purgeAllMemory()` full path | ✅ OK, no crash |
| `node bin/cli.js` boot screen | ✅ Muncul normal |

---

## 5. Next Move

### Sebelum production use
- [ ] **Isi `KROUTER_BACKEND_URL` asli** di `.env`, test `status()` ke server backend beneran
- [ ] **Push ke remote** — local main sudah konvergen dengan origin/main, aman tanpa force

### Cleanup (tidak blocker)
- [ ] Bersihkan `~/.npmrc` — hapus 2 baris rusak (`all="low-scripts=9router"` dan `allow-scripts=9router`)
- [ ] Hapus blok duplikat di `lib/prompt-parser.js` (~baris 130-an, `let parsed; try {...}` yang kedua)
- [ ] Review file yang belum diaudit mendalam: isi logika `core.js`, `auth.js`, `providers.js`, `state.js` (baru dibaca struktur-nya saja)

### Ide pengembangan
- [ ] Tambah unit test minimal untuk `db.js` dan `env.js` (regression guard)
- [ ] Dokumentasikan command CLI interaktif di README (subcommand: show/setup/learn/decide/note/skip/clear)

---

## Catatan Teknis Penting

**Cara test ESM yang benar di mesin ini:**
```bash
# ❌ SALAH — hasil misleading (CJS mode, __filename bocor ke global)
node -e "import('./index.js')"

# ✅ BENAR
node --input-type=module -e "const m = await import('./index.js')"
node index.js
```

**Stack rules repo ini (dari QWEN.md):**
- Pure ESM, no CommonJS
- No native modules (gagal build di Termux/ARM)
- Env vars di `.env`, tidak hardcode
