# GitHub 공개 시 참고

현재 프로그램 폴더를 저장소 루트로 사용해도 되고, 상위 작업 폴더를 사용해도 됩니다.
두 위치에 .gitignore를 적용했습니다.

## 공개 대상

프로그램 소스, OBS Lua 스크립트, 사용 안내, 로그인 서버 소스,
설정 예시, Node.js 라이선스를 공개할 수 있습니다.

## 제외 대상

- .local: 개인 로그인 정보
- .env / .dev.vars: 비밀 설정
- cleanup-backup.zip 및 ZIP 파일: 백업·배포 산출물
- auth-server.json / wrangler.jsonc: 실제 운영 설정
- node_modules / .wrangler: 개발 캐시
- runtime/node.exe: 실행 환경 바이너리 (runtime/LICENSE.txt는 유지)
- 미리보기 이미지: 계정·채팅 정보가 포함될 수 있음

이미 Git에 등록된 파일에는 .gitignore가 적용되지 않습니다.
외부 저장소에 이전에 올린 파일이 있다면 해당 저장소의 파일 목록과 과거 기록을 별도로 확인해야 합니다.

## 소스에서 실행

이 저장소에는 Node.js 실행 파일을 넣지 않습니다.
일반 사용자는 배포 ZIP을 사용하세요. 소스 사용자는 Windows x64 Node.js의
node.exe를 runtime 폴더에 준비하고 라이선스도 함께 유지해야 합니다.
auth-server.example.json을 auth-server.json으로 복사해 실제 로그인 서버 주소를 설정하세요.
서버를 직접 운영한다면 developer/auth-worker의 wrangler.example.jsonc를
wrangler.jsonc로 복사하고 실제 D1 ID를 입력하세요. 기존 운영자는 현재 설정을 그대로 사용합니다.
Client Secret과 암호화 키는 Cloudflare의 Secret으로만 등록합니다.

운영 서버 주소와 D1 ID는 인증 비밀값은 아니지만, 실제 설정은 예시와 분리했습니다.
공개 배포 전 허용 계정 및 로그인 요청 제한 보완은 별도로 필요합니다.
