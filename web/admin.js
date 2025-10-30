const API_BASE = location.origin.replace(/:\d+$/, ':8080');
let ADMIN_KEY = localStorage.getItem('tp_admin_key') || '';

function setAdminKey() {
  ADMIN_KEY = document.getElementById('adminKey').value;
  localStorage.setItem('tp_admin_key', ADMIN_KEY);
  alert('Admin key set');
}

document.getElementById('adminKey').value = ADMIN_KEY;

function show(id) {
  ['analytics','users','deposits','withdrawals','tasks','settings','logs'].forEach(x => {
    document.getElementById(x).classList.toggle('hidden', x !== id);
  });
}

async function loadAnalytics() {
  const res = await fetch(`${API_BASE}/admin/analytics`, { headers: { 'x-admin-key': ADMIN_KEY } });
  const data = await res.json();
  document.getElementById('analyticsOut').textContent = JSON.stringify(data, null, 2);
  if (window.Chart) {
    const ctx = document.getElementById('chart1');
    new Chart(ctx, { type: 'bar', data: { labels: ['Users','Active Plans','Deposits','Withdrawals','Tasks'], datasets: [{ label: 'KPIs', data: [data.users, data.activePlans, data.depositsKes, data.withdrawalsKes, data.tasksCompleted], backgroundColor: ['#4caf50','#2196f3','#9c27b0','#ff9800','#607d8b'] }] }, options: { responsive: true, plugins: { legend: { display: false } } } });
  }
}

async function loadUsers() {
  const phone = document.getElementById('fUserPhone').value || '';
  const q = phone ? `?phone=${encodeURIComponent(phone)}` : '';
  const res = await fetch(`${API_BASE}/admin/users${q}`, { headers: { 'x-admin-key': ADMIN_KEY } });
  document.getElementById('usersOut').textContent = JSON.stringify(await res.json(), null, 2);
}

async function loadDepositsAdmin() {
  const status = document.getElementById('fDepositStatus').value;
  const uid = document.getElementById('fDepositUserId').value;
  const qp = new URLSearchParams();
  if (status) qp.set('status', status);
  if (uid) qp.set('userId', uid);
  const res = await fetch(`${API_BASE}/admin/deposits?${qp.toString()}`, { headers: { 'x-admin-key': ADMIN_KEY } });
  const items = await res.json();
  const wrap = document.getElementById('depositsList');
  wrap.innerHTML = '';
  items.forEach(d => {
    const div = document.createElement('div');
    div.className = 'card';
    div.innerHTML = `<b>${d.mpesa_code}</b> — ${d.amount_kes} KES — remain ${d.remaining_kes ?? d.amount_kes} — status: ${d.status} — user: ${d.user_id}`;
    if (d.status === 'pending') {
      const v = document.createElement('button'); v.textContent = 'Verify';
      v.onclick = async () => {
        const r = await fetch(`${API_BASE}/admin/deposits/${d.id}/verify`, { method: 'POST', headers: { 'x-admin-key': ADMIN_KEY } });
        if (!r.ok) alert(await r.text()); else loadDepositsAdmin();
      };
      const rej = document.createElement('button'); rej.textContent = 'Reject';
      rej.onclick = async () => {
        const r = await fetch(`${API_BASE}/admin/deposits/${d.id}/reject`, { method: 'POST', headers: { 'x-admin-key': ADMIN_KEY } });
        if (!r.ok) alert(await r.text()); else loadDepositsAdmin();
      };
      div.appendChild(v); div.appendChild(rej);
    }
    wrap.appendChild(div);
  });
}

async function loadWithdrawals() {
  const status = document.getElementById('fWStatus').value;
  const uid = document.getElementById('fWUserId').value;
  const qp = new URLSearchParams();
  if (status) qp.set('status', status);
  if (uid) qp.set('userId', uid);
  const res = await fetch(`${API_BASE}/admin/withdrawals?${qp.toString()}`, { headers: { 'x-admin-key': ADMIN_KEY } });
  const list = await res.json();
  const wrap = document.getElementById('withdrawalsList');
  wrap.innerHTML = '';
  list.forEach(w => {
    const div = document.createElement('div');
    div.className = 'card';
    div.innerHTML = `#${w.id} — user ${w.user_id} — ${w.amount_kes} KES — fee ${w.fee_kes} — ${w.status}`;
    if (w.status === 'pending') {
      const btn = document.createElement('button'); btn.textContent = 'Approve';
      btn.onclick = async () => {
        const r = await fetch(`${API_BASE}/admin/withdrawals/${w.id}/approve`, { method: 'POST', headers: { 'x-admin-key': ADMIN_KEY } });
        if (!r.ok) alert(await r.text()); else loadWithdrawals();
      };
      div.appendChild(btn);
    }
    wrap.appendChild(div);
  });
}

async function loadTasks() {
  const type = document.getElementById('fTaskType').value;
  const q = type ? `?type=${encodeURIComponent(type)}` : '';
  const res = await fetch(`${API_BASE}/admin/tasks${q}`, { headers: { 'x-admin-key': ADMIN_KEY } });
  document.getElementById('tasksOut').textContent = JSON.stringify(await res.json(), null, 2);
}

