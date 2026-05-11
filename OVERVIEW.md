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

- reads design assets from data/menus
- reads items list from items.json
- identifies coordinates and produces json files for each design in data/output

**script/build.js**

- reads jsons in data/output
- reads data/pricing to match item pricing to store locations
- reads registry.json to map designs to stores and screens
- generates html overlay that displays price and calorie in the correct coodinates, placed in public/overlays
- generates public/active.json manifest to map stores and screens to the correct design overlays and background images
- copies the background images over from data/menus/background into public/assets for use by the front-end

**src/**

- front-end app includes store/screen selectors to select the correct background image/overlay html to display

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