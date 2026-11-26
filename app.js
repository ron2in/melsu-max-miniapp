const DAYS_RU = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
const MONTHS_RU = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

const STORAGE_KEYS = {
  group: 'melsu_max_group',
  teacher: 'melsu_max_teacher',
};

// Безопасная обёртка над localStorage с фолбэком в память (для строгих WebView)
const memoryStore = {};
const storage = {
  get(key) {
    try {
      return window.localStorage.getItem(key) ?? memoryStore[key] ?? null;
    } catch {
      return memoryStore[key] ?? null;
    }
  },
  set(key, value) {
    memoryStore[key] = value;
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Игнорируем ошибку в режиме инкогнито/ограниченном WebView
    }
  },
};

// Состояние приложения
const state = {
  meta: null,
  group: storage.get(STORAGE_KEYS.group),
  teacher: storage.get(STORAGE_KEYS.teacher),
  activeTab: 'today',
  selectedDate: null,
  groupCache: new Map(),
  teacherCache: new Map(),
  weatherLive: null,
};

// DOM-элементы
const el = {
  groupBtn: document.getElementById('groupBtn'),
  currentGroupLabel: document.getElementById('currentGroupLabel'),
  refreshBtn: document.getElementById('refreshBtn'),
  weatherBar: document.getElementById('weatherBar'),
  weatherText: document.getElementById('weatherText'),
  tabs: document.querySelectorAll('.tab-btn'),
  datePanel: document.getElementById('datePanel'),
  quickDates: document.getElementById('quickDates'),
  customDateInput: document.getElementById('customDateInput'),
  teacherPanel: document.getElementById('teacherPanel'),
  teacherSearchInput: document.getElementById('teacherSearchInput'),
  clearTeacherBtn: document.getElementById('clearTeacherBtn'),
  teacherSuggestions: document.getElementById('teacherSuggestions'),
  selectedTeacherBadge: document.getElementById('selectedTeacherBadge'),
  statusBanner: document.getElementById('statusBanner'),
  scheduleContent: document.getElementById('scheduleContent'),
  updatedAtLabel: document.getElementById('updatedAtLabel'),
  groupModal: document.getElementById('groupModal'),
  closeGroupModalBtn: document.getElementById('closeGroupModalBtn'),
  groupSearchInput: document.getElementById('groupSearchInput'),
  clearGroupSearchBtn: document.getElementById('clearGroupSearchBtn'),
  groupListContainer: document.getElementById('groupListContainer'),
};

// Инициализация SDK (MAX Mini App и Telegram Mini App)
function initPlatformSdk() {
  const tgWa = window.Telegram?.WebApp;
  const maxWa = window.WebApp;
  const wa = tgWa?.initData ? tgWa : maxWa || tgWa;
  if (!wa) return;

  try {
    wa.ready?.();
    wa.expand?.();

    const tp = wa.themeParams;
    if (tp && typeof tp === 'object') {
      const root = document.documentElement.style;
      if (tp.bg_color) root.setProperty('--bg', tp.bg_color);
      if (tp.secondary_bg_color) root.setProperty('--surface', tp.secondary_bg_color);
      if (tp.text_color) root.setProperty('--text', tp.text_color);
      if (tp.hint_color) root.setProperty('--text-muted', tp.hint_color);
      if (tp.button_color) root.setProperty('--accent', tp.button_color);
      if (tp.button_text_color) root.setProperty('--accent-text', tp.button_text_color);
    }
  } catch (err) {
    console.warn('WebApp SDK init warning:', err);
  }
}

// Работа с датами по МСК (UTC+3)
function getMoscowDate(offsetDays = 0) {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utc + 3 * 3600000 + offsetDays * 86400000);
}

function formatDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatDayTitle(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return `${DAYS_RU[date.getDay()]}, ${d} ${MONTHS_RU[m - 1]}`;
}

