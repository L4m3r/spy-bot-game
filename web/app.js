// Shared Telegram Mini App UI. Demo fixtures are enabled only by the local preview server.
import { prototypeInviteUrl, validInvite, roomFromInvite } from './invites.js';
import { api, actionRequest, setServerTime } from './api.js';
const telegram = window.Telegram?.WebApp;
const root = document.documentElement;
const view = document.querySelector('#view');
const back = document.querySelector('#back');
const bar = document.querySelector('#action-bar');
const mainAction = document.querySelector('#main-action');
const announcement = document.querySelector('#announcement');
const params = new URLSearchParams(location.search);
const previewHost = __SPY_PREVIEW__ && parent !== window && params.get('host') === 'preview';
root.toggleAttribute('data-preview-host', previewHost);
const systemDark = matchMedia('(prefers-color-scheme: dark)');
let me = __SPY_PREVIEW__ ? { id: 1, name: 'Ты', tone: 0 } : { id: 0, name: '', tone: 0 };
const friends = __SPY_PREVIEW__ ? [
  { id: 2, name: 'Анна', tone: 1 }, { id: 3, name: 'Миша', tone: 2 },
  { id: 4, name: 'Кира', tone: 3 }, { id: 5, name: 'Саша', tone: 0 },
  { id: 6, name: 'Денис', tone: 1 }, { id: 7, name: 'Алиса', tone: 2 },
  { id: 8, name: 'Максим', tone: 3 }, { id: 9, name: 'Никита', tone: 0 },
  { id: 10, name: 'Соня', tone: 1 }, { id: 11, name: 'Ваня', tone: 2 },
  { id: 12, name: 'Настя', tone: 3 },
] : [];
let locations = [
  'Больница', 'Школа', 'Аэропорт', 'Ресторан', 'Отель', 'Банк',
  'Космическая станция', 'Подводная лодка', 'Пиратский корабль', 'Цирк',
  'Театр', 'Киностудия', 'Музей', 'Зоопарк', 'Пляж', 'Горнолыжный курорт',
  'Полицейский участок', 'Пожарная станция', 'Супермаркет', 'Поезд',
  'Университет', 'Библиотека', 'Ферма', 'Завод',
];
const state = {
  screen: 'home', trail: [], room: false, owner: true, players: [me],
  round: 0, inRound: true, spy: false, location: null, revealed: false,
  roomCode: null, ownerId: null, ownerName: '', botUsername: '', invitation: null, privateCard: null, error: '', ready: __SPY_PREVIEW__,
  botDeliveryFailed: false, joinValue: '', joinError: '', theme: params.get('theme') || 'system',
};
let primary = null;
let pending = false;
let generation = 0;
let dialogResolve = null;
let nativeAction = false;
let noticeTimer;
let roleFocusPending = false;
let roleRequest = 0;
let roleLoading = false;
let refreshVersion = 0;
let pollTimer;
let starting = false;

function escape(value) { return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
function icon(name, extra = '') { return `<svg class="icon ${extra}" aria-hidden="true"><use href="#${name}"/></svg>`; }
function buttonRow(action, name, symbol, options = {}) {
  return `<button class="row ${options.blue ? 'blue' : ''} ${options.danger ? 'danger' : ''}" type="button" data-action="${action}">${icon(symbol)}<span>${name}${options.description ? `<small class="row-description">${options.description}</small>` : ''}</span>${options.end ? `<span class="row-end">${options.end}</span>` : options.chevron === false ? '' : icon('chevron', 'chevron')}</button>`;
}
function avatar(player) { return `<span class="avatar" data-tone="${player.tone}" aria-hidden="true">${escape(player.name[0] || '?')}</span>`; }
function playerCount(count) { return `${count} ${count % 100 >= 11 && count % 100 <= 14 ? 'игроков' : count % 10 === 1 ? 'игрок' : count % 10 >= 2 && count % 10 <= 4 ? 'игрока' : 'игроков'}`; }
function hero(title, copy, symbol = 'mask') { return `<header class="hero"><span class="app-avatar" aria-hidden="true">${icon(symbol)}</span><h1 tabindex="-1">${title}</h1><p>${copy}</p></header>`; }
function title(name, copy = '') { return `<header class="screen-title"><h1 tabindex="-1">${name}</h1>${copy ? `<p>${copy}</p>` : ''}</header>`; }
function section(name, content, note = '', count = '') { return `<section class="section"><div class="section-heading"><h2>${name}${count ? `<span class="count">${count}</span>` : ''}</h2></div>${content}${note ? `<p class="note">${note}</p>` : ''}</section>`; }
function speak(text) { clearTimeout(noticeTimer); announcement.textContent = text; }
function feedback(text) { speak(text); haptic('success'); }
function haptic(type = 'light') {
  if (!telegram?.initData || !telegram.isVersionAtLeast?.('6.1')) return;
  try {
    if (type === 'success') telegram.HapticFeedback.notificationOccurred('success');
    else telegram.HapticFeedback.impactOccurred('light');
  } catch { /* Optional client feedback. */ }
}

function syncTheme() {
  const fromClient = Boolean(telegram?.initData);
  root.dataset.scheme = fromClient ? telegram.colorScheme : state.theme === 'system' ? systemDark.matches ? 'dark' : 'light' : state.theme;
  if (fromClient) {
    for (const key of ['bg_color', 'secondary_bg_color', 'section_bg_color', 'text_color', 'hint_color', 'subtitle_text_color', 'button_color', 'button_text_color', 'link_color', 'accent_text_color', 'section_separator_color', 'destructive_text_color']) {
      const color = telegram.themeParams?.[key];
      const property = '--tg-theme-' + key.replaceAll('_', '-');
      if (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)) root.style.setProperty(property, color);
      else root.style.removeProperty(property);
    }
    try { telegram.setHeaderColor('secondary_bg_color'); telegram.setBackgroundColor(telegram.themeParams.secondary_bg_color); } catch { /* Old clients retain CSS colors. */ }
  }
}
syncTheme();
systemDark.addEventListener('change', syncTheme);
telegram?.onEvent?.('themeChanged', syncTheme);

