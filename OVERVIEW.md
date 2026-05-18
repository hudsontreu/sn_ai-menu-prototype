# Chick-fil-A Dynamic Menu Prototype Spec

## Overview

This is a prototype for validating the pipeline before converting to production. The system pulls Chick-fil-A menu designs (JPG format) and uses agentic AI to convert them to dynamic HTML. The approach:

- Use the original image as a background
- Overlay dynamic price and calorie text at the correct positions
- Map text to the corresponding food item

Price and calorie data will be dynamic, changing based on which store the HTML is displayed in. This data will be provided as JSON. The AI must identify menu item names in the image to map each item's price and calories to the correct position. After generating designs, the application is pushed to screens across stores. The screen provides store ID and screen ID, which determines which design and dynamic data to display.

## General Guidelines

- This is a prototype; some existing code from another developer may be available
- Production front-end will use Angular
- We can also just start by working with 1 screen design before doing 3 simoultaneously

## Pipeline Overview - Current Directory Structure

**script/gemini-batch.js**

- reads design assets from data/menus/full
    - Can be called with optional arguments for specifiying only certain designs to process (ex: `node scripts/gemini-batch.js design-d.png design-f.png`)
- reads items list from items.json
- identifies coordinates and produces json files for each design in data/gemini-output

**script/post-gemini.js**

- reads jsons in data/gemini-output and adjusts values to remove any jitter
- creates edited jsons in data/post-output

**script/build.js**

