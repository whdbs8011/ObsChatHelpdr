const $ = id => document.getElementById(id);
let events = [], paused = false, settingsLoaded = false, nextPage = null;
let liveLoaded = false, liveLoading = false, selectedCategory = null, categoryChanged = false, categorySearchVersion = 0;
let brokerMode = false;
function feedback(text, error = false) { $('feedback').textContent = text; $('feedback').classList.toggle('error', error); $('feedback').hidden = false; }
async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dock-Request': '1' }, body: JSON.stringify(body) });
  const data = await res.json(); if (!res.ok) throw new Error(data.error || '요청 실패'); return data;
}
async function run(button, job) { button.disabled = true; try { await job(); } catch (e) { feedback(e.message, true); } finally { button.disabled = false; } }
async function syncStatus() { const s = await api('/api/status'); $('loginPanel').hidden = s.loggedIn; $('dashboard').hidden = !s.loggedIn; $('logout').hidden = !s.loggedIn; $('status').textContent = s.feedStatus; $('dot').classList.toggle('online', s.feedStatus === '채팅 연결됨');
  brokerMode = !!s.brokerMode;
  for (const id of ['clientId', 'clientSecret']) { $(id).required = !brokerMode; $(id).closest('label').hidden = brokerMode; }
  $('localLoginHelp').hidden = brokerMode;
  $('loginDescription').textContent = brokerMode ? '치지직 계정으로 로그인하면 내 방송 채팅과 설정이 연결됩니다.' : '개발자 센터에서 발급한 정보를 입력하세요. 실행 중에만 보관합니다.';
  $('loginForm').querySelector('button').textContent = brokerMode ? '치지직 로그인' : '브라우저에서 로그인';
  $('chatHealth').textContent = s.channelId ? `연결 채널: ${s.channelId} · 채팅 ${s.receivedChats || 0}개 수신` + (s.lastChatAt ? ` · 마지막 수신 ${new Date(s.lastChatAt).toLocaleTimeString('ko-KR')}` : ' · 치지직에서 채팅을 입력해 확인하세요.') : '방송 계정으로 로그인하면 해당 계정의 채팅에 자동 연결됩니다.';
}
$('loginForm').onsubmit = e => { e.preventDefault(); run(e.submitter, async () => {
  const tab = window.open('about:blank', '_blank');
  try { const result = await api('/api/login', brokerMode ? {} : { clientId: $('clientId').value, clientSecret: $('clientSecret').value }); $('clientSecret').value = ''; $('loginLink').href = result.url; $('loginLink').hidden = false; if (tab) tab.location = result.url; feedback('브라우저에서 로그인하세요. 창이 열리지 않으면 로그인 페이지 열기를 누르세요.'); }
  catch (error) { if (tab) tab.close(); throw error; }
}); };
$('logout').onclick = e => run(e.currentTarget, async () => { await api('/api/logout', {}); events = []; settingsLoaded = false; liveLoaded = false; selectedCategory = null; categoryChanged = false; categorySearchVersion++; $('saveLive').disabled = true; $('saveSettings').disabled = true; $('title').value = ''; $('tags').value = ''; $('categoryName').textContent = '방송 정보를 불러오세요.'; $('categoryResults').replaceChildren(); $('restrictions').replaceChildren(); await syncStatus(); feedback('로그아웃했습니다.'); });
$('reconnect').onclick = e => run(e.currentTarget, () => api('/api/reconnect', {}));
document.querySelectorAll('[data-tab]').forEach(button => button.onclick = () => { document.querySelectorAll('.tab').forEach(tab => tab.hidden = tab.id !== button.dataset.tab); document.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b === button)); if (button.dataset.tab === 'broadcast' && !liveLoaded && !liveLoading) run($('loadLive'), loadLive); });
function node(tag, text, className) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; }
function openModeration(d, name) {
  document.querySelector('.moderation-dialog')?.close();
  const dialog = node('dialog', undefined, 'moderation-dialog');
  const heading = node('h2', name + ' · 채팅 관리');
  heading.id = 'moderation-heading'; dialog.setAttribute('aria-labelledby', heading.id);
  dialog.append(heading, node('p', d.content, 'moderation-preview'));
  const actions = node('div', undefined, 'moderation-options');
  if (d.chatChannelId && d.senderChannelId && d.messageTime) {
    const hide = node('button', '이 메시지 숨기기');
    hide.onclick = () => run(hide, async () => {
      if (!confirm(`${name}님의 이 메시지를 치지직에서 숨길까요?`)) return;
      await api('/api/chat/hide', { chatChannelId: d.chatChannelId, senderChannelId: d.senderChannelId, messageTime: d.messageTime });
      d.content = '(숨긴 메시지)'; dialog.close(); renderFeed(); feedback('메시지를 숨겼습니다.');
    }); actions.append(hide);
  }
  if (d.senderChannelId) {
    const restrict = node('button', '이 사용자 활동 제한', 'danger');
    restrict.onclick = () => run(restrict, async () => {
      if (!confirm(`${name}님을 활동 제한할까요?`)) return;
      await api('/api/restrict', { targetChannelId: d.senderChannelId });
      dialog.close(); feedback('활동 제한을 추가했습니다.');
    }); actions.append(restrict);
  }
  if (!actions.children.length) actions.append(node('p', '관리할 수 있는 사용자 정보가 없습니다.', 'muted'));
  const close = node('button', '닫기'); close.autofocus = true; close.onclick = () => dialog.close();
  dialog.append(actions, close);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.addEventListener('click', e => { if (e.target === dialog) { const box = dialog.getBoundingClientRect(); if (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom) dialog.close(); } });
  document.body.append(dialog); dialog.showModal();
}
const feedRows = new WeakMap();
let composingMessage = false, feedRenderPending = false;
function renderFeed() {
  if (paused) return;
  if (composingMessage) { feedRenderPending = true; return; }
  const feed = $('feed'), nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80, oldTop = feed.scrollTop;
  const query = $('search').value.toLowerCase();
  const rows = [];
  for (const event of events) {
    const d = event.data, name = d.profile?.nickname || d.donatorNickname || d.subscriberNickname || '시청자';
    const text = event.type === 'CHAT' ? d.content : event.type === 'DONATION' ? `${d.payAmount}원 후원 · ${d.donationText || ''}` : `${d.tierName || '구독'} · ${d.month || 1}개월`;
    if (!(name + text).toLowerCase().includes(query)) continue;
    const cached = feedRows.get(event);
    if (cached && cached.text === text && cached.name === name) { rows.push(cached.row); continue; }
    const row = node('article', undefined, 'event ' + event.type.toLowerCase());
    if (event.type === 'CHAT') {
      const line = node('div', undefined, 'chat-line');
      const nickname = node('button', name, 'chat-nickname');
      nickname.type = 'button'; nickname.setAttribute('aria-label', name + ' 채팅 관리'); nickname.setAttribute('aria-haspopup', 'dialog');
      nickname.onclick = () => openModeration(d, name);
      line.append(nickname, node('span', text, 'chat-content'));
      row.append(line);
    } else {
      row.append(node('b', name), node('time', new Date(event.time).toLocaleTimeString('ko-KR')), node('p', text));
    }
    feedRows.set(event, { row, text, name }); rows.push(row);
  }
  // Keep existing rows in place: a new message must not recreate and animate the entire history.
  let cursor = feed.firstChild;
  for (const row of rows) {
    if (cursor === row) cursor = cursor.nextSibling;
    else feed.insertBefore(row, cursor);
  }
  while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
  if (!rows.length) feed.append(node('p', query ? '검색 결과가 없습니다.' : '새로운 채팅을 기다리고 있습니다.', 'muted'));
  feed.scrollTop = nearBottom ? feed.scrollHeight : oldTop;
}
const stream = new EventSource('/api/events');
stream.onmessage = e => { const event = JSON.parse(e.data);
  if (event.type === 'HISTORY') { events = event.data; renderFeed(); }
  else if (['CHAT', 'DONATION', 'SUBSCRIPTION'].includes(event.type)) { events.push(event); if (events.length > 400) events.shift(); renderFeed(); }
  else if (event.type === 'CONNECTION') syncStatus().catch(e => feedback(e.message, true));
  else if (event.type === 'STATUS') { $('status').textContent = event.data; $('dot').classList.toggle('online', event.data === '채팅 연결됨'); }
  else if (event.type === 'ERROR') feedback(event.data, true);
  else if (event.type === 'LOGIN') { $('loginLink').hidden = true; syncStatus().catch(e => feedback(e.message, true)); }
  else if (event.type === 'RESET') { events = []; renderFeed(); syncStatus().catch(e => feedback(e.message, true)); }
};
stream.onerror = () => { $('status').textContent = '프로그램과 연결이 끊겼습니다. 프로그램 실행 상태를 확인하세요.'; $('dot').classList.remove('online'); };
stream.onopen = () => syncStatus().catch(e => feedback(e.message, true));
$('pause').onclick = () => { paused = !paused; $('pause').textContent = paused ? '계속 보기' : '일시정지'; renderFeed(); };
$('clear').onclick = () => { events = []; paused = false; $('pause').textContent = '일시정지'; renderFeed(); };
$('search').oninput = renderFeed;
$('fontSize').value = localStorage.getItem('dock-font') || '16'; $('feed').style.fontSize = $('fontSize').value + 'px';
$('fontSize').onchange = () => { $('feed').style.fontSize = $('fontSize').value + 'px'; localStorage.setItem('dock-font', $('fontSize').value); };
let messageSending = false;
async function sendMessage() {
  if (messageSending) return;
  const original = $('message').value, message = original.trim();
  if (!message) { $('message').focus(); return; }
  messageSending = true; $('sendChat').disabled = true;
  try {
    await api('/api/chat/send', { message });
    if ($('message').value === original) $('message').value = '';
    feedback('채팅을 보냈습니다.');
  } catch (error) { feedback(error.message, true); }
  finally { messageSending = false; $('sendChat').disabled = false; }
}
$('sendForm').onsubmit = e => { e.preventDefault(); sendMessage(); };
$('message').addEventListener('compositionstart', () => { composingMessage = true; });
$('message').addEventListener('compositionend', () => {
  composingMessage = false;
  if (feedRenderPending) { feedRenderPending = false; requestAnimationFrame(renderFeed); }
});
$('message').addEventListener('blur', () => {
  composingMessage = false;
  if (feedRenderPending) { feedRenderPending = false; requestAnimationFrame(renderFeed); }
});
$('message').onkeydown = e => {
  if (e.key === 'Enter' && !e.shiftKey && !composingMessage && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault(); if (!e.repeat) sendMessage();
  }
};
function showSelectedCategory() { $('categoryName').textContent = selectedCategory?.categoryValue || '카테고리 없음'; }
async function loadLive() {
  liveLoading = true; $('saveLive').disabled = true;
  try {
    const d = await api('/api/live');
    $('title').value = d.defaultLiveTitle || '';
    selectedCategory = d.category?.categoryId ? d.category : null;
    categoryChanged = false; showSelectedCategory();
    $('tags').value = (d.tags || []).join(', ');
    $('categoryQuery').value = ''; $('categoryResults').replaceChildren(); categorySearchVersion++;
    liveLoaded = true; feedback('현재 방송 제목·카테고리·태그를 불러왔습니다.');
  } finally { liveLoading = false; $('saveLive').disabled = !liveLoaded; }
}
$('loadLive').onclick = e => run(e.currentTarget, loadLive);
$('clearCategory').onclick = () => { selectedCategory = null; categoryChanged = true; showSelectedCategory(); };
async function searchCategories() {
  const query = $('categoryQuery').value.trim(), version = ++categorySearchVersion;
  if (!query) { $('categoryResults').replaceChildren(node('p', '검색할 이름을 입력하세요.', 'muted small')); return; }
  $('categoryResults').replaceChildren(node('p', '검색 중…', 'muted small'));
  try {
    const result = await api('/api/categories?query=' + encodeURIComponent(query));
    if (version !== categorySearchVersion || query !== $('categoryQuery').value.trim()) return;
    const list = result.data || []; $('categoryResults').replaceChildren();
    if (!list.length) $('categoryResults').append(node('p', '검색 결과가 없습니다. 이름을 짧게 바꿔 검색해 보세요.', 'muted small'));
    for (const category of list) {
      const button = node('button', undefined, 'category-result'); button.type = 'button';
      button.append(node('strong', category.categoryValue), node('span', { GAME: '게임', SPORTS: '스포츠', ETC: '기타' }[category.categoryType] || '', 'muted small'));
      button.onclick = () => { selectedCategory = category; categoryChanged = true; showSelectedCategory(); $('categoryResults').replaceChildren(); $('categoryQuery').value = ''; categorySearchVersion++; feedback(category.categoryValue + ' 선택됨. 적용 버튼을 누르면 방송에 반영됩니다.'); };
      $('categoryResults').append(button);
    }
  } catch (error) { if (version === categorySearchVersion) { $('categoryResults').replaceChildren(node('p', error.message, 'muted small')); throw error; } }
}
$('searchCategory').onclick = e => run(e.currentTarget, searchCategories);
$('categoryQuery').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); if (!$('searchCategory').disabled) run($('searchCategory'), searchCategories); } };
$('categoryQuery').oninput = () => { categorySearchVersion++; $('categoryResults').replaceChildren(); };
$('liveForm').onsubmit = e => { e.preventDefault(); run(e.submitter, async () => {
  if (!liveLoaded) throw new Error('방송 정보를 먼저 불러오세요.');
  const body = { defaultLiveTitle: $('title').value, tags: [...new Set($('tags').value.split(/[,，]/).map(x => x.trim()).filter(Boolean))] };
  if (categoryChanged) { if (selectedCategory) { body.categoryType = selectedCategory.categoryType; body.categoryId = selectedCategory.categoryId; } else body.categoryId = ''; }
  await api('/api/live/save', body); categoryChanged = false; feedback('방송 제목·카테고리·태그를 적용했습니다.');
}); };
const settingFields = ['chatAvailableGroup', 'chatAvailableCondition', 'minFollowerMinute', 'chatSlowModeSec', 'allowSubscriberInFollowerMode', 'chatEmojiMode'];
for (const v of [0,5,10,30,60,1440,10080,43200,86400,129600,172800,216000,259200]) { const option = node('option', v < 60 ? `${v}분` : v < 1440 ? `${v/60}시간` : `${v/1440}일`); option.value = v; $('minFollowerMinute').append(option); }
for (const v of [0,3,5,10,30,60,120,300]) { const option = node('option', v ? `${v}초` : '제한 없음'); option.value = v; $('chatSlowModeSec').append(option); }
$('loadSettings').onclick = e => run(e.currentTarget, async () => { const d = await api('/api/chat/settings'); for (const key of settingFields) { if (d[key] === undefined) throw new Error('일부 설정값을 받지 못했습니다. 다시 불러오세요.'); if ($(key).type === 'checkbox') $(key).checked = d[key]; else $(key).value = d[key]; } settingsLoaded = true; $('saveSettings').disabled = false; feedback('채팅 설정을 불러왔습니다.'); });
$('settingsForm').onsubmit = e => { e.preventDefault(); if (!settingsLoaded) return; run(e.submitter, async () => { const body = {}; for (const key of settingFields) body[key] = $(key).type === 'checkbox' ? $(key).checked : ['minFollowerMinute','chatSlowModeSec'].includes(key) ? Number($(key).value) : $(key).value; await api('/api/chat/settings/save', body); feedback('채팅 설정을 적용했습니다.'); }); };
async function loadRestrictions(append = false) {
  const d = await api('/api/restrictions' + (append && nextPage ? '?next=' + encodeURIComponent(nextPage) : ''));
  const list = Array.isArray(d) ? d : d.data || d.restrictChannels || [];
  if (!append) $('restrictions').replaceChildren();
  for (const person of list) { const row = node('div', undefined, 'event'); row.append(node('b', person.restrictedChannelName || person.restrictedChannelId)); const button = node('button', '제한 해제'); button.onclick = () => run(button, async () => { if (!confirm('활동 제한을 해제할까요?')) return; await api('/api/unrestrict', { targetChannelId: person.restrictedChannelId }); row.remove(); feedback('제한을 해제했습니다.'); }); row.append(button); $('restrictions').append(row); }
  nextPage = d.page?.next || null; $('moreRestrictions').hidden = !nextPage;
  if (!list.length && !append) $('restrictions').append(node('p', '활동 제한 목록이 비어 있습니다.', 'muted'));
}
$('loadRestrictions').onclick = e => run(e.currentTarget, () => loadRestrictions());
$('moreRestrictions').onclick = e => run(e.currentTarget, () => loadRestrictions(true));
$('restrictForm').onsubmit = e => { e.preventDefault(); run(e.submitter, async () => { await api('/api/restrict', { targetChannelId: $('targetChannelId').value }); feedback('활동 제한을 추가했습니다.'); }); };
syncStatus().catch(e => feedback(e.message, true));
setInterval(() => syncStatus().catch(() => {}), 5000);