function setPrimary(label, action, enabled = true) {
  primary = action;
  const visible = Boolean(label);
  root.toggleAttribute('data-action', visible);
  mainAction.textContent = pending ? 'Подождите…' : label || '';
  mainAction.disabled = pending || !enabled;
  if (telegram?.initData && telegram.MainButton && telegram.isVersionAtLeast?.('6.1')) {
    try {
      if (!visible) telegram.MainButton.hide();
      else telegram.MainButton.setParams({ text: mainAction.textContent, is_visible: true, is_active: enabled && !pending });
      nativeAction = true;
    } catch { nativeAction = false; }
  }
  root.toggleAttribute('data-native-action', nativeAction && visible);
  bar.hidden = !visible || nativeAction;
}

function playersList() {
  const ownerId = __SPY_PREVIEW__ ? state.owner ? me.id : 2 : state.ownerId;
  return `<ul class="group players" aria-label="Участники комнаты">${state.players.map(player => `<li>${avatar(player)}<div class="player-copy"><strong>${player.id === me.id ? 'Ты' : escape(player.name)}</strong>${player.id === ownerId ? '<small>Организатор</small>' : state.round && (__SPY_PREVIEW__ ? player.id === me.id && !state.inRound : !player.inRound) ? '<small>Со следующего раунда</small>' : ''}</div>${player.id === me.id ? '<span class="member-tag">Это ты</span>' : ''}</li>`).join('')}</ul>`;
}
function home() {
  setPrimary(null);
  return hero('Шпион', 'Все знают место. Кроме одного.<br>Узнай, кто играет не свою роль.')
    + (state.room ? section('Твоя игра', `<div class="group">${buttonRow('open-room', 'Вернуться в комнату', 'people', { description: `${playerCount(state.players.length)}${state.round ? ' · Раунд ' + state.round : ' · Собираемся'}` })}</div>`) : '')
    + `<div class="group ${state.room ? 'section' : ''}">${state.room ? '' : buttonRow('create', 'Создать игру', 'plus', { blue: true, chevron: false })}${buttonRow('join', 'У меня есть приглашение', 'link')}</div>`
    + '<p class="note">3–12 игроков · один шпион · играете голосом</p>'
    + section('Перед игрой', `<div class="group">${buttonRow('rules', 'Как играть', 'info')}${buttonRow('locations', 'Возможные локации', 'pin', { end: '24' })}</div>`, 'Достаточно одного телефона на каждого игрока. Бота не нужно добавлять в общий чат.');
}
function room() {
  const ready = state.players.length >= 3;
  const full = state.players.length >= 12;
  setPrimary(state.owner ? state.round ? 'К раунду ' + state.round : 'Раздать карточки' : state.round ? state.inRound ? 'К моей карточке' : 'Открыть раунд' : null, state.round ? 'round' : 'deal', state.round || ready);
  const status = state.round
    ? `<div class="status-card">${icon(state.inRound ? 'card' : 'people')}<div><h2>${state.inRound ? 'Раунд ' + state.round + ' идёт' : 'Ты в следующем раунде'}</h2><p>${state.inRound ? 'Роли назначены. Каждый игрок может открыть свою карточку.' : 'Эта раздача уже началась. Пока присоединяйся к разговору.'}</p></div></div>`
    : `<div class="status-card">${icon('people')}<div><h2>${ready ? state.owner ? 'Все готовы к игре?' : 'Ждём организатора' : 'Собираем компанию'}</h2><p>${ready ? state.owner ? 'Когда все соберутся, раздай карточки. Опоздавшие сыграют со следующего раунда.' : `Карточки раздаст ${escape(__SPY_PREVIEW__ ? 'Анна' : state.ownerName)}, когда все будут готовы.` : state.players.length === 1 ? 'Пригласи ещё хотя бы двух друзей, чтобы начать.' : 'Нужен ещё один игрок, чтобы начать.'}</p></div></div>`;
  return `<header class="room-head"><span class="room-mark" aria-hidden="true">${icon('mask')}</span><div><h1 tabindex="-1">Комната «Шпион»</h1><p>${state.owner ? 'Ты — организатор' : 'Организатор — ' + escape(__SPY_PREVIEW__ ? 'Анна' : state.ownerName)}</p></div></header>`
    + status
    + `<div class="group section">${full ? `<button class="row muted" type="button" disabled>${icon('people')}<span>Комната заполнена</span></button>` : buttonRow('invite', 'Пригласить друзей', 'plus', { blue: true, chevron: false })}</div>`
    + `<p class="note">${full ? 'В комнате максимум 12 игроков. Пригласить ещё можно, когда освободится место.' : 'Можно присоединиться по ссылке, без поиска комнаты.'}</p>`
    + `<section class="section"><div class="section-heading"><h2>Игроки <span class="count">${state.players.length} / 12</span></h2><button class="icon-button" data-action="refresh" type="button" aria-label="Обновить состав">${icon('refresh')}</button></div>${playersList()}</section>`
    + botDeliveryNote()
    + `<div class="group section">${buttonRow('locations', 'Возможные локации', 'pin', { end: '24' })}${buttonRow(state.owner ? 'close' : 'leave', state.owner ? 'Закрыть комнату' : 'Выйти из комнаты', 'exit', { danger: true, chevron: false })}</div>`
    + (!state.owner && !state.round ? `<p class="note">Карточки раздаст ${escape(__SPY_PREVIEW__ ? 'Анна' : state.ownerName)}, когда все соберутся.</p>` : '');
}
function botDeliveryNote() {
  return state.botDeliveryFailed && state.inRound ? '<p class="note bot-delivery-note">Не все сообщения от бота доставлены. Карточки доступны здесь, в Mini App.</p>' : '';
}
function roleContents() {
  const spy = __SPY_PREVIEW__ ? state.spy : state.privateCard?.role === 'spy';
  const place = __SPY_PREVIEW__ ? locations[state.location] : state.privateCard?.location;
  if (!state.inRound) return `<div class="role-symbol" aria-hidden="true">${icon('people')}</div><h2>Твой раунд впереди</h2><p>Ты присоединился после раздачи. Карточка появится, когда организатор начнёт следующий раунд.</p>`;
  if (!state.revealed) return `<div class="role-symbol" aria-hidden="true">${icon('lock')}</div><h2>Твоя карточка</h2><p>Посмотри её так, чтобы другие игроки не увидели экран.</p><button class="primary" data-action="reveal" type="button"${roleLoading ? ' disabled' : ''}>${icon('eye')}${roleLoading ? 'Открываем…' : 'Открыть карточку'}</button>`;
  return `<div class="role-symbol" aria-hidden="true">${icon(spy ? 'mask' : 'pin')}</div><p class="role-eyebrow">${spy ? 'Твоя роль' : 'Локация этого раунда'}</p><h2 id="role-title" tabindex="-1" aria-label="${spy ? 'Твоя роль. Ты — шпион' : 'Локация этого раунда. ' + escape(place)}" aria-describedby="role-description">${spy ? 'Ты — шпион' : escape(place)}</h2><p id="role-description">${spy ? 'Выясни, где находятся остальные.<br>Слушай ответы и не выдавай себя.' : 'Ты не шпион. Найди того, кто не знает это место, не называя его вслух.'}</p><button class="text-button" data-action="hide" type="button">Скрыть карточку</button>`;
}
function round() {
  setPrimary(null);
  return title('Раунд ' + state.round, state.inRound ? 'Вопросы, догадки и обвинения — голосом.' : 'Наблюдай за игрой и дождись новой раздачи.')
    + `<section id="role-card" class="group role-card ${state.revealed ? 'is-open role-enter' : ''} ${state.revealed && (__SPY_PREVIEW__ ? state.spy : state.privateCard?.role === 'spy') ? 'role-spy' : ''}" aria-label="Личная карточка">${roleContents()}</section>`
    + `<p class="quiet-note">${icon('lock')}<span>Карточка скрывается при уходе с экрана.</span></p>`
    + botDeliveryNote()
    + `<div class="group section">${buttonRow('locations', 'Возможные локации', 'pin', { end: '24' })}${buttonRow('lobby', 'Игроки в комнате', 'people', { end: state.players.length })}</div>`
    + (state.owner ? `<div class="group section">${buttonRow('next', 'Следующий раунд', 'refresh', { blue: true })}</div><p class="note">Начинай, когда закончите обсуждение. Текущие карточки заменятся новыми.</p>` : '<p class="note">Следующий раунд начнёт организатор.</p>');
}
function locationScreen() {
  setPrimary(null);
  return title('Возможные локации', 'Одинаковый список для всех игроков. Здесь нет подсказки к текущему раунду.')
    + `<div class="field search">${icon('search')}<input id="location-search" type="search" placeholder="Поиск локации" aria-label="Поиск локации" autocomplete="off"><button id="clear-search" class="icon-button" type="button" aria-label="Очистить поиск" hidden>${icon('close')}</button></div>`
    + '<div class="section-heading"><h2>Все локации <span class="count" id="location-count">24</span></h2></div>'
    + `<ul id="location-list" class="group location-list">${locations.map(name => `<li>${icon('pin')}<span>${name}</span></li>`).join('')}</ul><p id="search-empty" class="empty-result" hidden>Ничего не нашлось.<br>Попробуй другое название.</p>`;
}
function rules() {
  setPrimary('Понятно', 'back');
  return title('Как играть', 'Все в одном месте. Один — не в курсе.')
    + `<ol class="group rule-list">${[
      ['Соберитесь', 'От 3 до 12 человек. Организатор создаёт комнату и делится приглашением.'],
      ['Посмотрите карточки', 'Один случайный игрок — шпион. Остальные видят одну общую локацию. Не показывайте экран соседям.'],
      ['Задавайте вопросы', 'Говорите по очереди и отвечайте так, чтобы узнать шпиона, но не раскрыть ему локацию.'],
      ['Обсудите догадки', 'Решите голосом, кто шпион. Шпион может попробовать назвать локацию. Когда закончите, начинайте новый раунд.'],
    ].map(([name, text], i) => `<li><span class="step-number" aria-hidden="true">${i + 1}</span><div><h2>${name}</h2><p>${text}</p></div></li>`).join('')}</ol>`
    + '<p class="note">Договоритесь о темпе игры и решайте голосом, кто победил. Организатор начнёт следующий раунд, когда все будут готовы.</p>';
}
function joinForm() {
  setPrimary('Открыть приглашение', 'resolve-invite');
  return title('Присоединиться', 'Попроси организатора прислать приглашение в игру.')
    + `<form id="join-form" novalidate><label class="field-label" for="invite-input">Ссылка-приглашение</label><div class="field"><input id="invite-input" type="url" value="${escape(state.joinValue)}" placeholder="Вставь ссылку из бота" autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="join-hint" aria-invalid="${Boolean(state.joinError)}"></div><p id="join-hint" class="note ${state.joinError ? 'error' : ''}" role="status">${state.joinError ? escape(state.joinError) : 'Только приглашение определяет комнату. Ничего искать вручную не нужно.'}</p></form>`;
}
function invitation() {
  const invite = __SPY_PREVIEW__ ? { ownerName: 'Анна', players: friends.slice(0, 3), full: false } : state.invitation;
  const same = !__SPY_PREVIEW__ && state.roomCode === invite.code;
  const another = !__SPY_PREVIEW__ && state.room && !same;
  setPrimary(same || another ? 'Вернуться в свою комнату' : invite.full ? 'Комната заполнена' : 'Присоединиться к игре', same || another ? 'open-room' : 'accept-invite', same || another || !invite.full);
  return title('Тебя пригласили') + `<div class="group invite-card"><div class="avatar-stack" aria-hidden="true">${invite.players.slice(0, 3).map((player, i) => avatar({ ...player, tone: i + 1 })).join('')}</div><h2>${__SPY_PREVIEW__ ? 'В компанию к Анне' : 'Организатор — ' + escape(invite.ownerName)}</h2><p>${playerCount(invite.players.length)} · от 3 до 12 в комнате</p></div>`
    + (!__SPY_PREVIEW__ && invite.round ? '<p class="note">Раунд уже идёт. После вступления ты сможешь играть со следующего раунда.</p>' : '')
    + (another ? '<p class="note">Ты уже в другой игре. Сначала выйди из своей комнаты или закрой её, если ты организатор.</p>' : section('Что дальше', `<div class="group"><div class="row">${icon('people')}<span>Появишься в списке игроков</span></div><div class="row">${icon('card')}<span>Получишь личную карточку</span></div><div class="row">${icon('chat')}<span>Будете играть голосом</span></div></div>`, 'Роль и локация откроются только тебе.'));
}
function inviteFriends() {
  setPrimary(null);
  return title('Пригласить друзей', 'Отправь ссылку тем, с кем хочешь сыграть.')
    + `<div class="group invite-card"><span class="room-mark" style="margin:0 auto 16px" aria-hidden="true">${icon('link')}</span><h2>Одна ссылка на всю компанию</h2><p>Друзья откроют приглашение<br>и присоединятся к этой комнате.</p><div class="invite-url">${__SPY_PREVIEW__ ? 'Приглашение в комнату «Шпион»' : escape(`https://t.me/${state.botUsername}?start=room_${state.roomCode}`)}</div><button class="primary" data-action="copy-invite" type="button">${icon('copy')}<span id="copy-invite-label">Скопировать приглашение</span></button><p id="copy-status" role="status" hidden></p></div>`
    + '<p class="note">Новые игроки могут войти и после раздачи. Их карточки появятся со следующего раунда.</p>';
}
function closed() {
  setPrimary(state.room ? 'Вернуться в свою комнату' : 'Создать новую игру', state.room ? 'open-room' : 'create');
  return `<section class="closed"><span class="app-avatar" aria-hidden="true">${icon('mask')}</span><h1 tabindex="-1">Комната закрыта</h1><p>Это приглашение больше не работает. Можно собрать компанию в новой комнате.</p></section>`;
}
const screens = { home, lobby: room, round, locations: locationScreen, rules, join: joinForm, invitation, invite: inviteFriends, closed };
screens.loading = () => { setPrimary(null); return hero('Шпион', 'Загружаем твою игру…') + '<div class="group loading-placeholder" aria-busy="true" aria-label="Загрузка комнаты"></div>'; };
screens.unavailable = () => { setPrimary(telegram?.initData ? 'Попробовать снова' : null, 'reload'); return hero(telegram?.initData ? 'Не удалось загрузить игру' : 'Открой игру в Telegram', telegram?.initData ? 'Проверь подключение и попробуй ещё раз.' : 'Запусти Mini App из личного чата с ботом.'); };
function render({ focus = true, animate = false } = {}) {
  view.classList.remove('view-enter');
  view.innerHTML = (state.error ? `<p class="note error" role="alert">${escape(state.error)}</p>` : '') + screens[state.screen]();
  if (pending) view.querySelectorAll('button[data-action]').forEach(button => { button.disabled = true; });
  const canGoBack = state.screen !== 'home' && (__SPY_PREVIEW__ || state.ready);
  back.hidden = !canGoBack;
  if (telegram?.initData && telegram.BackButton && telegram.isVersionAtLeast?.('6.1')) {
    try { telegram.BackButton[canGoBack ? 'show' : 'hide'](); back.hidden = true; } catch { /* HTML back control remains. */ }
  }
  document.title = (state.screen === 'round' ? 'Раунд ' + state.round : { home: 'Шпион', lobby: 'Комната', locations: 'Локации', rules: 'Как играть', join: 'Приглашение', invitation: 'Тебя пригласили', invite: 'Пригласить друзей', closed: 'Комната закрыта', loading: 'Загрузка', unavailable: 'Открой в Telegram' }[state.screen]) + ' · Шпион';
  if (animate) { void view.offsetWidth; view.classList.add('view-enter'); }
  if (focus) view.querySelector('h1')?.focus({ preventScroll: true });
  bindScreen();
  if (__SPY_PREVIEW__ && parent !== window) parent.postMessage({ type: 'spy:state', screen: state.screen, players: state.players.length, round: state.round, owner: state.owner, spy: state.spy, inRound: state.inRound, botDeliveryFailed: state.botDeliveryFailed }, location.origin);
}
function go(screen, { replace = false } = {}) {
  generation++; pending = false; conceal(false); speak('');
  if (screen === 'home') state.trail = [];
  else if (screen === 'lobby') state.trail = ['home'];
  else if (screen === 'round') state.trail = ['home', 'lobby'];
  else if (!replace) state.trail.push(state.screen);
  state.screen = screen;
  scrollTo(0, 0); render({ animate: true });
}
function goBack() {
  conceal(false); pending = false; generation++; speak('');
  state.screen = state.trail.pop() || (state.room ? 'lobby' : 'home');
  scrollTo(0, 0); render({ animate: true });
}
function conceal(update = true) {
  roleRequest++; roleLoading = false; state.privateCard = null;
  state.revealed = false;
  if (!update) roleFocusPending = false;
  if (update && state.screen === 'round') {
    const card = document.querySelector('#role-card');
    if (card) {
      roleFocusPending ||= card.contains(document.activeElement);
      card.className = 'group role-card'; card.innerHTML = roleContents();
      restoreRoleFocus();
    }
  }
}
function restoreRoleFocus() {
  if (!roleFocusPending || state.screen !== 'round' || document.hidden || !document.hasFocus()) return;
  roleFocusPending = false;
  document.querySelector('#role-card [data-action="reveal"]')?.focus({ preventScroll: true });
}
function bindScreen() {
  const search = document.querySelector('#location-search');
  const clear = document.querySelector('#clear-search');
  if (search) {
    const filter = () => {
      const query = search.value.trim().toLocaleLowerCase('ru');
      let total = 0;
      document.querySelectorAll('#location-list li').forEach(row => { row.hidden = !row.textContent.toLocaleLowerCase('ru').includes(query); if (!row.hidden) total++; });
      document.querySelector('#location-count').textContent = String(total);
      document.querySelector('#search-empty').hidden = total > 0;
      document.querySelector('#location-list').hidden = total === 0;
      clear.hidden = !search.value;
      speak(total ? (query ? 'Найдено локаций: ' : 'Все локации: ') + total + '.' : 'Ничего не нашлось. Попробуй другое название.');
    };
    search.addEventListener('input', filter);
    clear.addEventListener('click', () => { search.value = ''; filter(); search.focus(); });
  }
  const form = document.querySelector('#join-form');
  if (form) {
    const input = document.querySelector('#invite-input');
    input.addEventListener('input', () => {
      state.joinValue = input.value; state.joinError = '';
      input.setAttribute('aria-invalid', 'false');
      const hint = document.querySelector('#join-hint'); hint.classList.remove('error'); hint.textContent = 'Вставь приглашение, которое прислал организатор.';
    });
    form.addEventListener('submit', event => { event.preventDefault(); dispatch('resolve-invite'); });
  }
}
async function confirm(title, text, actionLabel, destructive = false) {
  conceal();
  if (telegram?.initData && telegram.showPopup && telegram.isVersionAtLeast?.('6.2')) {
    try { return await new Promise(resolve => telegram.showPopup({ title, message: text, buttons: [{ id: 'cancel', type: 'cancel' }, { id: 'yes', type: destructive ? 'destructive' : 'default', text: actionLabel }] }, id => resolve(id === 'yes'))); } catch { /* Use accessible HTML dialog. */ }
  }
  const dialog = document.querySelector('#confirmation');
  if (dialog.open) return false;
  const previous = document.activeElement;
  document.querySelector('#dialog-title').textContent = title;
  document.querySelector('#dialog-copy').textContent = text;
  const yes = document.querySelector('#dialog-confirm'); yes.textContent = actionLabel; yes.classList.toggle('danger', destructive);
  dialog.showModal(); document.querySelector('#dialog-cancel').focus();
  const result = await new Promise(resolve => { dialogResolve = resolve; });
  dialog.close(); if (previous?.isConnected) previous.focus({ preventScroll: true });
  return result;
}
function closeDialog(yes) { if (dialogResolve) { const resolve = dialogResolve; dialogResolve = null; resolve(yes); } }
document.querySelector('#dialog-cancel').addEventListener('click', () => closeDialog(false));
document.querySelector('#dialog-confirm').addEventListener('click', () => closeDialog(true));
document.querySelector('#confirmation').addEventListener('cancel', event => { event.preventDefault(); closeDialog(false); });

