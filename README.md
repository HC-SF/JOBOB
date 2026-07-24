# JOBOB

멀티캠퍼스 점심 식단을 평일 오전 Mattermost 채널로 전송하는 봇.

Welstory에서 식단을 가져와 Mattermost Incoming Webhook으로 게시한다.

## ⚠️ 알려진 문제: 클라우드에서 자동 실행 불가

**Welstory가 Google Cloud IP 대역에서의 로그인을 차단**하는 것으로 확인됨. 로컬(가정용 IP)에서는 동일 계정으로 100% 로그인 성공, Google Cloud 기반 실행 환경에서는 100% 실패(`WelstoryAuthError: No Authorization header in login response`, HTTP 200이지만 인증 헤더 누락). 코드 문제가 아니라 Welstory 서버 측 IP 기반 차단으로 판단되며, 재시도로도 해결되지 않음을 확인함.

**현재 운영 방식**: `npm run post-lunch`로 로컬에서 수동 실행.

서빙 방식(스케줄 자동화)은 별도로 결정 예정. 후보: 한국 IP 프록시/VPN 경유, 또는 클라우드가 아닌 환경(자체 서버, GitHub Actions self-hosted runner 등)에서의 스케줄 실행.

## 구조

- `lunch-menu.ts` — 식단 조회부터 Mattermost 게시까지, 실행하면 바로 오늘의 식단을 전송하는 단일 스크립트

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
