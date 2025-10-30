const API_BASE = location.origin.replace(/:\d+$/, ':8080'); // adjust if needed
let token = localStorage.getItem('tp_token') || '';
let lang = localStorage.getItem('tp_lang') || 'en';

function setLang(v) {
  lang = v; localStorage.setItem('tp_lang', v);
  document.getElementById('lang').value = v;
  // Simple demo translation
  document.getElementById('title').textContent = v === 'sw' ? 'TaskPesa Kenya — Pata Kila Siku, Toa Wiki' : 'TaskPesa Kenya — Earn Daily, Withdraw Weekly';
  document.getElementById('authTitle').textContent = v === 'sw' ? 'Akaunti (Simu)' : 'Auth (Phone)';
  document.getElementById('profileTitle').textContent = v === 'sw' ? 'Wasifu Wangu' : 'My Profile';
  document.getElementById('btnRegister').textContent = v === 'sw' ? 'Jisajili' : 'Register';
  document.getElementById('btnLogin').textContent = v === 'sw' ? 'Ingia' : 'Login';
  document.getElementById('btnSaveAvatar').textContent = v === 'sw' ? 'Hifadhi Picha' : 'Save Avatar';
  document.getElementById('btnChangePwd').textContent = v === 'sw' ? 'Badili Nenosiri' : 'Change Password';
  document.getElementById('btnDelete').textContent = v === 'sw' ? 'Futa Akaunti' : 'Delete Account';
}
setLang(lang);

function getQueryParam(name) {
  const url = new URL(location.href);
  return url.searchParams.get(name);
}

function setToken(t) {
  token = t;
  localStorage.setItem('tp_token', t);
  document.getElementById('tokenPreview').textContent = t ? t.slice(0, 16) + '…' : '';
  if (t) { loadMe(); loadReferrals(); }
}
setToken(token);

function csrfHeaders() {
  const csrf = document.cookie.split('; ').find(c => c.startsWith('tp_csrf='));
  const v = csrf ? csrf.split('=')[1] : '';
  return { 'X-CSRF-Token': v };
}

async function register() {
  const phone = document.getElementById('phone').value;
  const password = document.getElementById('password').value;
  const referralCode = getQueryParam('ref');
  const res = await fetch(`${API_BASE}/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...csrfHeaders() }, credentials: 'include', body: JSON.stringify({ phone, password, referralCode }) });
  const data = await res.json();
  if (res.ok) setToken(data.token); else alert(JSON.stringify(data));
}

async function login() {
  const phone = document.getElementById('phone').value;
  const password = document.getElementById('password').value;
  const res = await fetch(`${API_BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...csrfHeaders() }, credentials: 'include', body: JSON.stringify({ phone, password }) });
  const data = await res.json();
  if (res.ok) setToken(data.token); else alert(JSON.stringify(data));
}

async function loadMe() {
  if (!token) return;
  const res = await fetch(`${API_BASE}/me`, { headers: { Authorization: `Bearer ${token}` }, credentials: 'include' });
  const data = await res.json();
  const u = data.user || {};
  const pkg = data.activePackage || null;
  const initials = (u.phone || 'TP').slice(-2);
  const avatar = u.avatar_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(initials)}&background=random`;
  document.getElementById('me').innerHTML = `
    Phone: <b>${u.phone || ''}</b><br/>
    Balance: <b>${u.balance_kes || 0} KES</b><br/>
    Avatar: <img src="${avatar}" alt="avatar" width="40"/><br/>
    Active Package: ${pkg ? `${pkg.name} — ${pkg.tasks_per_day}/day ${pkg.task_type} — ends ${new Date(pkg.end_date).toLocaleString()}` : 'none'}
  `;
}

async function loadReferrals() {
  if (!token) return;
  const res = await fetch(`${API_BASE}/referrals`, { headers: { Authorization: `Bearer ${token}` }, credentials: 'include' });
  const data = await res.json();
  const code = data.referralCode || '';
  const share = `${location.origin}${location.pathname}?ref=${encodeURIComponent(code)}`;
  const wrap = document.getElementById('referralCodeWrap');
  wrap.innerHTML = code ? `Code: <b>${code}</b> · Share: <input value="${share}" readonly style="width:60%"> · Total: ${data.total} · Rewards: ${data.rewardsKes} KES` : 'No code';
  const list = document.getElementById('referralsList');
  list.innerHTML = '';
  (data.referrals || []).forEach(r => {
    const div = document.createElement('div');
    div.className = 'card';
    div.textContent = `${r.referred_phone || 'user'} — reward ${r.reward_kes} KES — ${r.rewarded ? 'rewarded' : 'pending'}`;
    list.appendChild(div);
  });
}

async function saveAvatar() {
  const avatarUrl = document.getElementById('avatarUrl').value;
  const res = await fetch(`${API_BASE}/me/avatar`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...csrfHeaders() }, credentials: 'include', body: JSON.stringify({ avatarUrl }) });
  if (!res.ok) alert(await res.text()); else loadMe();
}

async function changePassword() {
  const oldPassword = document.getElementById('oldPwd').value;
  const newPassword = document.getElementById('newPwd').value;
  const res = await fetch(`${API_BASE}/me/password`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...csrfHeaders() }, credentials: 'include', body: JSON.stringify({ oldPassword, newPassword }) });
  if (!res.ok) alert(await res.text()); else alert('Password updated');
}

async function deleteAccount() {
  if (!confirm('Delete your account? This cannot be undone.')) return;
  const res = await fetch(`${API_BASE}/me`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}`, ...csrfHeaders() }, credentials: 'include' });
  if (!res.ok) return alert(await res.text());
  setToken('');
  alert('Account deleted');
}