async function dispatch(action) {
  if (pending && action !== 'back') return;
  if (!__SPY_PREVIEW__) return liveDispatch(action);
  if (action === 'back') return goBack();
  if (['home', 'lobby', 'locations', 'rules', 'join', 'invite', 'round'].includes(action)) return go(action);
  if (action === 'open-room') return go(state.round ? 'round' : 'lobby');
  if (action === 'create') {
    if (state.room) return go(state.round ? 'round' : 'lobby');
    Object.assign(state, { room: true, owner: true, players: [me], round: 0, location: null, revealed: false, inRound: true, botDeliveryFailed: false });
    return go('lobby');
  }
  if (action === 'resolve-invite') {
    state.joinValue = document.querySelector('#invite-input').value.trim();
    if (!validInvite(state.joinValue, location.href)) {
      state.joinError = state.joinValue ? 'Нужна ссылка-приглашение из бота. Проверь, что она скопирована целиком.' : 'Вставь ссылку-приглашение.';
      render({ focus: false }); document.querySelector('#invite-input').focus(); return;
    }
    return go('invitation');
  }
  if (action === 'accept-invite') {
    Object.assign(state, { room: true, owner: false, players: [...friends.slice(0, 3), me], round: 0, inRound: true, location: null, botDeliveryFailed: false, spy: false, revealed: false });
    state.trail = ['home']; return go('lobby', { replace: true });
  }
  if (action === 'deal' || action === 'next') {
    if (!state.owner || state.players.length < 3) return;
    if (state.round && !await confirm('Начать следующий раунд?', 'Текущие карточки перестанут действовать. Все участники получат новые роли.', 'Новый раунд')) return;
    const version = generation;
    pending = true; render({ focus: false });
    await new Promise(resolve => setTimeout(resolve, 450));
    if (generation !== version) return;
    pending = false;
    state.round++; state.location = (state.location === null ? 1 : state.location + 5) % locations.length;
    state.spy = false; state.inRound = true; state.botDeliveryFailed = false;
    state.trail = ['home', 'lobby']; go('round', { replace: true }); feedback('Карточки розданы. Раунд ' + state.round + '.'); return;
  }
  if (action === 'reveal' || action === 'hide') {
    if (!state.inRound) return;
    state.revealed = action === 'reveal';
    const card = document.querySelector('#role-card');
    card.className = `group role-card ${state.revealed ? 'is-open role-enter' : ''} ${state.revealed && (__SPY_PREVIEW__ ? state.spy : state.privateCard?.role === 'spy') ? 'role-spy' : ''}`;
    card.innerHTML = roleContents();
    card.querySelector(state.revealed ? '#role-title' : 'button')?.focus({ preventScroll: true }); haptic();
    speak(state.revealed ? '' : 'Карточка скрыта.'); return;
  }
  if (action === 'close' || action === 'leave') {
    const ok = await confirm(action === 'close' ? 'Закрыть комнату?' : 'Выйти из комнаты?', action === 'close' ? 'Все участники потеряют доступ к этой комнате. Чтобы сыграть снова, нужно будет создать новую.' : 'Ты исчезнешь из списка игроков. Вернуться можно по приглашению.', action === 'close' ? 'Закрыть' : 'Выйти', true);
    if (!ok) return;
    state.room = false; state.round = 0; state.players = [me]; state.location = null; state.trail = [];
    go('home', { replace: true }); feedback(action === 'close' ? 'Комната закрыта.' : 'Ты вышел из комнаты.'); return;
  }
  if (action === 'refresh') {
    const target = document.querySelector('[data-action="refresh"]'); target?.classList.add('is-loading');
    await new Promise(resolve => setTimeout(resolve, 500)); target?.classList.remove('is-loading'); feedback('Состав комнаты обновлён.'); return;
  }
  if (action === 'copy-invite') {
    const link = __SPY_PREVIEW__ ? prototypeInviteUrl(location.href) : `https://t.me/${state.botUsername}?start=room_${state.roomCode}`;
    const label = document.querySelector('#copy-invite-label');
    try { await navigator.clipboard.writeText(link); label.textContent = 'Приглашение скопировано'; feedback('Приглашение скопировано.'); }
    catch { const status = document.querySelector('#copy-status'); status.hidden = false; status.className = 'error'; status.textContent = 'Буфер недоступен. Выдели и скопируй ссылку ниже.'; const field = document.querySelector('input.invite-url') || document.createElement('input'); field.value = link; field.readOnly = true; field.setAttribute('aria-label', 'Ссылка-приглашение'); field.className = 'invite-url'; status.after(field); field.focus(); field.select(); }
    return;
  }
}
view.addEventListener('click', event => { const button = event.target.closest('button[data-action]'); if (button) void dispatch(button.dataset.action); });
back.addEventListener('click', goBack);
mainAction.addEventListener('click', () => { if (!mainAction.disabled && primary) void dispatch(primary); });
if (telegram?.initData) {
  try { telegram.ready(); telegram.expand(); telegram.BackButton?.onClick(goBack); telegram.MainButton?.onClick(() => { if (!pending && primary && !mainAction.disabled) void dispatch(primary); }); } catch { /* Browser prototype remains available. */ }
  if (telegram.isVersionAtLeast?.('8.0')) {
    telegram.onEvent('deactivated', () => conceal());
    telegram.onEvent('activated', restoreRoleFocus);
  }
}
document.addEventListener('visibilitychange', () => { if (document.hidden) conceal(); else restoreRoleFocus(); });
window.addEventListener('pagehide', () => conceal());
window.addEventListener('blur', () => conceal());
window.addEventListener('focus', restoreRoleFocus);