async function createTask() {
  const title = document.getElementById('tTitle').value;
  const description = document.getElementById('tDesc').value;
  const taskType = document.getElementById('tType').value;
  const rewardKes = Number(document.getElementById('tReward').value || 10);
  const completionTimeLimitSec = Number(document.getElementById('tTTL').value || 300);
  const active = document.getElementById('tActive').checked;
  const res = await fetch(`${API_BASE}/admin/tasks`, { method: 'POST', headers: { 'x-admin-key': ADMIN_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ title, description, taskType, rewardKes, completionTimeLimitSec, active }) });
  if (!res.ok) alert(await res.text()); else loadTasks();
}

async function generateDaily() {
  const res = await fetch(`${API_BASE}/admin/tasks/generate-daily`, { method: 'POST', headers: { 'x-admin-key': ADMIN_KEY } });
  const data = await res.json();
  alert(JSON.stringify(data));
  loadTasks();
}

function renderTiers(tiers) {
  const wrap = document.getElementById('tiers');
  wrap.innerHTML = '';
  tiers.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `Min <input data-i="${i}" data-k="min" type="number" value="${t.min}"> Max <input data-i="${i}" data-k="max" type="number" value="${t.max}"> % <input data-i="${i}" data-k="percent" type="number" value="${t.percent}">`;
    wrap.appendChild(row);
  });
}

let currentSettings = {};
async function loadSettings() {
  const res = await fetch(`${API_BASE}/admin/settings`, { headers: { 'x-admin-key': ADMIN_KEY } });
  const s = await res.json();
  currentSettings = s;
  document.getElementById('settingsOut').textContent = JSON.stringify(s, null, 2);
  const w = s.withdrawal || { min_kes: 750, max_kes: 10000 };
  document.getElementById('sMinKes').value = w.min_kes;
  document.getElementById('sMaxKes').value = w.max_kes;
  const mode = s.withdrawalApprovalMode?.mode || 'manual';
  document.getElementById('sApprovalMode').value = mode;
  const tiers = (s.commissions && s.commissions.tiers) || [ { min: 750, max: 2000, percent: 10 }, { min: 2001, max: 5000, percent: 8 }, { min: 5001, max: 10000, percent: 15 } ];
  renderTiers(tiers);
}

function addTier() {
  const tiersDiv = document.getElementById('tiers');
  const i = tiersDiv.children.length;
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `Min <input data-i="${i}" data-k="min" type="number" value="0"> Max <input data-i="${i}" data-k="max" type="number" value="0"> % <input data-i="${i}" data-k="percent" type="number" value="0">`;
  tiersDiv.appendChild(row);
}

async function saveSettings() {
  const min_kes = Number(document.getElementById('sMinKes').value);
  const max_kes = Number(document.getElementById('sMaxKes').value);
  const mode = document.getElementById('sApprovalMode').value;
  const tierInputs = Array.from(document.querySelectorAll('#tiers input'));
  const grouped = [];
  for (let i = 0; i < tierInputs.length; i += 3) {
    const min = Number(tierInputs[i].value);
    const max = Number(tierInputs[i+1].value);
    const percent = Number(tierInputs[i+2].value);
    if (min && max && percent) grouped.push({ min, max, percent });
  }
  const r1 = await fetch(`${API_BASE}/admin/settings/withdrawal`, { method: 'PUT', headers: { 'x-admin-key': ADMIN_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ min_kes, max_kes }) });
  const r2 = await fetch(`${API_BASE}/admin/settings/commissions`, { method: 'PUT', headers: { 'x-admin-key': ADMIN_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ tiers: grouped }) });
  const r3 = await fetch(`${API_BASE}/admin/settings/withdrawalApprovalMode`, { method: 'PUT', headers: { 'x-admin-key': ADMIN_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) });
  if (!r1.ok || !r2.ok || !r3.ok) return alert('Save failed');
  loadSettings();
}

async function runLoyaltyBonus() {
  const res = await fetch(`${API_BASE}/admin/bonuses/run`, { method: 'POST', headers: { 'x-admin-key': ADMIN_KEY } });
  const data = await res.json();
  alert(`Awarded: ${data.awarded}`);
}

async function loadAdminReferrals() {
  const res = await fetch(`${API_BASE}/admin/referrals?limit=200`, { headers: { 'x-admin-key': ADMIN_KEY } });
  const list = await res.json();
  document.getElementById('referralsAdminOut').textContent = JSON.stringify(list, null, 2);
}

async function loadAdminLedgers() {
  const res = await fetch(`${API_BASE}/admin/ledgers?limit=200`, { headers: { 'x-admin-key': ADMIN_KEY } });
  const list = await res.json();
  document.getElementById('ledgersAdminOut').textContent = JSON.stringify(list, null, 2);
}

async function loadAdminAudits() {
  const res = await fetch(`${API_BASE}/admin/audits?limit=200`, { headers: { 'x-admin-key': ADMIN_KEY } });
  const list = await res.json();
  document.getElementById('auditsAdminOut').textContent = JSON.stringify(list, null, 2);
}

// Default view
show('analytics');
loadAnalytics();
