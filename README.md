# MITRA — Your Personal Psychology Learning Companion

**M**emory, **I**ntelligence, **T**utoring & **R**evision **A**ssistant — *Understand More. Remember Better. Learn with Confidence.*

A local-first web app for a psychology student who finds English terminology hard and wants Tamil explanations. Everything the student saves lives in a SQLite file on her own computer. Online AI is optional and only used when she presses a button.

## What it does
- **MITRA AI Tutor** – explains pasted text or chosen document passages: full, simple English, Tamil, sentence by sentence, terminology, everyday example, main idea, comparison, revision summary.
- **Psychology Dictionary** – 33 built-in terms with simple English and Tamil; add your own; AI can draft a new entry (you confirm first).
- **My Library** – upload PDF, Word or image files; text is extracted on this computer; pick a passage to explain, or make flashcards/quizzes from it.
- **My Notes** – rich notepad with autosave and edit-conflict protection.
- **My Vocabulary** – personal word list with statuses (New / Learning / Needs Revision / Learned).
- **Flashcards** – review with a simple fixed schedule (1 → 3 → 7 → 14 → 30 days; "needs revision" returns tomorrow). AI-drafted cards must be reviewed before saving.
- **Quiz Centre** – multiple-choice and true/false, marked exactly by the server. Questions can be inspected and removed.
- **Calendar, Study & Revision, Learning Progress** – computed only from real stored records.
- Global search (Ctrl+K), dark/light theme, backup & restore, privacy notice.

## What you need to download (dependencies)

**Only one thing to install yourself: Node.js (LTS, version 20 or newer)** — https://nodejs.org (choose the "LTS" Windows installer, keep the default options).

Everything else is downloaded automatically by `setup.bat` (it runs `npm install`, so the computer needs internet **once** for this):

| Package | What it is for |
|---|---|
| express, helmet, multer | the local web server, security headers, file uploads |
| better-sqlite3 | the database file that stores all notes, words, cards |
| dotenv | reads the `.env` settings file |
| pdfjs-dist, mammoth | read text from PDF and Word files |
| sanitize-html | keeps saved notes safe |
| adm-zip | backup and restore `.zip` files |
| tesseract.js (optional) | reads text from photos of notes (OCR); downloads language data the first time it is used |
| @fontsource/inter, @fontsource/noto-sans-tamil, lucide-static (build only) | fonts (English + Tamil) and icons, copied locally so the app works offline |

Optional, only for AI features: an **API key** from an AI provider (Anthropic, OpenAI, or a compatible one). Without it MITRA still works, except new AI explanations, AI flashcards and AI quizzes.

## How to run (Windows, step by step)
1. Install Node.js (above), then restart the computer if asked.
2. Unzip `mitra.zip` to a normal folder, e.g. `C:\MITRA` (not inside Downloads/temporary folders).
3. Double-click **`setup.bat`**. Wait until it says "Setup finished" (a few minutes).
4. Double-click **`start-mitra.bat`**. A black window stays open (that is the app running — do not close it) and your browser opens MITRA at http://127.0.0.1:3000.
5. To stop MITRA, close the black window. Your data stays in the `data` folder.
6. Optional AI: in MITRA open **Settings → Online AI**, choose the provider, type the model name and paste the API key, then Save.

If something fails: "node is not recognized" → Node.js not installed / restart the PC. "Port 3000 in use" → set `PORT=3001` in `.env` and open http://127.0.0.1:3001. A `better-sqlite3` install error (setup.bat stops with "gyp ERR") → use the current Node.js **LTS** (22), delete the `node_modules` folder and run setup.bat again; if it still fails, install "Visual Studio Build Tools" (Desktop development with C++) and retry. Step 3 needs a working internet connection.

Make backups from **Settings → Backup & restore** and copy the `.zip` to a USB drive.

## If the .bat files do not work
Open the MITRA folder in File Explorer, click the address bar, type `cmd` and press Enter. Then run these one at a time:
```
node -v
npm install
npm run build:assets
copy .env.example .env
npm start
```
Then open http://127.0.0.1:3000 in your browser. Any red error text tells us what is wrong.

## Install (summary)
1. Install Node.js 20 or newer (LTS) from https://nodejs.org.
2. Double-click `setup.bat` (runs `npm install`, builds icons/fonts, creates `.env`).
3. Double-click `start-mitra.bat`; MITRA opens at http://127.0.0.1:3000.

Other systems: `npm install && npm run build:assets && npm start`.

## Turning on Online AI
Either open **Settings → Online AI** inside MITRA, or edit `.env` (see `.env.example`):
`AI_PROVIDER` (`anthropic`, `openai`, `openai-compatible`), `AI_API_KEY`, `AI_MODEL`, optional `AI_BASE_URL`.
Without a key, everything except new AI-written content still works. No fake AI answers are ever produced: if the AI is unavailable the app says so and nothing is saved.

## Architecture
- `server.js` – Express 5, helmet CSP, loopback-only, Host allowlist, CSRF header + Origin check.
- `routes/` – REST APIs; `services/` – AI adapter, document extraction, OCR, backups; `database/` – `schema.sql` (version 1) and `migrations/NNN_name.sql` applied in order.
- `public/` – dependency-free ES-module SPA (hash router, safe DOM builder, no `innerHTML` of user text), local fonts (Inter, Noto Sans Tamil) and SVG icons, so the interface works offline.
- Data: `data/` (database, uploads, backups) or `MITRA_DATA_DIR`.

### Persistence policy
Messages are saved only after the AI answers successfully; identical explanation requests are cached; one request per conversation at a time.

## Privacy and security
- The API key is stored in `.env` on the server, write-only from the UI, never sent to the browser or into backups.
- Only the text you choose is sent to the AI provider; documents are never uploaded automatically. Online AI is *not* private or offline.
- Data is **not encrypted** on disk; protect the computer account. Backups are plain `.zip` files.
- Uploads are validated by file signature and stored under generated names; restores validate every zip entry and make a safety copy first.

## Tests
`npm test` (Node's test runner; uses a temporary data folder and a mock AI server — no real API calls).

## Known limitations (please read)
- **OCR** for photos of notes uses optional `tesseract.js`; it needs to download language data on first use and was **not verified on real handwriting or scans**. Scanned PDFs without a text layer are not OCR'd; MITRA offers manual text entry instead.
- **Tamil seed text** in the built-in dictionary needs review by a native speaker before relying on it.
- **Real AI providers** (Anthropic/OpenAI) were tested only against a mock server, not with live keys.
- `setup.bat` / `start-mitra.bat` were written but **not run on Windows**.
- Backups are built in memory, so very large libraries use a lot of RAM.
- Short-answer quizzes are intentionally not implemented (cannot be marked honestly).
- Reminders appear inside MITRA only; there are no desktop/phone notifications.
- Spaced repetition is a simple fixed ladder, not an adaptive algorithm.