function applyRoom(room) {
  const oldCode = state.roomCode;
  const oldRound = state.round;
  state.room = !!room;
  state.roomCode = room?.code ?? null;
  state.ownerId = room?.ownerId ?? null;
  state.owner = room?.ownerId === me.id;
  state.players = room ? room.players.map((player, i) => ({ ...player, tone: i % 4 })) : [me];
  state.ownerName = room?.players.find(player => player.id === room.ownerId)?.name ?? '';
  state.round = room?.round ?? 0;
  state.inRound = !!room?.players.find(player => player.id === me.id)?.inRound;
  state.botDeliveryFailed = room?.botDeliveryFailed ?? false;
  if (oldCode !== state.roomCode || oldRound !== state.round || !state.inRound) conceal(false);
  if (!room && ['lobby', 'round', 'invite'].includes(state.screen)) { state.screen = 'closed'; state.trail = ['home']; }
}

function schedulePoll() {
  clearTimeout(pollTimer);
  if (__SPY_PREVIEW__ || document.hidden || !state.ready) return;
  pollTimer = setTimeout(() => { void refreshLive(); }, state.room ? 5000 : 15000);
}

async function refreshLive({ force = false } = {}) {
  if (pending || document.hidden || starting) { schedulePoll(); return; }
  const version = ++refreshVersion;
  try {
    const data = await api('state');
    if (version !== refreshVersion) return;
    setServerTime(data.serverTime);
    me = { ...data.user, tone: 0 }; state.botUsername = data.botUsername; locations = data.locations;
    const previous = JSON.stringify([state.roomCode, state.round, state.players, state.botDeliveryFailed]);
    applyRoom(data.room);
    const changed = previous !== JSON.stringify([state.roomCode, state.round, state.players, state.botDeliveryFailed]);
    if ((changed || force) && ['home', 'lobby', 'round', 'closed'].includes(state.screen)) render({ focus: false });
  } catch (error) {
    if (force || error.status === 401) {
      conceal(false); state.error = error.message;
      if (error.status === 401) { state.ready = false; state.screen = 'unavailable'; }
      render({ focus: false });
    }
  } finally { if (version === refreshVersion) schedulePoll(); }
}

