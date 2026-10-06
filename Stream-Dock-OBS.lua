local obs = obslua
local ffi = require('ffi')
ffi.cdef[[
int __stdcall MultiByteToWideChar(unsigned int, unsigned long, const char *, int, unsigned short *, int);
void * __stdcall ShellExecuteW(void *, const unsigned short *, const unsigned short *, const unsigned short *, const unsigned short *, int);
]]
local kernel = ffi.load('kernel32')
local shell = ffi.load('shell32')
local root = script_path():gsub('/', '\\'):gsub('\\$', '')
local function wide(text)
  local count = kernel.MultiByteToWideChar(65001, 0, text, -1, nil, 0)
  if count == 0 then error('Unable to convert Stream Dock path') end
  local buffer = ffi.new('unsigned short[?]', count)
  if kernel.MultiByteToWideChar(65001, 0, text, -1, buffer, count) == 0 then error('Invalid Stream Dock path') end
  return buffer
end
local function launch(action)
  local file = io.open(root .. '\\Run.vbs', 'rb')
  if not file then obs.script_log(obs.LOG_ERROR, 'Stream Dock: keep this script in the original program folder.'); return false end
  file:close()
  local result = shell.ShellExecuteW(nil, wide('open'), wide('wscript.exe'), wide('"' .. root .. '\\Run.vbs" ' .. action), wide(root), 0)
  if tonumber(ffi.cast('intptr_t', result)) <= 32 then
    obs.script_log(obs.LOG_ERROR, 'Stream Dock: failed to start the local server.'); return false
  end
  return true
end
function script_description()
  return 'OBS 실행 시 치지직 독 서버를 자동으로 시작합니다.\n독 주소: http://localhost:18765/\n최초 한 번 사용자 지정 브라우저 독에 추가하세요.\n이 스크립트는 프로그램 폴더에 그대로 두세요.\n등록하면 이 폴더의 Windows 자동 실행은 해제됩니다.'
end
function script_properties()
  local props = obs.obs_properties_create()
  obs.obs_properties_add_button(props, 'open', '관리 화면 열기', function() launch('Open'); return false end)
  obs.obs_properties_add_button(props, 'restart', '서버 시작 / 연결 확인', function() launch('ObsStart'); return false end)
  return props
end
local function frontend_event(event)
  if event == obs.OBS_FRONTEND_EVENT_EXIT then launch('Stop') end
end
function script_load(settings)
  launch('ObsStart')
  obs.obs_frontend_add_event_callback(frontend_event)
end
function script_unload()
  obs.obs_frontend_remove_event_callback(frontend_event)
end