function getWeekDates(weekOffset = 0) {
  const today = getMoscowDate(0);
  const day = today.getDay(); // 0=вс, 1=пн...
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = getMoscowDate(diffToMonday + weekOffset * 7);
  const dates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday.getTime() + i * 86400000);
    dates.push(formatDateStr(d));
  }
  return dates;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getLessonBadgeClass(type) {
  const t = (type || '').toLowerCase();
  if (t.includes('лек')) return 'badge-lec';
  if (t.includes('прак') || t.includes('сем')) return 'badge-prac';
  if (t.includes('лаб')) return 'badge-lab';
  return 'badge-other';
}

// Загрузка данных
async function fetchJson(url, bustCache = false) {
  const isLocalData = url.startsWith('./data/');
  const cacheToken = bustCache ? Date.now() : isLocalData ? state.meta?.updatedAt || Date.now() : null;
  const finalUrl = cacheToken ? `${url}${url.includes('?') ? '&' : '?'}v=${encodeURIComponent(cacheToken)}` : url;
  const res = await fetch(finalUrl, isLocalData ? { cache: 'no-cache' } : undefined);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function loadMeta(bustCache = true) {
  state.meta = await fetchJson('./data/meta.json', bustCache);
  if (state.meta?.updatedAt) {
    const dt = new Date(state.meta.updatedAt);
    el.updatedAtLabel.textContent = `Обновлено: ${dt.toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })}`;
  }
  updateWeatherBar();
}

async function loadLiveWeather() {
  try {
    const url =
      'https://api.open-meteo.com/v1/forecast?latitude=46.8489&longitude=35.3653&current=temperature_2m&daily=temperature_2m_max,temperature_2m_min,weather_code&timezone=Europe%2FMoscow';
    const data = await fetchJson(url);
    const WMO_RU = {
      0: '☀️ Ясно', 1: '🌤 Ясно', 2: '⛅️ Облачно', 3: '☁️ Пасмурно',
      45: '🌫 Туман', 51: '🌧 Морось', 61: '🌧 Дождь', 63: '🌧 Дождь',
      71: '❄️ Снег', 80: '🌦 Ливень', 95: '⛈ Гроза',
    };
    const fmt = (idx) => {
      const min = Math.round(data.daily.temperature_2m_min[idx]);
      const max = Math.round(data.daily.temperature_2m_max[idx]);
      const desc = WMO_RU[data.daily.weather_code[idx]] || '🌤 Облачно';
      const sign = (n) => (n > 0 ? `+${n}` : `${n}`);
      return `${desc}, ${sign(min)}…${sign(max)}°C`;
    };
    state.weatherLive = { today: fmt(0), tomorrow: fmt(1) };
    updateWeatherBar();
  } catch {
    // Остаётся резервная погода из meta.json
  }
}

function updateWeatherBar() {
  const isTomorrow = state.activeTab === 'tomorrow';
  const live = state.weatherLive;
  const cached = state.meta?.weather;

  let text = null;
  if (live) {
    text = isTomorrow ? `Завтра в Мелитополе: ${live.tomorrow}` : `Сегодня в Мелитополе: ${live.today}`;
  } else if (cached) {
    text = isTomorrow
      ? `Завтра в Мелитополе: ${cached.tomorrow?.text || ''}`
      : `Сегодня в Мелитополе: ${cached.today?.text || ''}`;
  }

  if (text) {
    el.weatherText.textContent = text;
    el.weatherBar.classList.remove('hidden');
  } else {
    el.weatherBar.classList.add('hidden');
  }
}

async function getGroupSchedule(group, forceReload = false) {
  if (!group) return null;
  if (!forceReload && state.groupCache.has(group)) {
    return state.groupCache.get(group);
  }
  const data = await fetchJson(`./data/groups/${encodeURIComponent(group)}.json`, forceReload);
  state.groupCache.set(group, data);
  return data;
}

async function getTeacherSchedule(teacherName, forceReload = false) {
  if (!teacherName || !state.meta?.teachers) return null;
  if (!forceReload && state.teacherCache.has(teacherName)) {
    return state.teacherCache.get(teacherName);
  }
  const idx = state.meta.teachers.indexOf(teacherName);
  if (idx === -1) return null;
  const data = await fetchJson(`./data/teachers/${idx}.json`, forceReload);
  state.teacherCache.set(teacherName, data);
  return data;
}

// Рендер карточек расписания
function renderLessonCard(l, showGroup = false) {
  const time =
    l.start_time && l.end_time
      ? `${l.start_time.slice(0, 5)}–${l.end_time.slice(0, 5)}`
      : 'Время уточняется';
  const badgeClass = getLessonBadgeClass(l.lesson_type);
  const subgroup = l.subgroup ? `<span>👥 Подгр. ${escapeHtml(l.subgroup)}</span>` : '';
  const teacherOrGroup = showGroup
    ? `<span>🎓 ${escapeHtml(l.group_name || '—')}</span>`
    : `<span>👤 ${escapeHtml(l.teacher_full_name || 'Не указан')}</span>`;

  return `
    <article class="lesson-card">
      <div class="lesson-top">
        <div class="lesson-time">
          <span class="lesson-num">${escapeHtml(l.lesson_number || '—')} пара</span>
          <span>${escapeHtml(time)}</span>
        </div>
        ${l.lesson_type ? `<span class="lesson-badge ${badgeClass}">${escapeHtml(l.lesson_type)}</span>` : ''}
      </div>
      <div class="lesson-subject">${escapeHtml(l.subject_name || 'Предмет не указан')}</div>
      <div class="lesson-meta">
        <span>🏫 Ауд. ${escapeHtml(l.classroom || '—')}</span>
        ${teacherOrGroup}
        ${subgroup}
      </div>
    </article>
  `;
}

function renderEmptyState(emoji, title, subtitle) {
  el.scheduleContent.innerHTML = `
    <div class="empty-state">
      <div class="empty-emoji">${emoji}</div>
      <p class="empty-title">${escapeHtml(title)}</p>
      <p class="muted">${escapeHtml(subtitle)}</p>
    </div>
  `;
}

function renderDays(lessons, targetDates, showGroup = false) {
  const byDate = new Map();
  for (const d of targetDates) byDate.set(d, []);

  for (const l of lessons || []) {
    if (byDate.has(l.lesson_date)) {
      byDate.get(l.lesson_date).push(l);
    }
  }

  // Для недели скрываем пустые дни, если в неделе есть хотя бы 1 пара (кроме случая, когда вся неделя пустая)
  const isSingleDay = targetDates.length === 1;
  let totalLessons = 0;
  for (const arr of byDate.values()) totalLessons += arr.length;

  if (totalLessons === 0) {
    renderEmptyState(
      '🎉',
      isSingleDay ? 'Занятий нет, законный выходной!' : 'На выбранный период пар не найдено',
      isSingleDay ? formatDayTitle(targetDates[0]) : 'Возможно, каникулы или расписание ещё не опубликовано'
    );
    return;
  }

  let html = '';
  for (const [dateStr, dayLessons] of byDate.entries()) {
    if (!isSingleDay && dayLessons.length === 0) continue;

    dayLessons.sort((a, b) => (a.lesson_number || 0) - (b.lesson_number || 0));
    html += `
      <section class="day-section">
        <div class="day-header">
          <span>${escapeHtml(formatDayTitle(dateStr))}</span>
          <span class="day-header-count">${dayLessons.length} пар(ы)</span>
        </div>
        ${dayLessons.map((l) => renderLessonCard(l, showGroup)).join('')}
      </section>
    `;
  }
  el.scheduleContent.innerHTML = html;
}

// Основной рендер в зависимости от вкладки
async function renderActiveView(forceReload = false) {
  updateWeatherBar();
  el.statusBanner.classList.add('hidden');

  el.datePanel.classList.toggle('hidden', state.activeTab !== 'date');
  el.teacherPanel.classList.toggle('hidden', state.activeTab !== 'teacher');

  if (state.activeTab === 'teacher') {
    if (!state.teacher) {
      renderEmptyState('👤', 'Выберите преподавателя', 'Введите фамилию в поле поиска выше');
      return;
    }
    el.selectedTeacherBadge.textContent = `Выбран: ${state.teacher}`;
    el.selectedTeacherBadge.classList.remove('hidden');

    el.scheduleContent.innerHTML = '<div class="loader-wrap"><div class="spinner"></div><p class="muted">Загружаем расписание преподавателя...</p></div>';
    try {
      const data = await getTeacherSchedule(state.teacher, forceReload);
      const weekDates = getWeekDates(0);
      renderDays(data?.lessons || [], weekDates, true);
    } catch {
      renderEmptyState('📭', 'Нет сохранённого расписания', `Для преподавателя ${state.teacher} пока нет данных`);
    }
    return;
  }

  if (!state.group) {
    openGroupModal(false);
    renderEmptyState('🎓', 'Группа не выбрана', 'Нажмите «Выбрать группу» сверху, чтобы открыть расписание');
    return;
  }

  el.scheduleContent.innerHTML = '<div class="loader-wrap"><div class="spinner"></div><p class="muted">Загружаем расписание...</p></div>';

  try {
    const data = await getGroupSchedule(state.group, forceReload);
    const lessons = data?.lessons || [];

    if (data?.isBackup) {
      const when = data.cachedAt ? `от ${data.cachedAt}` : 'из резервного архива';
      el.statusBanner.textContent = `⚠️ Сайт МелГУ временно недоступен. Показана резервная копия ${when} — возможны изменения.`;
      el.statusBanner.classList.remove('hidden');
    }

    let targetDates = [];
    if (state.activeTab === 'today') {
      targetDates = [formatDateStr(getMoscowDate(0))];
    } else if (state.activeTab === 'tomorrow') {
      targetDates = [formatDateStr(getMoscowDate(1))];
    } else if (state.activeTab === 'week') {
      targetDates = getWeekDates(0);
    } else if (state.activeTab === 'next_week') {
      targetDates = getWeekDates(1);
    } else if (state.activeTab === 'date') {
      targetDates = [state.selectedDate || formatDateStr(getMoscowDate(0))];
    }

    renderDays(lessons, targetDates, false);
  } catch (err) {
    renderEmptyState(
      '⚠️',
      'Расписание пока не загружено',
      `Для группы ${state.group} ещё нет локальной копии. Запустите синхронизацию GitHub Actions или выберите другую группу.`
    );
  }
}

// Быстрые даты для вкладки "На дату"
function initQuickDates() {
  el.quickDates.innerHTML = '';
  const todayStr = formatDateStr(getMoscowDate(0));
  if (!state.selectedDate) state.selectedDate = todayStr;
  el.customDateInput.value = state.selectedDate;

  for (let i = 0; i < 6; i++) {
    const d = getMoscowDate(i);
    const dStr = formatDateStr(d);
    const label = i === 0 ? 'Сегодня' : i === 1 ? 'Завтра' : `${d.getDate()} ${MONTHS_RU[d.getMonth()].slice(0, 3)}`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `quick-date-btn ${state.selectedDate === dStr ? 'active' : ''}`;
    btn.textContent = label;
    btn.addEventListener('click', () => {
      state.selectedDate = dStr;
      el.customDateInput.value = dStr;
      initQuickDates();
      renderActiveView();
    });
    el.quickDates.appendChild(btn);
  }
}

// Поиск группы
function renderGroupList(query = '') {
  const groups = state.meta?.groups || [];
  const q = query.trim().replace(/,/g, '.').toLowerCase();
  const filtered = q
    ? groups.filter((g) => g.toLowerCase().includes(q)).slice(0, 60)
    : groups.slice(0, 60);

  if (filtered.length === 0) {
    el.groupListContainer.innerHTML = '<p class="muted" style="padding:12px;">Группы не найдены</p>';
    return;
  }

  el.groupListContainer.innerHTML = filtered
    .map(
      (g) =>
        `<button type="button" class="group-item ${g === state.group ? 'selected' : ''}" data-group="${escapeHtml(g)}">${escapeHtml(g)}</button>`
    )
    .join('');

  el.groupListContainer.querySelectorAll('.group-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const selected = btn.dataset.group;
      state.group = selected;
      storage.set(STORAGE_KEYS.group, selected);
      el.currentGroupLabel.textContent = selected;
      closeGroupModal();
      renderActiveView();
    });
  });
}