async function startLive() {
  if (starting) return;
  starting = true; state.screen = 'loading'; state.error = ''; render();
  try {
    const data = await api('state');
    me = { ...data.user, tone: 0 }; locations = data.locations; state.botUsername = data.botUsername;
    setServerTime(data.serverTime); applyRoom(data.room); state.ready = true;
    const start = new URLSearchParams(telegram.initData).get('start_param') ?? '';
    const code = params.get('room') || /^room_([a-f0-9]{24})$/.exec(start)?.[1];
    if (code && /^[a-f0-9]{24}$/.test(code) && code !== state.roomCode) {
      try {
        state.invitation = (await api('invitation?code=' + code)).invitation;
        go('invitation');
      } catch (error) { state.error = error.message; go('closed'); }
    } else go(state.room ? state.round ? 'round' : 'lobby' : 'home');
  } catch (error) { state.ready = false; state.error = error.message; state.screen = 'unavailable'; render(); }
  finally { starting = false; schedulePoll(); }
}

async function mutate(action, { code = state.roomCode, round = state.round } = {}) {
  pending = true; refreshVersion++; clearTimeout(pollTimer); state.error = ''; render({ focus: false });
  try {
    const result = await api('action', actionRequest(action, code, round));
    applyRoom(result.room);
    return result;
  } finally { pending = false; refreshVersion++; schedulePoll(); }
}