// Soften only the rows that cross a visible scroll boundary.
let scrollEffectFrame = 0;
function scheduleScrollEffects() {
  if (scrollEffectFrame) return;
  scrollEffectFrame = requestAnimationFrame(() => {
    scrollEffectFrame = 0;
    if ($('chat').hidden || $('dashboard').hidden) return;
    const box = $('feed').getBoundingClientRect();
    const composer = $('sendForm').getBoundingClientRect();
    const top = Math.max(box.top, 0), bottom = Math.min(box.bottom, innerHeight, composer.top);
    for (const row of $('feed').children) {
      if (!row.classList.contains('event')) continue;
      const rect = row.getBoundingClientRect();
      const cut = Math.max(top - rect.top, rect.bottom - bottom, 0);
      const amount = Math.min(1, cut / Math.max(1, Math.min(rect.height, 32)));
      row.style.setProperty('--scroll-blur', (amount * 4).toFixed(2) + 'px');
      row.style.setProperty('--scroll-opacity', (1 - amount * .6).toFixed(2));
    }
  });
}
$('feed').addEventListener('scroll', scheduleScrollEffects, { passive: true });
window.addEventListener('scroll', scheduleScrollEffects, { passive: true });
window.addEventListener('resize', scheduleScrollEffects, { passive: true });
new MutationObserver(scheduleScrollEffects).observe($('feed'), { childList: true });
new ResizeObserver(scheduleScrollEffects).observe($('feed'));
const viewportFade = new IntersectionObserver(entries => {
  for (const entry of entries) entry.target.classList.toggle('scroll-away', entry.intersectionRatio < .65);
}, { threshold: [0, .65, 1] });
for (const element of document.querySelectorAll('header, .status, nav, .toolbar, #search, #liveForm > label, #settingsForm > label, .selected-category, footer')) {
  element.classList.add('viewport-soften'); viewportFade.observe(element);
}
scheduleScrollEffects();