- reads jsons in data/post-output
- reads data/pricing/pricing-group_*.xml (resolved via each store's pricing-group in registry.json) to match item pricing to store locations
- reads registry.json to map designs to stores and screens
- generates html overlay that displays price and calorie in the correct coodinates, placed in public/overlays
- generates public/active.json manifest to map stores and screens to the correct design overlays and background images
- copies the background images over from data/menus/background into public/assets for use by the front-end

**src/**

- front-end app includes store/screen selectors to select the correct background image/overlay html to display

## Pipeline Overview - Written by Claude

The system has two distinct halves with **build-time composition** between them:

1. **Offline pipeline (Node scripts under `scripts/`)** — extract slot coordinates from menu PNGs, merge with per-store pricing, emit static artifacts to `public/`.
2. **Runtime frontend (Vite app under `src/`)** — dumb renderer that fetches the manifest and stacks a background image + overlay HTML fragment for the selected (store, screen).

The browser never sees the catalog, pricing XML, or design JSON. Everything in `data/` is authoring input; everything in `public/overlays/` and `public/assets/active.json` is build output (gitignored).

### Authoring inputs (`data/`)

- `data/menus/full/*.png` — source menu-board renders (one per design, currently exported manually from Figma). Filename stem = `designId`.
- `data/menus/background/*.png` — background-only PNGs (no text) for runtime compositing. Copied verbatim to `public/assets/` by `build.js`.
- `data/cfa-items.json` — flat catalog keyed by canonical `tag` (e.g. `HONEY_PEP_PIM_CFA_MEAL`) → `{menu-item, pricing-tag, group}`. The tag is the join key used across every downstream artifact and matches `<Tag>` in the POS XML.
- `data/variants.js` — variant vocabulary (`meal`, `entree`, `1ct`, …) passed to Gemini as a detection hint only. Variants are baked into the catalog `tag`; they never appear in slot output or pricing.
- `data/pricing/pricing-group_{NN}.xml` — POS feed per pricing group, flat list of `<Item>` records with `<Tag>`, `<Price>`, `<Calories>` / `<CaloriesLow>` / `<CaloriesHigh>`. Each store in `registry.json` declares a `pricing-group` integer; `build.js` resolves it to the corresponding file. Updated frequently; independent of designs.
- `data/registry.json` — maps `storeId → {name, screens: {screenId → designId}}`. Defines which design plays on which physical screen.

### Stage 1 — Slot extraction: `scripts/gemini-batch.js` (`npm run figma:batch`)

- Loops every PNG in `data/menus/full/`.
- Sends each image inline (base64) to Gemini along with a compact `{tag → menu-item}` catalog and the variant vocabulary.
- Gemini returns one entry per visible price/calorie value: `{tag, field, box_2d, confidence, reasoning}`. It's instructed to skip rather than invent when no catalog match fits.
- Converts each normalized `box_2d` (0–1000) to pixel coords in a 1920×1080 frame and takes the top-left as the slot anchor `(x, y)`.
- Writes one design file per PNG → `data/gemini-output/{designId}.json`.
- `scripts/gemini-debug.js` runs the same pipeline on one design and emits an HTML overlay of bounding boxes on the source image — for diagnosing extraction errors.

### Stage 2 — Coordinate alignment: `scripts/post-gemini.js` (`npm run post-gemini`)

- Reads `data/gemini-output/*.json`.
- Groups slot x-values and y-values independently; any cluster within 3px is averaged and snapped, removing per-slot jitter from the model output (so a visual row/column shares one exact coordinate).
- Writes cleaned designs to `data/post-output/{designId}.json` — this is the canonical design artifact consumed by `build.js`.

### Stage 3 — Composition: `scripts/build.js` (`npm run build:overlays`)

- Reads `data/registry.json` to walk every (storeId, screenId, designId) tuple.
- For each design, lazy-loads `data/post-output/{designId}.json`. For each store, resolves its `pricing-group` from `registry.json`, lazy-loads and parses `data/pricing/pricing-group_{NN}.xml` into `Map<tag, {price, calories}>`.
- For each (store, screen), renders an overlay HTML fragment: one absolutely-positioned `<div>` per slot, looked up by `tag`, formatted per `field` (`$X.XX`, `XXX cal`, or `—` with `.missing` class if absent). Calorie ranges fall back to `<CaloriesLow>/<CaloriesHigh>` when `<Calories>` is empty.
- Writes `public/overlays/{storeId}-{screenId}.html` (one tiny fragment per physical screen).
- Copies `data/menus/background/*.png` → `public/assets/` (shared bg images, CDN-cacheable).
- Writes `public/assets/active.json` — the manifest, keyed by store then screen, pointing each screen at its `{designId, background, overlay}` URLs.

Splitting bg image (rare, heavy, shared) from overlay HTML (frequent, tiny, per-store) is the whole reason for build-time composition — a pricing update invalidates only the small overlay file.

### Stage 4 — Runtime frontend (`src/`, served by Vite)

- `index.html` + `src/app.js` — toolbar with store/screen selectors; on selection change, asks `dynamic-view` to render.
- `src/services/manifest-fetch.js` — fetches `/assets/active.json` once at startup (mirrors the Angular `ManifestFetchService` shape).
- `src/views/dynamic-view.js` — for the selected (store, screen), stacks an `<img>` (background) with the fetched overlay HTML fragment injected on top (mirrors `DynamicViewComponent`).
- `src/styles.css` — fixed font sizing/styling per `field` (text does not scale with any slot box; only the start position comes from the slot).
- `src/qa/*` — separate QA portal app (`qa-app.js`, `inspector.js`, `stage.js`, `api.js`) for reviewing extraction quality on top of the source images. Not part of the production render path.

The frontend has zero awareness of slots, catalog tags, pricing, or the XML schema — all of that lives in `scripts/build.js`.

### QA portal (qa.html → src/qa/qa-app.js)

  - A completely separate page. Vite serves it at /qa.html.
  - It does not consume active.json or public/overlays/*.html. It bypasses the build pipeline entirely and reads the authoring inputs directly (data/post-output/*.json and data/cfa-items.json) plus a single pricing XML, then re-renders an
  editable preview client-side.
  - The renderer logic in src/qa/stage.js's formatSlotValue is a near-copy of build.js's renderOverlayHtml — same formatters, same styleGroup classes — so the QA preview matches what build.js will produce.

  The bridge — scripts/qa-plugin.js
  - A Vite configureServer plugin (loaded in vite.config.js) that adds middleware for two URL prefixes:
    - /api/qa/* — JSON REST endpoints for designs/catalog/pricing.
    - /qa-assets/menus/{full,background}/*.png — streams source PNGs out of data/menus/ (these are not in public/).
  - apply: 'serve' means this middleware only exists during npm run dev — there is no production QA portal. Edits go straight to disk via node:fs/promises writeFile.

### End-to-end execution order

```
# One-time / when designs change:
npm run figma:batch        # PNGs           → data/gemini-output/*.json
npm run post-gemini        # gemini-output  → data/post-output/*.json

# Whenever pricing OR designs OR registry change:
npm run build:overlays     # post-output + pricing + registry → public/overlays/ + public/assets/active.json

# Serve the frontend:
npm run dev                # Vite on :5173
```

### How data gets assigned to a store/screen

1. `registry.json` declares `storeId → screenId → designId`.
2. `build.js` joins that with `data/post-output/{designId}.json` (slot positions) and `data/pricing/pricing-group_{NN}.xml` (values, resolved from the store's `pricing-group`) on the catalog `tag`.
3. The resulting overlay fragment and manifest entry are static — at runtime, a screen identifies itself by `(storeId, screenId)`, the frontend looks that up in `active.json`, and renders the two layers it points to. No runtime computation, no client-side data joins.

## Data Structure

Expected format:

- JSON
- Keyed by store ID
- Each store contains:
    - Price per item (varies by store)
    - Calories per item (varies by store)
- 4 stores total
- Each store has 1–3 screens
- Each store has an ID corresponding to its screen configuration

## ai-menuboard pipeline (reference, not active)

The core loop lives in `ai-menuboard/main.py::run_pipeline`. Each iteration runs these stages in sequence (each stage is its own module):

1. `gather_requirements.ai_gather_requirements` — LLM turns user intent + image into prose requirements.
2. `visual_match.ai_extract_visual_spec` — LLM turns intent + image into a compact JSON visual target spec (frozen across iterations).
3. `determine_modules.ai_determine_modules` — LLM lists the files needed (no code).
4. `generate_module_code.ai_generate_module_code` — LLM produces JSON `{entry, files: [{file_name, code, language}]}`.
5. `angular_scaffold.enforce_angular_scaffold` + `architecture_guardrails.validate_generated_architecture` — deterministically inject/fix canonical `package.json`, `angular.json`, `tsconfig*.json`, then validate that all `REQUIRED_FILES` / `REQUIRED_DIR_PREFIXES` are present. Hard-fails if not.
6. `convert_module_code_json_to_files.write_generated_files` — writes files to `iterations/NN/codebase/`.
7. `compile_healer.heal_until_compiles` — runs `npm install` + `ng build` via `resolve_render_target.py`; on failure tries `deterministic_repair.apply_runtime_error_fixes` (regex-based patches for common Angular errors) then `dynamic_runtime_repair.apply_dynamic_runtime_repair` (LLM-guided file rewrites). Repeats up to `max_cycles`.
8. `visual_renderer.capture_screenshot` — serves the built `dist/` over a local HTTP server and screenshots via Playwright headless Chromium. Waits for `app-root` to mount before capturing.
9. `visual_match.ai_score_visual_and_plan_deltas` — LLM scores the screenshot against the visual spec and emits targeted deltas that feed the next iteration's requirements.

Iteration control flow in `run_pipeline` is non-trivial:
- Each iteration seeds its `codebase/` from the previous (or from best-so-far if the previous regressed meaningfully — see `_is_meaningful_regression` and `_update_best_tracking`).
- `max_fix_attempts_per_iteration` is an inner retry loop for build/render failures within one iteration. `ai_update_requirements_from_error` rewrites requirements between attempts.
- Stops early on high scores or on plateau (`plateau_patience` iterations with no new best).
- If an iteration produces no output at all, falls back once to regenerating from the best successful iteration.

### Hard-coded architectural constraints

`architecture_guardrails.py` enforces an Angular 18 signage engine shape. Any generated codebase MUST contain `package.json`, `angular.json`, `tsconfig.json`, `src/main.ts`, `src/index.html`, `src/styles.scss`, `src/assets/active.json`, `postbuild.js`, plus files under `src/app/core/services/`, `src/app/features/menu/dynamic-view/`, and `src/app/shared/models/`. The declared `entry` must be an `.html` file (for screenshot capture) — typically `src/index.html`, resolved to a compiled `dist/**/*.html` by `resolve_render_target`.

These guardrails will reject the `overlay-prototype/` shape entirely. If we ever want to run the Python pipeline against the new prototype, the guardrails must be loosened, not worked around.

### Secrets and external services (ai-menuboard)

- `secret_manager.py` reads from **GCP Secret Manager**, project `ai-menuboard`. All LLM modules call `get_secret("openai_api_key", ...)` at import time — importing them requires valid GCP application-default credentials (`gcloud auth application-default login`) or a service account. There is no local-env fallback; Azure OpenAI alternatives are commented out.
- `api.py` is the exception: it reads `internal_api_key` from a `config.env` file via `dotenv`. Every `/v1/*` endpoint requires the `X-API-Key` header matching this value.
- `gitlab_publisher.py` reads `gitlab_private_token` from Secret Manager and pushes generated artifacts to a GitLab project.
- Model IDs referenced in code (`gpt-5.4-2026-03-05`, `gpt-5.3-codex`) target the OpenAI Responses API (`client.responses.create`). These are not standard public model names — verify access before assuming calls will succeed.

### Runtime dependencies (ai-menuboard)

- Python 3.11, deps in `ai-menuboard/requirements.txt` (FastAPI, uvicorn, openai, playwright, google-cloud-secret-manager).
- Node 20 + npm on PATH (or pointed to by `NODE_BIN` / `NPM_BIN` env vars — see `toolchain.py`).
- Playwright Chromium browser (installed via `playwright install chromium`; `runtime_dependencies.ensure_runtime_dependencies` auto-installs on first run and pins `PLAYWRIGHT_BROWSERS_PATH` to `ai-menuboard/.playwright-browsers`).
- `job_store.py` persists jobs to `ai-menuboard/data/jobs.db` (SQLite).

### Common ai-menuboard commands

All commands assume `cd ai-menuboard` first.

```bash
pip install -r requirements.txt
python -m playwright install chromium

# Run the API server
uvicorn api:app --host 0.0.0.0 --port 8080 --reload

# Dockerized run (matches CI image from .gitlab-ci.yml)
docker build -t ai-menuboard .
docker run -p 8080:8080 --env-file config.env ai-menuboard
```

- API docs: `http://localhost:8080/docs`
- Studio UI: `http://localhost:8080/studio` (single-file React + Tailwind via CDN in `menu_board_studio.html`)
- Preflight check: `GET /v1/preflight?check_runtime_dependencies=true` with `X-API-Key` header

There is **no test suite, linter config, or build step** in either repo. Running the pipeline end-to-end via the API (ai-menuboard) or refreshing the dev server (overlay-prototype) is the only validation path.

### Running the ai-menuboard pipeline without the API

```python
from main import run_pipeline
result = run_pipeline(
    message="your intent here",
    image_path="path/to/reference.png",
    output_dir="./local_run",
    iterations=2,
)
```
Importing `main` transitively imports every LLM module, each of which calls `get_secret` at import. Expect failure without GCP credentials.

### Figma integration (ai-menuboard)

`figma_mcp.py` is marked `NOT CURRENTLY USED`. It shells out to a command configured via `figma_mcp_get_design_context_command` env var, which must speak a JSON-over-stdio bridge to the Figma MCP server. For the overlay-prototype's Figma work, use Claude Code's built-in `figma-remote-mcp` tools directly rather than wiring through this bridge.

## Python notes for JS-familiar readers

- `from x import y` resolves to `ai-menuboard/x.py` because those modules sit at the repo root (no package). The Dockerfile's `WORKDIR /app` + `COPY . .` is what makes those flat imports work in production. If you move files into subpackages you must add `__init__.py` and update every import.
- Type hints like `str | None` require Python 3.10+; `dict[str, Any]` syntax requires 3.9+. Stick to 3.11 to match `Dockerfile`.
- `FastAPI` endpoints are just async functions with typed params — `Form(...)` vs `File(...)` vs `Header(...)` vs `Depends(...)` dictate where each value comes from. The `: None = Depends(verify_api_key)` pattern is how auth is enforced without the handler needing the value.
- LLM calls use OpenAI's **Responses API** (`client.responses.create`), not the older chat completions API. The input schema is `[{role, content: [{type: "input_text" | "input_image", ...}]}]` and the response text is at `.output_text`.
- Blocking work (the pipeline) runs on a `ThreadPoolExecutor(max_workers=2)` in `api.py` — the endpoint returns immediately with a `job_id` and the client polls `GET /v1/jobs/{job_id}`.