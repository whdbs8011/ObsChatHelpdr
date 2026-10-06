# Stream Dock 로그인 서버 · Cloudflare Workers Free

Cloudflare Workers와 D1으로 치지직 Client Secret을 서버에만 보관합니다. 채팅 수신·방송 설정 API는 이용자의 로컬 프로그램에서 실행합니다. 카테고리 검색은 Client 인증이 필요해 로그인 서버가 대신 처리합니다.

## 운영자 배포

1. 이 폴더에서 `npm install`을 실행합니다.
2. `npx wrangler login`으로 Cloudflare 계정에 연결합니다.
3. `npx wrangler d1 create stream-dock-auth`로 D1을 만들고 반환된 ID를 `wrangler.jsonc`의 `database_id`에 입력합니다.
4. `npx wrangler d1 execute stream-dock-auth --remote --file=schema.sql`로 테이블을 만듭니다.
5. `npx wrangler deploy`로 Worker를 배포하고 반환된 HTTPS 주소를 확인합니다.
6. Cloudflare 대시보드의 해당 Worker → Settings → Variables and Secrets에서 다음 항목을 **Secret**으로 추가합니다.
   - `CHZZK_CLIENT_ID`: 치지직 애플리케이션 Client ID
   - `CHZZK_CLIENT_SECRET`: 치지직 애플리케이션 Client Secret
   - `TOKEN_ENCRYPTION_KEY`: 32바이트의 무작위 데이터를 base64url로 인코딩한 값
7. 치지직 개발자 센터의 로그인 리디렉션 URL을 `https://실제-Worker-주소/callback`으로 등록합니다. 프로그램에서 사용 중인 API 권한도 활성화합니다.
8. 이용자용 로컬 프로그램에는 배포한 서버 주소를 `auth-server.json`에 넣습니다. 이번 배포 주소는 `https://stream-dock-auth.choyoon0811.workers.dev`이며 준비된 파일에 이미 반영했습니다. 프로그램을 다시 실행하면 Client ID·Secret 입력 대신 **치지직 로그인** 버튼이 표시됩니다.

로컬 프로그램은 기기 연결 키를 `.local/device.dat`에 Windows 현재 계정용 DPAPI로 암호화해 저장합니다. 서버 주소가 같고 세션이 유효하면 프로그램 재시작 후 연결을 복원합니다. `.local` 폴더는 배포 ZIP에 포함하지 마세요.

암호화 키·Client Secret을 코드나 배포 ZIP에 넣지 마세요. `/health`는 프로그램 배포 상태만 나타내며 실제 치지직 인증 성공을 보장하지 않습니다. 무료 플랜을 유지하며 Paid 업그레이드는 필요하지 않습니다. 외부 공개 시 사용량을 모니터링하세요.

## 인증 흐름

로컬 프로그램이 무작위 검증 키를 만들고 해시만 서버에 전달 → 브라우저에서 치지직 동의 → 서버에서 인증 코드 교환 → 브라우저가 일회용 연결 ID만 localhost에 전달 → 로컬 프로그램이 원래 검증 키로 연결 ID 교환.

Client Secret과 Refresh Token은 로컬 프로그램에 전달하지 않습니다. D1에는 토큰을 AES-GCM으로 암호화하고, 프로그램 접속 키는 해시만 저장합니다. 연결 ID는 2분, 로그인 요청은 10분 뒤 만료되며 원자적으로 한 번만 사용됩니다. 임의 리디렉션 주소를 받지 않고 localhost 주소를 고정합니다. 세션 갱신에는 잠금을 사용해 일회용 Refresh Token의 중복 사용을 방지합니다.

최대 **10개의 활성 PC 로그인 세션**을 허용합니다. 10명의 실명 사용자를 제한하거나 초대제로 운영하는 기능은 이 버전에 포함하지 않습니다. 같은 치지직 계정의 토큰을 폐기하면 해당 애플리케이션으로 인증된 같은 계정의 다른 토큰도 영향을 받을 수 있습니다.

## 검증

`npm test`: 암호화/변조 방지, 브라우저 연결 확인, 검증 키 확인, 일회용 교환, 토큰 갱신, 로그아웃, 만료 및 세션 상한.
실제 Cloudflare 배포·치지직 계정 로그인은 운영자의 계정 연결과 Secret 등록 후 확인해야 합니다.

## 무료 한도

Workers Free와 D1 Free의 공식 한도를 적용합니다. 이 서버는 채팅 메시지를 저장하거나 중계하지 않습니다. 이용자 수만으로 무료 한도 준수를 보장할 수 없으며, 요청 수가 한도를 넘으면 요청이 실패할 수 있습니다.

https://developers.cloudflare.com/workers/platform/pricing/
https://developers.cloudflare.com/d1/platform/pricing/
https://chzzk.gitbook.io/chzzk/chzzk-api/authorization
