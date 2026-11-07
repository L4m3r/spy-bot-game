export function prototypeInviteUrl(baseHref) {
  return new URL('app.html?scenario=invitation', baseHref).href;
}

export function validInvite(value, baseHref) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.username || url.password || url.hash) return false;
  const prototype = new URL(prototypeInviteUrl(baseHref));
  if (url.origin === prototype.origin && url.pathname === prototype.pathname
    && url.searchParams.get('scenario') === 'invitation') return true;
  return url.protocol === 'https:' && url.hostname === 't.me' && !url.port
    && /^\/[A-Za-z0-9_]+$/.test(url.pathname)
    && /^room_[a-f0-9]{24}$/.test(url.searchParams.get('start') || '');
}

export function roomFromInvite(value, botUsername) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 't.me' || url.port || url.username || url.password || url.hash
      || url.pathname.toLowerCase() !== '/' + botUsername.toLowerCase()) return null;
    const match = /^room_([a-f0-9]{24})$/.exec(url.searchParams.get('start') || url.searchParams.get('startapp') || '');
    return match?.[1] ?? null;
  } catch { return null; }
}
