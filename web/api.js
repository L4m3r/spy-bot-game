let sequence = 0;
let clockOffset = 0;
export function setServerTime(time) { clockOffset = time - Date.now(); }
export async function api(path, body) {
  const initData = window.Telegram?.WebApp?.initData;
  if (!initData) throw new Error('Открой приложение из Telegram.');
  const headers = { Authorization: 'tma ' + initData };
  if (body) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetch('/api/miniapp/' + path, {
      method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(15_000),
    });
  } catch { throw new Error('Нет связи с сервером. Проверь интернет и попробуй ещё раз.'); }
  let data;
  try { data = await response.json(); } catch { throw new Error('Сервер временно недоступен. Попробуй ещё раз.'); }
  if (!response.ok) {
    const error = new Error(data.error || 'Не удалось выполнить действие.');
    error.status = response.status;
    throw error;
  }
  return data;
}
export function actionRequest(action, code, expectedRound, membershipVersion, contextVersion) {
  sequence = Math.max(Date.now() + clockOffset, sequence + 1);
  return { action, code, expectedRound, membershipVersion, contextVersion, requestId: sequence + ':' + crypto.randomUUID() };
}
