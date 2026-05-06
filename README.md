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
  --substitutions=_REGION=asia-northeast1,_SERVICE_NAME=reservation-backend,_FIREBASE_PROJECT_ID=your-firebase-project-id,_FIRESTORE_PROJECT_ID=your-firestore-project-id,_ADMIN_EMAILS=admin@example.com,_SERVICE_ACCOUNT=backend-sa@PROJECT_ID.iam.gserviceaccount.com
```

frontend:

```sh
gcloud builds submit frontend \
  --config=frontend/cloudbuild.yaml \
  --substitutions=_REGION=asia-northeast1,_SERVICE_NAME=reservation-frontend,_BACKEND_URL=https://backend-service-url,_BACKEND_AUDIENCE=https://backend-service-url,_VITE_FIREBASE_API_KEY=your-api-key,_VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com,_VITE_FIREBASE_PROJECT_ID=your-firebase-project-id,_VITE_FIREBASE_APP_ID=your-app-id,_SERVICE_ACCOUNT=frontend-sa@PROJECT_ID.iam.gserviceaccount.com
```

`_FIREBASE_PROJECT_ID` と `_VITE_FIREBASE_PROJECT_ID` は同じ Firebase project ID を指定してください。GCP project ID と Firebase project ID が違う場合、`${PROJECT_ID}` を使うと Firebase ID token の検証に失敗します。

backend は `--no-allow-unauthenticated` でデプロイされます。frontend の Cloud Run 実行サービスアカウントに、backend の `roles/run.invoker` を付与してください。

### IAM 設定

以下の例では、Cloud Run をデプロイする Google Cloud project を `CLOUD_RUN_PROJECT_ID`、Firebase Auth/Firestore がある project を `FIREBASE_PROJECT_ID` としています。同じ project の場合は同じ値を指定してください。

```sh
CLOUD_RUN_PROJECT_ID=your-cloud-run-project-id
FIREBASE_PROJECT_ID=your-firebase-project-id
REGION=asia-northeast1

PROJECT_NUMBER=$(gcloud projects describe $CLOUD_RUN_PROJECT_ID --format='value(projectNumber)')
BUILD_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
FRONTEND_RUN_SA=frontend-sa@${CLOUD_RUN_PROJECT_ID}.iam.gserviceaccount.com
BACKEND_RUN_SA=backend-sa@${CLOUD_RUN_PROJECT_ID}.iam.gserviceaccount.com
```

Cloud Build の実行サービスアカウントに Cloud Run を更新する権限を付与します。

```sh
gcloud projects add-iam-policy-binding $CLOUD_RUN_PROJECT_ID \
  --member="serviceAccount:${BUILD_SA}" \
  --role="roles/run.admin"
```

Cloud Build が frontend/backend の実行サービスアカウントを指定できるようにします。

```sh
gcloud iam service-accounts add-iam-policy-binding $FRONTEND_RUN_SA \
  --member="serviceAccount:${BUILD_SA}" \
  --role="roles/iam.serviceAccountUser"

gcloud iam service-accounts add-iam-policy-binding $BACKEND_RUN_SA \
  --member="serviceAccount:${BUILD_SA}" \
  --role="roles/iam.serviceAccountUser"
```

backend が Firestore を読み書きできるようにします。Firestore を Firebase project 側で作成した場合、この権限は Firebase project 側に付与してください。

```sh
gcloud projects add-iam-policy-binding $FIREBASE_PROJECT_ID \
  --member="serviceAccount:${BACKEND_RUN_SA}" \
  --role="roles/datastore.user"
```

frontend proxy が `Require authentication` の backend Cloud Run を呼べるようにします。

```sh
gcloud run services add-iam-policy-binding reservation-backend \
  --project=$CLOUD_RUN_PROJECT_ID \
  --region=$REGION \
  --member="serviceAccount:${FRONTEND_RUN_SA}" \
  --role="roles/run.invoker"