async function submitDeposit() {
  if (!token) return alert('login first');
  const mpesaCode = document.getElementById('depositCode').value;
  const amountKes = Number(document.getElementById('depositAmount').value);
  const proofUrl = document.getElementById('depositProof').value;
  const res = await fetch(`${API_BASE}/deposits`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...csrfHeaders() }, credentials: 'include', body: JSON.stringify({ mpesaCode, amountKes, proofUrl }) });
  const data = await res.json();
  if (!res.ok) return alert(JSON.stringify(data));
  await loadDeposits();
}

async function loadDeposits() {
  if (!token) return alert('login first');
  const res = await fetch(`${API_BASE}/deposits`, { headers: { Authorization: `Bearer ${token}` }, credentials: 'include' });
  const list = await res.json();
  document.getElementById('deposits').textContent = JSON.stringify(list, null, 2);
  const sel = document.getElementById('depositSelect');
  if (sel) {
    sel.innerHTML = '';
    list.filter(d => d.status === 'verified').forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = `${d.mpesa_code} — ${d.amount_kes} KES (remain ${d.remaining_kes ?? d.amount_kes})`;
      sel.appendChild(opt);
    });
  }
}

async function loadPackages() {
  const res = await fetch(`${API_BASE}/packages`);
  const pkgs = await res.json();
  const sel = document.getElementById('pkgSelect');
  sel.innerHTML = '';
  pkgs.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id; opt.textContent = `${p.name} — ${p.tasks_per_day}/day ${p.task_type}`;
    sel.appendChild(opt);
  });
  document.getElementById('packages').textContent = JSON.stringify(pkgs, null, 2);
}

async function purchase() {
  if (!token) return alert('login first');
  const packageId = Number(document.getElementById('pkgSelect').value);
  const depositSel = document.getElementById('depositSelect');
  const depositId = depositSel && depositSel.value ? Number(depositSel.value) : null;
  if (!depositId) return alert('Select a verified deposit');
  const res = await fetch(`${API_BASE}/purchase`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...csrfHeaders() }, credentials: 'include', body: JSON.stringify({ packageId, depositId }) });
  const data = await res.json();
  if (!res.ok) alert(JSON.stringify(data)); else { alert('Package activated'); loadMe(); loadDeposits(); }
}

async function loadTodayTasks() {
  if (!token) return alert('login first');
  const res = await fetch(`${API_BASE}/tasks/today`, { headers: { Authorization: `Bearer ${token}` }, credentials: 'include' });
  const tasks = await res.json();
  const wrap = document.getElementById('tasks');
  wrap.innerHTML = '';
  tasks.forEach(t => {
    const div = document.createElement('div');
    div.className = 'card';
    div.innerHTML = `<b>${t.title}</b> <small>(${t.task_type}, +${t.reward_kes} KES)</small><br/>${t.description}<br/>Status: ${t.status}<br/>`;
    if (t.status === 'pending') {
      const input = document.createElement('input');
      input.placeholder = 'Proof URL (optional)';
      const txt = document.createElement('input');
      txt.placeholder = 'Text (if required)';
      const btn = document.createElement('button'); btn.textContent = 'Submit';
      btn.onclick = async () => {
        const res2 = await fetch(`${API_BASE}/tasks/submit`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...csrfHeaders() }, credentials: 'include', body: JSON.stringify({ assignmentId: t.assignment_id, proofUrl: input.value || null, text: txt.value || '' }) });
        if (!res2.ok) alert(await res2.text()); else loadTodayTasks();
      };
      div.appendChild(txt);
      div.appendChild(input);
      div.appendChild(btn);
    }
    wrap.appendChild(div);
  });
}

async function loadLedger() {
  if (!token) return;
  const res = await fetch(`${API_BASE}/ledger?limit=50`, { headers: { Authorization: `Bearer ${token}` }, credentials: 'include' });
  const rows = await res.json();
  document.getElementById('ledger').textContent = JSON.stringify(rows, null, 2);
}

async function requestWithdraw() {
  if (!token) return alert('login first');
  const amountKes = Number(document.getElementById('withdrawAmount').value);
  const res = await fetch(`${API_BASE}/withdrawals/request`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...csrfHeaders() }, credentials: 'include', body: JSON.stringify({ amountKes }) });
  const data = await res.json();
  document.getElementById('withdrawResult').textContent = JSON.stringify(data, null, 2);
  if (res.ok) loadMe();
}
