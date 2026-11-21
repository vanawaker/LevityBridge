let latestPairingUri = '';

async function refreshStatus() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) throw new Error('status failed');
    const data = await res.json();
    latestPairingUri = data.pairingUri || '';
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

refreshStatus();
setInterval(refreshStatus, 3000);