```

frontend は public にする必要があります。Cloud Build の `--allow-unauthenticated` が IAM policy 設定に失敗した場合は、権限のあるアカウントで手動設定してください。

```sh
gcloud run services add-iam-policy-binding reservation-frontend \
  --project=$CLOUD_RUN_PROJECT_ID \
  --region=$REGION \
  --member="allUsers" \
  --role="roles/run.invoker"
```

現在の設定確認:

```sh
gcloud run services describe reservation-backend \
  --project=$CLOUD_RUN_PROJECT_ID \
  --region=$REGION \
  --format='yaml(spec.template.spec.serviceAccountName,spec.template.spec.containers[0].env,status.traffic)'

gcloud run services get-iam-policy reservation-backend \
  --project=$CLOUD_RUN_PROJECT_ID \
  --region=$REGION

gcloud run services get-iam-policy reservation-frontend \
  --project=$CLOUD_RUN_PROJECT_ID \
  --region=$REGION
```

### Cloud Build Trigger

GitHub 連携済みのリポジトリに対して、backend/frontend の trigger を分けて作成します。trigger ではリポジトリ全体が checkout されるため、`cloudbuild.trigger.yaml` を使います。

```sh
PROJECT_ID=your-cloud-run-project-id
REGION=asia-northeast1
GITHUB_OWNER=your-github-owner
GITHUB_REPO=reservation_system
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
BUILD_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
BACKEND_RUN_SA=backend-sa@${PROJECT_ID}.iam.gserviceaccount.com
FRONTEND_RUN_SA=frontend-sa@${PROJECT_ID}.iam.gserviceaccount.com
FIREBASE_PROJECT_ID=your-firebase-project-id
BACKEND_URL=https://your-backend-service-url
FRONTEND_URL=https://your-frontend-service-url
```

backend trigger:

```sh
gcloud builds triggers create github \
  --project=$PROJECT_ID \
  --name=reservation-backend-main \
  --region=$REGION \
  --repo-owner=$GITHUB_OWNER \
  --repo-name=$GITHUB_REPO \
  --branch-pattern='^main$' \
  --build-config=backend/cloudbuild.trigger.yaml \
  --service-account=projects/$PROJECT_ID/serviceAccounts/$BUILD_SA \
  --included-files='backend/**' \
  --substitutions=_REGION=$REGION,_SERVICE_NAME=reservation-backend,_FIREBASE_PROJECT_ID=$FIREBASE_PROJECT_ID,_FIRESTORE_PROJECT_ID=$FIREBASE_PROJECT_ID,_FRONTEND_ORIGIN=$FRONTEND_URL,_ADMIN_EMAILS=admin@example.com,_SERVICE_ACCOUNT=$BACKEND_RUN_SA
```

frontend trigger:

```sh
gcloud builds triggers create github \
  --project=$PROJECT_ID \
  --name=reservation-frontend-main \
  --region=$REGION \
  --repo-owner=$GITHUB_OWNER \
  --repo-name=$GITHUB_REPO \
  --branch-pattern='^main$' \
  --build-config=frontend/cloudbuild.trigger.yaml \
  --service-account=projects/$PROJECT_ID/serviceAccounts/$BUILD_SA \
  --included-files='frontend/**' \
  --substitutions=_REGION=$REGION,_SERVICE_NAME=reservation-frontend,_BACKEND_URL=$BACKEND_URL,_BACKEND_AUDIENCE=$BACKEND_URL,_VITE_FIREBASE_API_KEY=your-api-key,_VITE_FIREBASE_AUTH_DOMAIN=$FIREBASE_PROJECT_ID.firebaseapp.com,_VITE_FIREBASE_PROJECT_ID=$FIREBASE_PROJECT_ID,_VITE_FIREBASE_APP_ID=your-app-id,_SERVICE_ACCOUNT=$FRONTEND_RUN_SA
```

作成済み trigger の確認:

```sh
gcloud builds triggers list --project=$PROJECT_ID --region=$REGION
```

手動実行:

```sh
gcloud builds triggers run reservation-backend-main \
  --project=$PROJECT_ID \
  --region=$REGION \
  --branch=main

