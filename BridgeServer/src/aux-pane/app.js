let latestPairingUri = '';
let pairingToken = '';

async function refreshStatus() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) throw new Error('status failed');
    const data = await res.json();
    latestPairingUri = data.pairingUri || '';
    pairingToken = data.token || '';
    document.getElementById('bridge-version').textContent = data.version ? `v${data.version}` : '';
    document.getElementById('qr-container').innerHTML = data.qrSvg || '';
    document.getElementById('ts-addr').textContent = data.tailscaleIp
      ? `http://${data.tailscaleIp}:${data.port}`
      : '未检测到 100.x 地址';
    document.getElementById('lan-addr').textContent = data.lanIp
      ? `http://${data.lanIp}:${data.port}`
      : `http://127.0.0.1:${data.port}`;
    document.getElementById('clients-count').textContent = `${data.connectedClients || 0} 台`;
    document.getElementById('engine-status').textContent = data.agentApiReady
      ? 'agentapi 已就绪'
      : '等待环境就绪';
    document.getElementById('status-label').textContent = `监听端口 :${data.port} · 运行正常`;
  } catch {
    document.getElementById('status-label').textContent = '连接状态刷新中…';
  }
}

document.getElementById('copy-uri-btn').addEventListener('click', async () => {
  if (!latestPairingUri) return;
  try {
    await navigator.clipboard.writeText(latestPairingUri);
    const toast = document.getElementById('toast');
    toast.classList.remove('hidden');
    setTimeout(() => toast.classList.add('hidden'), 2000);
  } catch {
    prompt('Copy pairing link to Levity on iPhone / iPad:', latestPairingUri);
  }
});

document.getElementById('rotate-btn').addEventListener('click', async () => {
  const res = await fetch('/api/rotate-token', { method: 'POST' });
  if (res.ok) await refreshStatus();
});

const checkBridge = document.getElementById('check-bridge-btn');
const updateBridge = document.getElementById('update-bridge-btn');
const bridgeFeedback = document.getElementById('bridge-update-feedback');

function showBridgeFeedback(message) {
  bridgeFeedback.textContent = message;
  bridgeFeedback.hidden = false;
}

checkBridge.addEventListener('click', async () => {
  checkBridge.disabled = true;
  updateBridge.hidden = true;
  showBridgeFeedback('正在检查桌面桥接更新…');
  try {
    const res = await fetch('/api/bridge-update-status');
    if (!res.ok) throw new Error('update check failed');
    const status = await res.json();
    if (!status.updateAvailable) {
      showBridgeFeedback('暂未发现更新');
    } else if (!status.canSelfUpdate) {
      showBridgeFeedback('有可用更新，请在电脑端手动更新桥接。');
    } else {
      updateBridge.hidden = false;
      showBridgeFeedback(`有可用更新${status.latestVersion && status.latestVersion !== status.currentVersion ? ` · v${status.latestVersion}` : ''}`);
    }
  } catch {
    showBridgeFeedback('暂时无法检查更新，请稍后再试。');
  } finally {
    checkBridge.disabled = false;
  }
});

updateBridge.addEventListener('click', async () => {
  checkBridge.disabled = true;
  updateBridge.disabled = true;
  showBridgeFeedback('正在更新桌面桥接…');
  try {
    const res = await fetch('/api/bridge-update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: pairingToken }),
    });
    const result = await res.json();
    if (!result.ok) {
      showBridgeFeedback(result.message || '更新未完成，请在电脑端检查桥接。');
    } else {
      updateBridge.hidden = true;
      showBridgeFeedback(result.restarting ? '桌面桥接正在重启…' : '桌面桥接已是最新版本');
    }
  } catch {
    showBridgeFeedback('暂时无法确认更新结果，请重新检查。');
  } finally {
    checkBridge.disabled = false;
    updateBridge.disabled = false;
  }
});

refreshStatus();
setInterval(refreshStatus, 3000);
