# Repository Guidelines

## Project Structure & Module Organization

This repository is an npm workspace for a room reservation system.

- `frontend/`: Vite + React + TypeScript client. Main UI code is in `frontend/src/main.tsx`; styling is in `frontend/src/styles.css`.
- `backend/`: Express API in `backend/src/server.js`, covering Firebase token validation, Firestore access, reservations, users, and import/export endpoints.
- `infra/`: Terraform for Cloud Run, IAM, and related Google Cloud resources. Start from `infra/terraform.tfvars.example`.
- `README.md` and `SPEC.md`: setup, deployment, and product behavior notes. Keep them aligned with feature changes.

## Build, Test, and Development Commands

Install dependencies from the repository root:

```sh
npm install
```

Run local services in separate terminals:

```sh
npm run dev --workspace backend
npm run dev --workspace frontend
```

Validate all workspaces:

```sh
npm run build
npm run lint
```

`npm run build` runs backend syntax checks and frontend type/build checks. `npm run lint` currently aliases the same validation.

## Coding Style & Naming Conventions

Use ES modules throughout. Frontend code uses TypeScript, React function components, hooks, and `PascalCase` component/type names. Backend code uses plain JavaScript with `camelCase` functions and constants such as `PERIODS`. Match the existing two-space indentation, single quotes, and semicolons. Keep validation close to API boundaries with `zod`.

## Testing Guidelines

There is no dedicated test runner or coverage threshold yet. Before submitting changes, run `npm run build` and `npm run lint` from the root. For behavior changes, manually exercise the affected reservation flow with both dev servers running. If tests are added, place frontend tests near covered code under `frontend/src` and backend tests under `backend/src` or `backend/test`, using `*.test.*` names.

## Commit & Pull Request Guidelines

Recent commits are concise summaries, often in Japanese, for example `予約データの export, import, erase 機能の追加.`. Follow that style: describe the user-visible or operational change in one line, and keep unrelated edits separate.

Pull requests should include a short description, validation commands run, required environment or Terraform changes, and screenshots for UI changes. Link related issues or specs when available.

## Security & Configuration Tips

Do not commit real `.env` files or service account JSON keys. Use `frontend/.env.example`, `backend/.env.example`, and `infra/terraform.tfvars.example` as templates. Local Firestore access should use Application Default Credentials or an absolute `GOOGLE_APPLICATION_CREDENTIALS` path stored only locally.
