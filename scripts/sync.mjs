/**
 * Скрипт синхронизации расписания МелГУ и погоды для GitHub Pages.
 * Запускается в GitHub Actions (Node.js 20+, без сторонних зависимостей).
 *
 * Логика отказоустойчивости:
 * - Если rasp.melsu.ru недоступен или вернул ошибку для группы,
 *   существующий файл data/groups/<group>.json НЕ перезаписывается.
 * - Расписание преподавателей собирается автоматически из актуальных
 *   файлов групп (как онлайн, так и сохранённых ранее).
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = path.resolve('data');
const GROUPS_DIR = path.join(DATA_DIR, 'groups');
const TEACHERS_DIR = path.join(DATA_DIR, 'teachers');
const META_PATH = path.join(DATA_DIR, 'meta.json');

const MELSU_API = 'https://rasp.melsu.ru/api/v1/schedule/group';
const WEATHER_API =
  'https://api.open-meteo.com/v1/forecast?latitude=46.8489&longitude=35.3653&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,weather_code&timezone=Europe%2FMoscow';

const CONCURRENCY = 12;
const TIMEOUT_MS = 10000;

const WMO_RU = {
  0: '☀️ Ясно',
  1: '🌤 Преимущественно ясно',
  2: '⛅️ Переменная облачность',
  3: '☁️ Пасмурно',
  45: '🌫 Туман',
  48: '🌫 Туман с инеем',
  51: '🌧 Небольшая морось',
  53: '🌧 Морось',
  55: '🌧 Сильная морось',
  61: '🌧 Небольшой дождь',
  63: '🌧 Дождь',
  65: '🌧 Сильный дождь',
  71: '❄️ Небольшой снег',
  73: '❄️ Снег',
  75: '❄️ Сильный снегопад',
  80: '🌦 Кратковременный дождь',
  81: '🌧 Ливень',
  82: '🌧 Сильный ливень',
  95: '⛈ Гроза',
};

async function fetchWithTimeout(url, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWeather() {
  try {
    const res = await fetchWithTimeout(WEATHER_API, 8000);
    if (!res.ok) return null;
    const data = await res.json();
    const formatDay = (idx) => {
      const max = Math.round(data.daily.temperature_2m_max[idx]);
      const min = Math.round(data.daily.temperature_2m_min[idx]);
      const code = data.daily.weather_code[idx];
      const desc = WMO_RU[code] || '🌤 Облачно';
      const fmtT = (t) => (t > 0 ? `+${t}` : `${t}`);
      return {
        desc,
        min: fmtT(min),
        max: fmtT(max),
        text: `${desc}, от ${fmtT(min)}° до ${fmtT(max)}°C`,
      };
    };
    return {
      currentTemp: Math.round(data.current?.temperature_2m ?? 0),
      today: formatDay(0),
      tomorrow: formatDay(1),
      updatedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.warn('[Weather] Не удалось обновить погоду:', err.message);
    return null;
  }
}

async function readJsonSafe(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function syncGroup(group, nowIso) {
  const filePath = path.join(GROUPS_DIR, `${group}.json`);
  try {
    const res = await fetchWithTimeout(`${MELSU_API}/${encodeURIComponent(group)}`);
    if (!res.ok) return { group, status: 'fail' };
    const lessons = await res.json();
    if (!Array.isArray(lessons)) return { group, status: 'fail' };

    const payload = {
      group,
      updatedAt: nowIso,
      lessons,
    };
    await fs.writeFile(filePath, JSON.stringify(payload));
    return { group, status: 'ok', lessons };
  } catch {
    return { group, status: 'fail' };
  }
}

async function main() {
  await fs.mkdir(GROUPS_DIR, { recursive: true });
  await fs.mkdir(TEACHERS_DIR, { recursive: true });

  const meta = (await readJsonSafe(META_PATH)) || { groups: [], teachers: [] };
  const groups = meta.groups || [];
  const nowIso = new Date().toISOString();

  console.log(`Начинаем синхронизацию для ${groups.length} групп...`);

  let okCount = 0;
  let failCount = 0;
  const teacherMap = new Map();
  const discoveredTeachers = new Set(meta.teachers || []);

  for (let i = 0; i < groups.length; i += CONCURRENCY) {
    const batch = groups.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((g) => syncGroup(g, nowIso)));

    for (const r of results) {
      let lessons = r.lessons;
      if (r.status === 'ok') {
        okCount++;
      } else {
        failCount++;
        // Если сайт не ответил, берем кэшированный JSON группы для сборки преподавателей
        const cached = await readJsonSafe(path.join(GROUPS_DIR, `${r.group}.json`));
        lessons = cached?.lessons || [];
      }

      for (const l of lessons) {
        const tName = l.teacher_full_name?.trim();
        if (!tName) continue;
        discoveredTeachers.add(tName);
        if (!teacherMap.has(tName)) teacherMap.set(tName, []);
        teacherMap.get(tName).push({
          ...l,
          group_name: l.group_name || r.group,
        });
      }
    }

    if ((i + CONCURRENCY) % 120 === 0 || i + CONCURRENCY >= groups.length) {
      console.log(`Прогресс: ${Math.min(i + CONCURRENCY, groups.length)}/${groups.length} (успешно: ${okCount}, ошибок: ${failCount})`);
    }
  }

  // Сортируем преподавателей и записываем по индексам (0.json, 1.json, ...)
  const sortedTeachers = Array.from(discoveredTeachers).sort((a, b) => a.localeCompare(b, 'ru'));

  for (let idx = 0; idx < sortedTeachers.length; idx++) {
    const tName = sortedTeachers[idx];
    const tLessons = teacherMap.get(tName);
    if (tLessons && tLessons.length > 0) {
      await fs.writeFile(
        path.join(TEACHERS_DIR, `${idx}.json`),
        JSON.stringify({
          teacher: tName,
          updatedAt: nowIso,
          lessons: tLessons,
        })
      );
    }
  }

  const weather = (await fetchWeather()) || meta.weather || null;

  const updatedMeta = {
    updatedAt: okCount > 0 ? nowIso : meta.updatedAt || nowIso,
    lastAttemptAt: nowIso,
    onlineGroups: okCount,
    totalGroups: groups.length,
    groups,
    teachers: sortedTeachers,
    weather,
  };

  await fs.writeFile(META_PATH, JSON.stringify(updatedMeta));
  console.log(`Синхронизация завершена! Обновлено групп: ${okCount}/${groups.length}, преподавателей: ${sortedTeachers.length}`);
}

main().catch((err) => {
  console.error('Критическая ошибка синхронизации:', err);
  process.exit(1);
});
