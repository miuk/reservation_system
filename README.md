# 会議室予約システム

単一会議室を午前・午後・夜の3コマで予約するシステムです。Googleログイン、Firestore、Cloud Run 配備を前提にしています。

## 構成

- `frontend`: Vite + React。Firebase Authentication の Google ログインと予約カレンダー。
- `backend`: Express + Google Cloud Firestore SDK。Firestore への予約登録、承認、取消。

## セットアップ

```sh
npm install
cp frontend/.env.example frontend/.env.local
cp backend/.env.example backend/.env
```

Firebase プロジェクトを作成し、Firestore と Google 認証を有効化してください。

ローカルで backend から Firestore にアクセスするには、Google Application Default Credentials が必要です。どちらかを設定してください。

```sh
gcloud auth application-default login
```

または、Firebase/GCP のサービスアカウントキーを使う場合は `backend/.env` に絶対パスを指定します。

```env
GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/service-account.json
```

## 開発起動

```sh
npm run dev --workspace backend
npm run dev --workspace frontend
```

## Docker

```sh
export VITE_FIREBASE_API_KEY=your-api-key
export VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
export VITE_FIREBASE_PROJECT_ID=your-firebase-project-id
export VITE_FIREBASE_APP_ID=your-app-id
docker compose up --build
```

フロントエンドの `VITE_FIREBASE_*` はビルド時に埋め込まれます。Cloud Run 用のイメージを作る場合も、同じ build args を指定してください。

## Cloud Run 配置

ブラウザは frontend にだけアクセスし、frontend の Node proxy が backend に `/api/*` を転送します。

```text
Browser -> frontend Cloud Run -> backend Cloud Run -> Firestore
```

backend は Cloud Run IAM 認証を必須にし、frontend のサービスアカウントからだけ呼べるようにします。

- frontend Cloud Run: public
- backend Cloud Run: `--no-allow-unauthenticated`
- backend の Cloud Run Invoker: frontend のサービスアカウントにだけ付与
- frontend runtime env: `BACKEND_URL=https://backend-service-xxxxx.run.app`
- 必要なら `BACKEND_AUDIENCE` に backend の Cloud Run URL を指定

frontend proxy は Cloud Run metadata server から Google-signed ID token を取得し、`X-Serverless-Authorization` ヘッダーで backend に送ります。ブラウザから受け取った Firebase ID token の `Authorization` ヘッダーはそのまま backend に転送します。

この構成では backend の `run.app` URL 自体は存在しますが、Cloud Run IAM により未認証の直接アクセスは拒否されます。backend の ingress を `internal` または `internal-and-cloud-load-balancing` にする場合、frontend から backend への通信を VPC 経由にする追加構成が必要です。

### Cloud Build

backend と frontend は別々にビルド/デプロイします。Artifact Registry の `cloud-run-source-deploy` リポジトリを事前に作成してください。

```sh
gcloud artifacts repositories create cloud-run-source-deploy \
  --repository-format=docker \
  --location=asia-northeast1
```

backend:

```sh
gcloud builds submit backend \
  --config=backend/cloudbuild.yaml \
  --substitutions=_REGION=asia-northeast1,_SERVICE_NAME=reservation-backend,_FIREBASE_PROJECT_ID=your-firebase-project-id,_ADMIN_EMAILS=admin@example.com,_SERVICE_ACCOUNT=backend-sa@PROJECT_ID.iam.gserviceaccount.com
```

frontend:

```sh
gcloud builds submit frontend \
  --config=frontend/cloudbuild.yaml \
  --substitutions=_REGION=asia-northeast1,_SERVICE_NAME=reservation-frontend,_BACKEND_URL=https://backend-service-url,_BACKEND_AUDIENCE=https://backend-service-url,_VITE_FIREBASE_API_KEY=your-api-key,_VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com,_VITE_FIREBASE_PROJECT_ID=your-firebase-project-id,_VITE_FIREBASE_APP_ID=your-app-id,_SERVICE_ACCOUNT=frontend-sa@PROJECT_ID.iam.gserviceaccount.com
```

backend は `--no-allow-unauthenticated` でデプロイされます。frontend の Cloud Run 実行サービスアカウントに、backend の `roles/run.invoker` を付与してください。

## Firestore データ

- `reservations/{reservationId}`: 申込単位
- `reservationSlots/{yyyy-mm-dd_period}`: コマ単位の占有レコード
- `allowedUsers/{email}`: ログイン可能な利用者と管理者

`reservationSlots` をトランザクション内で先に確認・作成するため、同時申込でも重複予約を防ぎます。

## 管理者

`backend/.env` の `FIREBASE_PROJECT_ID` には `frontend/.env.local` の `VITE_FIREBASE_PROJECT_ID` と同じ値を指定してください。
`ADMIN_EMAILS` にはカンマ区切りで初期管理者の Google アカウント email を指定します。
初期管理者は `allowedUsers` 未登録でもログインでき、管理者画面から利用者を追加できます。