gcloud builds triggers run reservation-frontend-main \
  --project=$PROJECT_ID \
  --region=$REGION \
  --branch=main
```

Cloud Build 公式ドキュメントでは、GitHub trigger は `gcloud builds triggers create github` で作成し、trigger に指定した service account が trigger から起動される build に使われます。`--included-files` を指定すると、該当パスの変更時だけ trigger が起動します。

trigger で service account を指定する場合、Cloud Build はログ出力先の明示設定を要求します。このリポジトリの Cloud Build 設定では `options.logging: CLOUD_LOGGING_ONLY` を指定し、Cloud Logging のみにログを出します。

### Terraform

Cloud Run / Cloud Build / IAM / Artifact Registry は `infra/` の Terraform でも管理できます。Firebase Authentication の Google ログイン有効化や Authorized domains など、Firebase Console 側の一部設定は手動で行ってください。

まず設定ファイルを作成します。実値を含む `terraform.tfvars` は `.gitignore` 対象です。

```sh
cp infra/terraform.tfvars.example infra/terraform.tfvars
```

`infra/terraform.tfvars` を編集します。

```hcl
cloud_run_project_id = "your-cloud-run-project-id"
firebase_project_id  = "your-firebase-project-id"
firestore_project_id = "your-firebase-project-id"
region               = "asia-northeast1"

github_owner = "your-github-owner"
github_repo  = "reservation_system"

cloud_build_service_account_email = "PROJECT_NUMBER-compute@developer.gserviceaccount.com"

admin_emails = "admin@example.com"
frontend_origin = "https://your-frontend-service-url"

firebase_web_api_key = "your-firebase-web-api-key"
firebase_web_app_id  = "your-firebase-web-app-id"
firebase_auth_domain = "your-firebase-project-id.firebaseapp.com"
```

適用します。

```sh
cd infra
terraform init
terraform plan
terraform apply
```

すでに手動作成済みの Cloud Run service、Artifact Registry repository、Cloud Build trigger、service account を Terraform 管理に移す場合は、`terraform apply` の前に `terraform import` が必要です。import せずに同名リソースを作ろうとすると、既存リソースとの重複で失敗します。

Terraform が作成する主なリソース:

- Artifact Registry repository
- frontend/backend の Cloud Run runtime service account
- Cloud Run frontend/backend service
- Cloud Run IAM
- Cloud Build trigger
- Cloud Build 実行 service account に必要な IAM
- backend runtime service account の Firestore 権限

Cloud Run service は Terraform 初回作成時に placeholder image で作成されます。`terraform apply` 後に trigger を手動実行し、実アプリ image に更新してください。

```sh
gcloud builds triggers run reservation-backend-main \
  --region=asia-northeast1 \
  --branch=main

gcloud builds triggers run reservation-frontend-main \
  --region=asia-northeast1 \
  --branch=main
```

frontend URL が確定した後、`frontend_origin` をその URL に更新して再度 `terraform apply` してください。

## Firestore データ

- `reservations/{reservationId}`: 申込単位
- `reservationSlots/{yyyy-mm-dd_period}`: コマ単位の占有レコード
- `allowedUsers/{email}`: ログイン可能な利用者と管理者

`reservationSlots` をトランザクション内で先に確認・作成するため、同時申込でも重複予約を防ぎます。

## 管理者

`backend/.env` の `FIREBASE_PROJECT_ID` には `frontend/.env.local` の `VITE_FIREBASE_PROJECT_ID` と同じ値を指定してください。
`FIRESTORE_PROJECT_ID` には Firestore database がある Google Cloud/Firebase project ID を指定してください。Firebase Auth と Firestore が同じ project なら同じ値で構いません。
`ADMIN_EMAILS` にはカンマ区切りで初期管理者の Google アカウント email を指定します。
初期管理者は `allowedUsers` 未登録でもログインでき、管理者画面から利用者を追加できます。