function openGroupModal(allowClose = true) {
  el.closeGroupModalBtn.classList.toggle('hidden', !allowClose && !state.group);
  el.groupModal.classList.remove('hidden');
  el.groupSearchInput.value = '';
  el.clearGroupSearchBtn.classList.add('hidden');
  renderGroupList('');
  setTimeout(() => el.groupSearchInput.focus(), 50);
}

function closeGroupModal() {
  el.groupModal.classList.add('hidden');
}

// Поиск преподавателя
function renderTeacherSuggestions(query = '') {
  const teachers = state.meta?.teachers || [];
  const q = query.trim().toLowerCase().replace(/ё/g, 'е');
  if (!q) {
    el.teacherSuggestions.innerHTML = '';
    return;
  }

  const matches = teachers
    .filter((t) => t.toLowerCase().replace(/ё/g, 'е').includes(q))
    .slice(0, 12);

  if (matches.length === 0) {
    el.teacherSuggestions.innerHTML = '<p class="muted" style="padding:6px;">Преподаватель не найден</p>';
    return;
  }

  el.teacherSuggestions.innerHTML = matches
    .map((t) => `<button type="button" class="suggestion-item" data-teacher="${escapeHtml(t)}">${escapeHtml(t)}</button>`)
    .join('');

  el.teacherSuggestions.querySelectorAll('.suggestion-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.teacher = btn.dataset.teacher;
      storage.set(STORAGE_KEYS.teacher, state.teacher);
      el.teacherSearchInput.value = '';
      el.clearTeacherBtn.classList.add('hidden');
      el.teacherSuggestions.innerHTML = '';
      renderActiveView();
    });
  });
}

