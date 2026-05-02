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

## Firestore データ

- `reservations/{reservationId}`: 申込単位
- `reservationSlots/{yyyy-mm-dd_period}`: コマ単位の占有レコード
- `allowedUsers/{email}`: ログイン可能な利用者と管理者

`reservationSlots` をトランザクション内で先に確認・作成するため、同時申込でも重複予約を防ぎます。

## 管理者

`backend/.env` の `FIREBASE_PROJECT_ID` には `frontend/.env.local` の `VITE_FIREBASE_PROJECT_ID` と同じ値を指定してください。
`ADMIN_EMAILS` にはカンマ区切りで初期管理者の Google アカウント email を指定します。
初期管理者は `allowedUsers` 未登録でもログインでき、管理者画面から利用者を追加できます。
