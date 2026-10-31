const $ = (selector) => document.querySelector(selector);

const LABELS = {
  stopped: '未启动',
  starting: '启动中',
  running: '运行中',
  error: '出错',
};

let state = null;

function render(next) {
  if (!next) return;
  state = next;
  const running = next.status === 'running';
  const busy = next.status === 'starting';

  const pill = $('#status-pill');
  pill.textContent = LABELS[next.status] || '未知';
  pill.className = `pill ${next.status}`;

  $('#dot').className = `dot ${next.status}`;
  $('#status-text').textContent =
    next.status === 'error' ? '启动失败' : next.message || LABELS[next.status];
  $('#url').textContent = next.url;
  $('#message').textContent =
    next.status === 'error'
      ? next.message
      : running && !next.owned
        ? '这个服务不是由启动器启动的，停止按钮不可用。'
        : '';

  $('#btn-start').disabled = running || busy;
  $('#btn-stop').disabled = !running || !next.owned;
  $('#btn-open').disabled = !running;
  $('#data-dir').textContent = next.dataDir;

  const log = $('#log');
  log.textContent = (next.logs || []).join('\n');
  log.scrollTop = log.scrollHeight;
}

async function call(action) {
  try {
    const next = await action();
    render(next);
  } catch (err) {
    $('#message').textContent = err.message || String(err);
  }
}

window.launcher.onState(render);
window.launcher.getState().then(render);

$('#btn-start').addEventListener('click', () => call(() => window.launcher.start()));
$('#btn-stop').addEventListener('click', () => call(() => window.launcher.stop()));
$('#btn-open').addEventListener('click', () => call(() => window.launcher.open()));
$('#btn-open-data').addEventListener('click', () => call(() => window.launcher.openData()));
$('#btn-clear-log').addEventListener('click', () => {
  $('#log').textContent = '';
  if (state) state.logs = [];
});
