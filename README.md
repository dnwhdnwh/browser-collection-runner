# Browser collection runner

비공개 번들을 검증하고 실행하는 공통 실행기다. 이 저장소는 개별 사이트 주소·수집 규칙·대상 목록·서비스 구현·사용자 데이터를 포함하지 않는다.

## 설정

Node.js 22 이상과 표준 Ubuntu 환경을 사용한다. npm 설치 의존성은 없다. GitHub 저장소 이름은 `dnwhdnwh/browser-collection-runner`이며 fork나 다른 이름에서는 job을 실행하지 않는다.

다음 세 값을 GitHub Actions Secrets에 등록한다.

- `COLLECTOR_BOOTSTRAP_URL`: 인증 GET으로 단일 JavaScript 번들을 제공하는 HTTPS 주소
- `COLLECTOR_TOKEN`: 번들 다운로드 및 비공개 실행에 사용하는 전용 토큰, 최소 32자
- `COLLECTOR_BUNDLE_SHA256`: 승인한 번들 원문 바이트의 SHA-256, 소문자 16진수 64자리

세 Secret은 실제 실행 단계에만 주입한다. checkout·테스트에는 전달하지 않는다. 주소·토큰·해시를 workflow 입력이나 공개 파일에 적지 않는다. Actions variable `COLLECTION_ENABLED`가 문자열 `true`일 때만 실행하며 기본은 비활성이다. 중지하려면 이 변수를 제거하거나 `false`로 바꾼다.

매일 UTC 짝수 시각 00:17~22:17, 한국시간 홀수 시각 01:17~23:17에 **하루 12회** 예약하며 GitHub 사정에 따라 지연·누락될 수 있다. 수동 실행 입력은 `max_navigations` 하나이며 1~900, 기본 900이다. 대상 이름을 입력하는 기능은 제공하지 않는다. 동시 실행은 한 개이며 실행 중인 job을 자동 취소하지 않는다.

```sh
npm test
# 세 Secret이 안전한 실행 환경에 등록된 경우
node runner.mjs --max-navigations 900
```

## 예약 실행 유지

GitHub는 공개 저장소에 **60일 동안 활동이 없으면 예약 workflow를 자동 중지**한다. 매월 1일 UTC 01:29, 한국시간 10:29에 별도 maintenance workflow가 `.github/maintenance.json`의 `schemaVersion`과 `maintainedAt`만 main 브랜치에 커밋해 활동을 유지한다. 수동 실행도 가능하며 별도 입력은 없다. [GitHub 예약 실행 규칙](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule) 참조.

쓰기 권한은 **maintenance job의 `contents: write`에만** 부여하고, 수집 workflow의 `contents: read`는 유지한다. checkout·외부 action 없이 GitHub REST API로 고정 파일만 갱신하며 수집 Secret·주소·결과에는 접근하지 않는다. `COLLECTION_ENABLED=true`일 때만 동작하고 최대 실행 시간은 3분이다.

월 1회 실행은 무활동 중지를 예방하는 최소 유지 작업이다. 수집 규칙·코드·workflow를 수정하지 않으며 maintenance 커밋으로 추가 workflow를 실행하도록 push/PR trigger를 구성하지 않는다. 예약 지연·실패나 권한 변경으로 장기간 유지 작업이 실행되지 않으면 자동 중지를 완전히 보장해 막을 수 없으며, 이미 중지된 workflow는 GitHub에서 다시 활성화해야 한다.

## 번들 계약

다운로드는 Secret의 HTTPS 주소로만 인증 GET을 수행한다. redirect를 따르지 않으며 실제 응답 주소도 요청 주소와 같아야 한다. 응답은 `Content-Type: application/javascript`만 허용하고 charset 매개변수는 허용한다. 실제 다운로드 본문을 **256 KiB**로 제한하며 `Content-Length`만 믿지 않는다. 승인된 SHA-256과 정확히 일치해야 실행한다. Secret 누락·잘못된 주소·다른 MIME·빈 본문·크기 초과·해시 불일치·통신 실패는 모두 실패 종료한다.

번들은 외부 파일 없이 실행 가능한 단일 ES 모듈로 다음 함수를 내보낸다.

```js
export async function execute({token, maxNavigations, runId}) {
  // 비공개 동작은 승인한 번들 안에서 수행
  return {summary: {status: 'completed', navigations: 0, needsCatchUp: false}, exitCode: 0};
}
```

`runId`는 `github-숫자-숫자` 또는 `local-숫자` 형식으로만 전달한다. `maxNavigations`는 실행 요청의 상한이며 실제 예약·재시도·수집 정책은 승인 번들이 책임진다. 번들의 안전한 변경도 해시 Secret을 함께 갱신해야 실행된다.

## 공개 출력과 임시 파일

실행기는 다운로드 전에 부모 환경에서 세 Secret을 모두 제거한다. 검증한 번들은 권한 **0700**인 OS 임시 디렉터리에 권한 **0600** 파일로 저장한다. 별도 Node 자식 프로세스에서 import하며 토큰과 실행 인자는 환경·명령행 대신 IPC로 전달한다. 자식 환경은 실행에 필요한 경로·로케일 등 허용 목록으로 제한한다. 자식 stdout·stderr는 버리며 번들의 console 출력·원문 오류·스택·주소·소스를 공개 로그로 보내지 않는다.

