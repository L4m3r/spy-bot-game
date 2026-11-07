const frame = document.querySelector('iframe');
const preview = document.querySelector('#preview');
const send = (type, value) => frame.contentWindow.postMessage({ type: 'spy:' + type, ...value }, location.origin);
document.querySelector('#host-back').addEventListener('click', () => send('back', {}));
document.querySelectorAll('[data-scenario]').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('[data-scenario]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  send('scenario', { name: button.dataset.scenario });
}));
document.querySelectorAll('[data-theme]').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('[data-theme]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  preview.classList.toggle('is-light', button.dataset.theme === 'light');
  send('theme', { name: button.dataset.theme });
}));
document.querySelector('#small').addEventListener('change', event => preview.classList.toggle('is-small', event.target.checked));
document.querySelector('#large-text').addEventListener('change', event => send('font', { large: event.target.checked }));
document.querySelector('#safe').addEventListener('change', event => send('safe', { enabled: event.target.checked }));
document.querySelector('#add-player').addEventListener('click', () => send('add-player', {}));
window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== frame.contentWindow || event.data?.type !== 'spy:state') return;
  document.querySelector('#add-player').disabled = !['lobby', 'round'].includes(event.data.screen) || event.data.players >= 12;
  const back = document.querySelector('#host-back');
  back.disabled = event.data.screen === 'home';
  back.querySelector('path').setAttribute('d', back.disabled ? 'm6 6 12 12M6 18 18 6' : 'M20 12H4m6-6-6 6 6 6');
  const current = event.data.screen === 'lobby' ? !event.data.owner ? 'guest' : event.data.players < 3 ? 'waiting' : 'ready'
    : event.data.screen === 'round' ? !event.data.inRound ? 'late' : event.data.botDeliveryFailed ? 'delivery' : event.data.spy ? 'spy' : 'round'
    : event.data.screen;
  document.querySelectorAll('[data-scenario]').forEach(item => item.setAttribute('aria-pressed', String(item.dataset.scenario === current)));
  document.querySelector('#current-state').textContent = ({ home: 'Главная', lobby: 'Комната', round: 'Раунд ' + event.data.round, locations: 'Локации', rules: 'Правила', join: 'Вход в игру', invitation: 'Приглашение', invite: 'Поделиться приглашением', closed: 'Комната закрыта' })[event.data.screen] || 'Шпион';
});