async function liveDispatch(action) {
  state.error = '';
  try {
    if (action === 'back') return goBack();
    if (['home', 'lobby', 'locations', 'rules', 'join', 'invite', 'round'].includes(action)) return go(action);
    if (action === 'open-room') return go(state.round ? 'round' : 'lobby');
    if (action === 'copy-invite') {
      const link = `https://t.me/${state.botUsername}?start=room_${state.roomCode}`;
      try {
        await navigator.clipboard.writeText(link);
        document.querySelector('#copy-invite-label').textContent = 'Приглашение скопировано'; feedback('Приглашение скопировано.');
      } catch {
        const status = document.querySelector('#copy-status'); status.hidden = false; status.textContent = 'Выдели и скопируй ссылку ниже.';
        const field = document.querySelector('input.invite-url') || document.createElement('input');
        field.value = link; field.readOnly = true; field.className = 'invite-url'; field.setAttribute('aria-label', 'Ссылка-приглашение'); status.after(field); field.focus(); field.select();
      }
      return;
    }
    if (action === 'reload') return startLive();
    if (action === 'refresh') return refreshLive({ force: true });
    if (action === 'resolve-invite') {
      state.joinValue = document.querySelector('#invite-input').value.trim();
      const code = roomFromInvite(state.joinValue, state.botUsername);
      if (!code) {
        state.joinError = 'Вставь полную ссылку-приглашение от этого бота.';
        render({ focus: false }); document.querySelector('#invite-input').focus(); return;
      }
      try { state.invitation = (await api('invitation?code=' + code)).invitation; go('invitation'); }
      catch (error) {
        state.joinError = error.message; render({ focus: false }); document.querySelector('#invite-input').focus();
      }
      return;
    }
    if (action === 'create' || action === 'accept-invite') {
      await mutate(action === 'create' ? 'create' : 'join', action === 'accept-invite' ? { code: state.invitation.code } : {});
      go(state.round ? 'round' : 'lobby'); return;
    }
    if (action === 'deal' || action === 'next') {
      const target = { code: state.roomCode, round: state.round };
      if (target.round && !await confirm('Начать следующий раунд?', 'Текущие карточки перестанут действовать. Все участники получат новые роли.', 'Новый раунд')) return;
      await mutate('deal', target); go('round'); feedback('Роли назначены. Открой свою карточку.'); return;
    }
    if (action === 'close' || action === 'leave') {
      const target = { code: state.roomCode, round: state.round };
      if (!await confirm(action === 'close' ? 'Закрыть комнату?' : 'Выйти из комнаты?', action === 'close' ? 'Все участники потеряют доступ к этой комнате.' : 'Вернуться можно по приглашению. Карточка появится со следующего раунда.', action === 'close' ? 'Закрыть' : 'Выйти', true)) return;
      await mutate(action, target); go('home'); return;
    }
    if (action === 'hide') { conceal(); document.querySelector('#role-card [data-action="reveal"]')?.focus(); return; }
    if (action === 'reveal' && state.inRound && !roleLoading) {
      const version = ++roleRequest;
      const code = state.roomCode; const round = state.round;
      roleLoading = true; document.querySelector('#role-card').innerHTML = roleContents();
      try {
        const { card } = await api(`card?code=${code}&round=${round}`);
        if (version !== roleRequest || state.screen !== 'round' || document.hidden || state.roomCode !== code || state.round !== round) return;
        state.privateCard = card; state.revealed = true; roleLoading = false;
        const element = document.querySelector('#role-card');
        element.className = `group role-card is-open role-enter ${card.role === 'spy' ? 'role-spy' : ''}`;
        element.innerHTML = roleContents(); element.querySelector('#role-title').focus({ preventScroll: true }); haptic();
      } catch (error) { if (version === roleRequest) throw error; }
      finally {
        if (version === roleRequest) {
          roleLoading = false;
          if (!state.revealed && state.screen === 'round') document.querySelector('#role-card').innerHTML = roleContents();
        }
      }
    }
  } catch (error) {
    conceal(false); state.error = error.message; pending = false; render({ focus: false }); speak(error.message);
    if (error.status === 409) void refreshLive({ force: true });
  }
}

