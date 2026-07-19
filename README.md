# JOBOB

멀티캠퍼스 점심 식단을 평일 오전 09:23(KST)에 Mattermost 채널로 전송하는 봇.

Firebase Cloud Functions(2nd gen, scheduled function)로 동작하며, Welstory에서 식단을 가져와 Mattermost Incoming Webhook으로 게시한다.

## 구조

- `functions/` — 배포되는 Cloud Function 본체
  - `src/index.ts` — `onSchedule` 트리거 엔트리포인트
  - `src/lunch-menu.ts` — 식단 조회 및 Mattermost 게시 로직
- `find-restaurant.ts` — `RESTAURANT_ID` / `MEAL_TIME_ID`를 조회하는 1회성 로컬 스크립트
- `test-menu.ts` — Mattermost로 보내지 않고 `preview.md`에 메시지 미리보기를 생성하는 로컬 스크립트

## 사전 준비

1. Firebase 프로젝트 생성 (Blaze 요금제 필요 — scheduled function은 Cloud Scheduler + Pub/Sub를 사용하므로 무료 티어(Spark)로는 배포 불가).
2. `.firebaserc`의 `default` 프로젝트 ID를 실제 Firebase 프로젝트 ID로 변경.
3. `firebase login` 및 Firebase CLI 설치 (`npm install -g firebase-tools`).

## 의존성 설치 (vendoring 방식)

`@pmh-only/welplan2-model`, `@pmh-only/welplan2-welstory-plus`는 GitHub Packages(사설 레지스트리)에 있다. Cloud Build는 이 레지스트리 인증 토큰을 갖고 있지 않으므로, **`functions/node_modules`는 로컬에서 설치한 뒤 그대로 커밋(vendoring)한다.**

```bash
export GH_PACKAGES_TOKEN=<GitHub Packages 읽기 권한 토큰>
npm --prefix functions install
git add functions/node_modules
```

패키지를 업데이트할 때마다 위 과정을 반복하고 `functions/node_modules` 변경분을 커밋해야 한다.

## 환경변수 / 시크릿 설정

`RESTAURANT_ID`, `MEAL_TIME_ID`, `RESTAURANT_NAME`은 `functions/src/index.ts`에서 `defineString`으로 선언되어 있다. 배포 전 `functions/.env` 파일을 만들어 값을 지정한다 (예: `functions/.env`):

```
RESTAURANT_ID=<find-restaurant.ts로 조회한 값>
MEAL_TIME_ID=<find-restaurant.ts로 조회한 값>
RESTAURANT_NAME=멀티캠퍼스
```

민감한 값은 Firebase Secrets(Secret Manager)로 관리한다:

```bash
firebase functions:secrets:set MATTERMOST_WEBHOOK_URL
firebase functions:secrets:set WELSTORY_USERNAME
firebase functions:secrets:set WELSTORY_PASSWORD
```

`RESTAURANT_ID` / `MEAL_TIME_ID`는 `npm run find-restaurant`로 먼저 조회한다.

## 배포

```bash
firebase deploy --only functions
```

`predeploy` 훅이 `functions/`에서 `npm run build`(tsc)를 실행해 `functions/lib`을 생성한다.

## 로컬 테스트

```bash
npm run test-menu   # Mattermost로 전송하지 않고 preview.md 생성
```

Cloud Function 자체를 로컬에서 실행하려면:

```bash
npm --prefix functions run shell
```
