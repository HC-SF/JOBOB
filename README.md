# JOBOB

멀티캠퍼스 점심 식단을 평일 오전 Mattermost 채널로 전송하는 봇.

Welstory에서 식단을 가져와 Mattermost Incoming Webhook으로 게시한다.

## 아키텍처: Firebase가 깨우고, GitHub Actions가 실행

두 가지 문제가 겹쳐서 지금의 2단 구조가 됐다.

- **GitHub Actions의 `schedule` 트리거는 신뢰할 수 없음**: 60일간 저장소에 커밋이 없으면 GitHub이 스케줄 트리거를 자동 비활성화한다. (과거엔 이걸 우회하려고 매일 이미지를 커밋하는 꼼수를 썼었음.)
- **Firebase Cloud Functions에서 직접 실행하면 Welstory 로그인이 막힘**: Welstory가 Google Cloud IP 대역에서의 로그인을 차단한다. 로컬(가정용 IP)에서는 동일 계정으로 100% 성공, Cloud Functions에서는 100% 실패(`WelstoryAuthError: No Authorization header in login response`).

그래서 역할을 분리했다:

1. **Firebase Cloud Functions** (`functions/`) — `onSchedule`로 평일 09:00 KST에 깨어나서, GitHub REST API의 `repository_dispatch` 이벤트만 쏜다. 식단 조회/전송 로직은 전혀 갖고 있지 않다.
2. **GitHub Actions** (`.github/workflows/post-lunch-menu.yml`) — `repository_dispatch` 이벤트를 받으면 그때 `npm run post-lunch`를 실행한다. GitHub 러너 IP는 Welstory에 차단되지 않으므로 실제 로그인/게시는 여기서 이뤄진다.

## 구조

- `lunch-menu.ts` — 식단 조회부터 Mattermost 게시까지, 실행하면 바로 오늘의 식단을 전송하는 단일 스크립트 (GitHub Actions에서 실행됨)
- `functions/` — Firebase Cloud Functions. 스케줄에 맞춰 GitHub Actions workflow를 트리거만 하는 얇은 레이어
- `.github/workflows/post-lunch-menu.yml` — `repository_dispatch`(및 수동 `workflow_dispatch`)로 트리거되는 워크플로우. `lunch-menu.ts`를 실행

## 환경변수

루트 `.env` 파일에 다음 값이 필요하다:

```
RESTAURANT_ID=<Welstory 식당 ID>
MEAL_TIME_ID=<Welstory 점심 시간대 ID>
RESTAURANT_NAME=멀티캠퍼스
MATTERMOST_WEBHOOK_URL=<Mattermost Incoming Webhook URL>
WELSTORY_USERNAME=<Welstory 계정 아이디>
WELSTORY_PASSWORD=<Welstory 계정 비밀번호>
```

## 의존성 설치

`@pmh-only/welplan2-model`, `@pmh-only/welplan2-welstory-plus`는 GitHub Packages(사설 레지스트리)에 있다. 설치 전 읽기 권한 토큰을 환경변수로 설정한다.

```bash
export GH_PACKAGES_TOKEN=<GitHub Packages 읽기 권한 토큰>
npm install
```

## 실행

```bash
npm run post-lunch   # 오늘의 식단을 Mattermost로 전송 (내부적으로 tsx lunch-menu.ts)
```

## 배포 / 설정

### GitHub Actions

리포지토리 Settings → Secrets and variables → Actions에 다음 Secrets를 등록한다:

```
GH_PACKAGES_TOKEN
MATTERMOST_WEBHOOK_URL
RESTAURANT_ID
MEAL_TIME_ID
WELSTORY_USERNAME
WELSTORY_PASSWORD
```

워크플로우는 `repository_dispatch`(`event_type: post-lunch-menu`) 또는 Actions 탭에서 수동(`workflow_dispatch`)으로만 실행된다. `schedule` 트리거는 없다 — 스케줄은 Firebase Functions가 담당한다.

### Firebase Cloud Functions

`functions/`는 GitHub API를 호출할 PAT 하나만 시크릿으로 필요하다. 대상 저장소에 대한 `contents: write` 권한(fine-grained PAT) 또는 `repo` 스코프(classic PAT)가 있어야 `dispatches` 엔드포인트를 호출할 수 있다.

```bash
cd functions
npm install
firebase functions:secrets:set GITHUB_DISPATCH_TOKEN
firebase deploy --only functions
```

`.firebaserc`의 `REPLACE_WITH_YOUR_FIREBASE_PROJECT_ID`를 실제 Firebase 프로젝트 ID로 바꾸고, [functions/src/index.ts](functions/src/index.ts)의 `GITHUB_REPOSITORY` 상수가 대상 GitHub 저장소(`owner/repo`)를 가리키는지 확인한다.