if (!__SPY_PREVIEW__) {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearTimeout(pollTimer); refreshVersion++; }
    else if (state.ready) void refreshLive();
  });
  window.addEventListener('online', () => { if (state.ready) void refreshLive({ force: true }); });
}

function scenario(name) {
  generation++; pending = false; roleFocusPending = false; speak('');
  Object.assign(state, { screen: 'home', trail: [], room: false, players: [me], owner: true, round: 0, inRound: true, revealed: false, location: null, spy: false, botDeliveryFailed: false });
  if (['waiting', 'ready', 'guest', 'round', 'spy', 'late', 'delivery'].includes(name)) {
    state.room = true; state.players = name === 'waiting' ? [me] : [me, ...friends.slice(0, 3)]; state.screen = 'lobby'; state.trail = ['home'];
    if (name === 'guest' || name === 'late') state.owner = false;
    if (['round', 'spy', 'late', 'delivery'].includes(name)) { state.screen = 'round'; state.round = 1; state.location = name === 'spy' ? null : 6; state.spy = name === 'spy'; state.inRound = name !== 'late'; state.botDeliveryFailed = name === 'delivery'; state.trail = ['home', 'lobby']; }
  } else if (['invitation', 'closed', 'locations', 'rules', 'join'].includes(name)) { state.screen = name; state.trail = ['home']; }
  scrollTo(0, 0); render();
}
window.addEventListener('message', event => {
  if (!__SPY_PREVIEW__ || event.origin !== location.origin || event.source !== parent || !event.data || typeof event.data !== 'object') return;
  if (event.data.type === 'spy:scenario') scenario(event.data.name);
  if (event.data.type === 'spy:back') goBack();
  if (event.data.type === 'spy:theme' && ['light', 'dark', 'system'].includes(event.data.name)) { state.theme = event.data.name; syncTheme(); }
  if (event.data.type === 'spy:add-player' && state.room && state.players.length < 12) {
    const player = friends.find(player => !state.players.some(member => member.id === player.id));
    if (player) { state.players.push(player); render({ focus: false }); speak(player.name + ' присоединился к комнате.'); }
  }
  if (event.data.type === 'spy:font') root.style.fontSize = event.data.large ? '125%' : '100%';
  if (event.data.type === 'spy:safe') {
    root.style.setProperty('--tg-safe-area-inset-top', event.data.enabled ? '24px' : '0px');
    root.style.setProperty('--tg-content-safe-area-inset-top', event.data.enabled ? '46px' : '0px');
    root.style.setProperty('--tg-safe-area-inset-bottom', event.data.enabled ? '20px' : '0px');
  }
});
if (__SPY_PREVIEW__) scenario(params.get('scenario') || 'home');
else void startLive();
