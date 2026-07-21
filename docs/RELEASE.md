# 빌드 · 배포 · 자동 업데이트 가이드

## 개요

| 항목 | 방식 |
| --- | --- |
| 패키징 | [electron-builder](https://www.electron.build/) — 설정: [electron-builder.yml](../electron-builder.yml) |
| 배포 채널 | GitHub Releases ([skax-soulfactor/desktop-agent](https://github.com/skax-soulfactor/desktop-agent/releases)) |
| CI | GitHub Actions — `v*` 태그 푸시 시 3개 OS에서 빌드·업로드 ([release.yml](../.github/workflows/release.yml)) |
| 자동 업데이트 | electron-updater — 실행 시 + 4시간마다 Releases 확인 ([src/main/index.ts](../src/main/index.ts)) |

## 앱 아이콘

- 원본: [build/icon.svg](../build/icon.svg) — D 안에 A가 네거티브 스페이스로 들어간 모노그램
- 디자인을 수정했다면 PNG를 재생성한다:

  ```bash
  npm run icons   # build/icon.png(1024) + resources/icon.png(512) 생성
  ```

- macOS `.icns` / Windows `.ico`는 electron-builder가 `build/icon.png`에서 자동 생성한다.
  `resources/icon.png`는 Windows/Linux 창 아이콘으로 런타임에 사용된다.
- 생성된 PNG 두 개는 CI 빌드에 필요하므로 **커밋에 포함**한다.

## 로컬 빌드

```bash
npm run dist:mac     # dmg + zip        (macOS에서만)
npm run dist:win     # NSIS 설치 exe    (Windows에서만)
npm run dist:linux   # AppImage + deb   (Linux에서만)
npm run dist         # 현재 OS 타깃
```

산출물은 `dist/`에 생성된다 (gitignore 대상).
설치 없이 빠르게 확인만 하려면 `npx electron-builder --dir` — `dist/<platform>/`에
언팩된 앱이 만들어진다.

> 크로스 빌드(예: Mac에서 Windows 빌드)는 서명·네이티브 모듈 문제로 권장하지 않는다.
> OS별 빌드는 아래 CI에 맡긴다.

## 릴리스 절차 (배포는 이 두 줄이 전부)

```bash
npm version patch        # package.json 버전 증가 + v0.1.1 형식 태그 생성 (minor/major도 가능)
git push --follow-tags   # 태그가 푸시되면 CI가 자동 실행
```

태그 푸시를 감지한 [release.yml](../.github/workflows/release.yml)이:

1. macOS / Windows / Linux 러너 3곳에서 병렬로 `npm ci && npm run build` 후 electron-builder 실행
2. GitHub Release를 생성하고 설치 파일(dmg·zip·exe·AppImage·deb)과
   자동 업데이트 메타데이터(`latest.yml`, `latest-mac.yml`, `latest-linux.yml`)를 업로드

별도 시크릿 설정은 필요 없다 — 기본 제공되는 `GITHUB_TOKEN`으로 업로드한다
(워크플로에 `permissions: contents: write` 선언됨).

신규 사용자는 [Releases 페이지](https://github.com/skax-soulfactor/desktop-agent/releases)에서
자기 OS용 파일을 내려받아 설치한다.

## 자동 업데이트 동작 방식

[src/main/index.ts](../src/main/index.ts)에서 패키징된 빌드(`app.isPackaged`)에 한해:

1. 앱 실행 시 + 이후 4시간마다 `autoUpdater.checkForUpdatesAndNotify()` 호출
2. electron-updater가 GitHub Releases의 `latest*.yml`과 현재 버전을 비교
3. 새 버전이 있으면 백그라운드로 다운로드하고 OS 알림 표시
4. 사용자가 앱을 종료하면 자동 설치되고, 다음 실행부터 새 버전

즉 **릴리스 절차만 수행하면 기존 사용자에게 자동으로 전파**된다. 개발 모드(`npm run dev`)에서는
업데이트 체크를 하지 않는다.

플랫폼별 지원 범위:

| 플랫폼 | 자동 업데이트 | 비고 |
| --- | --- | --- |
| Windows (NSIS) | O | 서명 없어도 동작 |
| macOS (zip 타깃) | **서명 필수** | 미서명 빌드는 업데이트 불가 (아래 참고) |
| Linux AppImage | O | |
| Linux deb | X | 수동 재설치 필요 |

## 코드 서명 (미서명 배포 시 제약)

현재 설정은 서명 없이 빌드된다. 제약 사항:

- **macOS**: 첫 실행 시 Gatekeeper 경고 — 사용자가 우클릭 → 열기로 우회해야 한다.
  자동 업데이트도 동작하지 않는다. 해결하려면 Apple Developer Program(연 $99) 가입 후
  Developer ID 서명 + 공증(notarization)을 CI에 추가한다
  (`CSC_LINK`/`CSC_KEY_PASSWORD`, `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`
  시크릿 설정 — [electron-builder 문서](https://www.electron.build/code-signing) 참고).
- **Windows**: SmartScreen 경고가 뜨지만("추가 정보" → "실행") 설치·자동 업데이트 모두 동작한다.
  경고를 없애려면 코드 서명 인증서(EV 권장)가 필요하다.
- **Linux**: 서명 불필요.
