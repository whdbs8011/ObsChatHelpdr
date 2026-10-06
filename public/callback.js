const data = new URLSearchParams(location.hash.slice(1));
history.replaceState(null, '', location.pathname);
fetch('/api/broker/complete', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dock-Request': '1' }, body: JSON.stringify({ handoff: data.get('handoff'), state: data.get('state') }) }).then(async response => {
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '연결 실패');
  location.replace('/');
}).catch(error => { document.getElementById('result').textContent = error.message; });