자식이 반환한 결과도 그대로 출력하지 않는다. 다음 고정 필드에 대해 음수가 아닌 안전한 정수, boolean, 고정 상태만 허용한다.

- 상태: `completed`, `attention_required`, `partial_failure`, 또는 검증 실패를 뜻하는 `failed`
- 정수: `publishedRevision`, `selectedTargets`, `attemptedTargets`, `navigations`, `dailyReservedNavigations`, `accepted`, `held`, `noOffers`, `remainingEligibleTargets`, `checkpointCount`
- boolean: `budgetReserved`, `timeBudgetExhausted`, `sourceBackoffActive`, `needsCatchUp`
- `coverage`의 정수: `targetCount`, `fresh`, `stale`, `missingOrUnknown`, `checkedWithin14Days`, `neverAttempted`, `estimatedSweepPages`, `estimatedSweepDays`, `dueSoon`, `overdue`, `remainingPages`, `remainingCapacity14Days`, `remainingDailyCapacity`, `pagesPerRun`, `scheduledRunsPerDay`, `backoffPastDeadline`. boolean: `capacityInsufficient`, `deadlineMissRisk`, `allTargetsChecked`, `allPricesFresh`

실행 오류는 원문 대신 고정 `runner_failed`와 종료 코드 1로 표시한다. 유효한 번들 결과의 `exitCode:1`도 실패로 유지한다. 성공 상태는 번들의 개별 동작 성공 여부를 별도로 증명하지 않으므로 허용된 집계 수치를 함께 확인한다.

성공·예외·시간 초과·처리 가능한 종료 신호에서 임시 파일을 정리한다. 자식 실행은 최대 110분, job 전체는 120분으로 제한한다. 강제 종료처럼 프로세스가 정리 코드를 실행할 수 없는 경우 임시 데이터 제거는 runner 환경의 수명에 따른다. artifact·cache·파일 업로드·push/PR 실행은 구성하지 않는다.

이 방식은 **승인한 해시의 번들을 신뢰하는 실행 경계**다. 임의 악성 코드를 차단하는 sandbox나 서버 운영자·저장소 관리자·runner 관리자에 대한 비밀 보장으로 해석하면 안 된다. 번들의 접근 권한과 배포 검토는 비공개 운영 측에서 관리한다.

## 미완료 대상 후속 실행

실행기는 정제된 `needsCatchUp` boolean만 `GITHUB_OUTPUT`의 `needs_catch_up=true|false`로 전달한다. 누락 값·문자열·객체는 false로 취급한다. 수집 job 성공과 true 출력, 정확한 저장소, `COLLECTION_ENABLED=true`가 모두 충족되면 별도 follow-up job이 고정된 같은 workflow의 main 브랜치에 상한 900으로 **후속 실행을 한 번만 요청**한다. GitHub REST API 외의 주소나 대상 입력을 받지 않는다.

후속 job에는 `actions: write`만 부여하고, 수집 Secret·checkout·번들을 전달하지 않는다. 수집 job은 `contents: read`, 월간 maintenance는 별도 `contents: write`를 유지한다. 후속 job은 최대 2분, 단일 API 요청은 15초로 제한하며 실패 원문과 응답 본문은 공개하지 않는다.

새 실행도 미완료 상태라면 다시 후속 실행을 요청할 수 있다. **연속 실행 종료의 핵심은 비공개 번들이 강제하는 하루 최대 3,600페이지 예산**이다. 예산 소진·전체 접근 제한 대기·데이터 오류에는 번들이 `needsCatchUp:false`를 반환해야 한다. 공개 실행기 자체는 사이트별 예산과 재시도 상태를 판정하지 않으므로 승인 번들의 해당 정책을 검증해야 한다.

후속 실행은 누락된 예약이나 미완료 작업을 보충하는 경로다. 현재 concurrency 설정은 같은 그룹에서 실행 중 1개와 대기 중 1개만 유지하며, 새 요청이 들어오면 기존 대기 실행을 교체할 수 있다. 실행 중인 작업은 취소하지 않는다. [GitHub 동시 실행 규칙](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency) 참조.

`allTargetsChecked`는 모든 대상 확인 상태, `allPricesFresh`는 실제 가격 확보·유효 상태를 나타낸다. 두 값을 구분하고, 무응답·접근 제한·자료 부재가 있는데 모든 가격 확보를 보장하는 것으로 해석하지 않는다. 나머지 coverage 집계는 번들의 예산·진행 판단 결과이며 사이트 주소·품목별 결과를 공개하지 않는다.

## 실행 비용과 검증

공개 저장소의 표준 `ubuntu-latest` GitHub 호스팅 runner 무료 실행 범위만 전제한다. 유료·대형 runner, 외부 유료 서비스, 결제·예산 변경은 구성하지 않는다. 공개 여부나 GitHub 정책·계정 조건이 달라지면 실행 조건을 재확인한다. 이 실행기 자체는 특정 사이트 접근이나 정해진 수집량 확보를 보장하지 않는다.

`npm test`는 합성 모듈과 예약 도메인만 사용해 다운로드 인증·크기·MIME·해시·redirect·Secret 제거·IPC 실행·출력 제한·임시 파일 정리·workflow 경계를 검증한다. 실제 비공개 서비스와의 통신이나 사이트 수집은 테스트하지 않는다.

별도 라이선스를 부여하지 않았다. 공개 열람과 코드 사용·재배포 허가는 별개다.