// Привязка событий
function bindEvents() {
  el.tabs.forEach((btn) => {
    btn.addEventListener('click', () => {
      el.tabs.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.activeTab = btn.dataset.tab;
      if (state.activeTab === 'date') initQuickDates();
      renderActiveView();
    });
  });

  el.groupBtn.addEventListener('click', () => openGroupModal(true));
  el.closeGroupModalBtn.addEventListener('click', closeGroupModal);
  el.groupModal.addEventListener('click', (e) => {
    if (e.target === el.groupModal && state.group) closeGroupModal();
  });

  el.groupSearchInput.addEventListener('input', (e) => {
    el.clearGroupSearchBtn.classList.toggle('hidden', !e.target.value);
    renderGroupList(e.target.value);
  });

  el.clearGroupSearchBtn.addEventListener('click', () => {
    el.groupSearchInput.value = '';
    el.clearGroupSearchBtn.classList.add('hidden');
    renderGroupList('');
  });

  el.customDateInput.addEventListener('change', (e) => {
    if (e.target.value) {
      state.selectedDate = e.target.value;
      initQuickDates();
      renderActiveView();
    }
  });

  el.teacherSearchInput.addEventListener('input', (e) => {
    el.clearTeacherBtn.classList.toggle('hidden', !e.target.value);
    renderTeacherSuggestions(e.target.value);
  });

  el.clearTeacherBtn.addEventListener('click', () => {
    el.teacherSearchInput.value = '';
    el.clearTeacherBtn.classList.add('hidden');
    el.teacherSuggestions.innerHTML = '';
  });

  el.refreshBtn.addEventListener('click', async () => {
    await loadMeta(true).catch(() => {});
    await renderActiveView(true);
  });
}

// Старт приложения
async function bootstrap() {
  initPlatformSdk();
  bindEvents();

  if (state.group) {
    el.currentGroupLabel.textContent = state.group;
  }

  try {
    await loadMeta();
  } catch (err) {
    renderEmptyState('⚠️', 'Ошибка загрузки данных', 'Не удалось загрузить meta.json');
    return;
  }

  loadLiveWeather();
  await renderActiveView();
}

bootstrap();
