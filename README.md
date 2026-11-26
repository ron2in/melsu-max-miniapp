# Расписание МелГУ — MAX Mini App (GitHub Pages)

Автономное мини-приложение расписания Мелитопольского государственного университета для мессенджера **MAX** с хостингом на **GitHub Pages** и автоматической синхронизацией через **GitHub Actions**.

## Структура проекта

- `index.html`, `style.css`, `app.js` — фронтенд Mini App с поддержкой `window.WebApp` (`max-web-app.js`), светлой/тёмной темы и безопасным `localStorage`.
- `scripts/sync.mjs` — скрипт выгрузки расписания с `rasp.melsu.ru` и погоды с `open-meteo.com` (при сбое сайта старые JSON-файлы сохраняются как резервная копия).
- `.github/workflows/sync.yml` — автоматическое обновление папки `data/` каждые 4 часа и по кнопке вручную.
- `data/` — JSON-база групп, преподавателей и погоды.

## Как запустить на GitHub Pages

1. Создайте новый репозиторий на GitHub (например, `melsu-max-miniapp`) и загрузите в него **содержимое папки `melsu-max-miniapp`** (включая скрытую папку `.github/`).
2. Включите **GitHub Pages**:
   - Откройте `Settings → Pages`
   - В `Build and deployment` выберите `Deploy from a branch`
   - Ветка: `main`, папка: `/ (root)` → нажмите **Save**.
3. Разрешите GitHub Actions записывать обновлённое расписание:
   - Откройте `Settings → Actions → General`
   - В блоке `Workflow permissions` выберите **Read and write permissions** → **Save**.
4. Запустите первую синхронизацию вручную:
   - Перейдите во вкладку **Actions** → **Sync MelSU Schedule** → **Run workflow**.
   - Через ~1–2 минуты все актуальные группы и преподаватели появятся в `data/`.
5. Подключите ссылку вида `https://<ваш-ник>.github.io/<репозиторий>/` в настройках мини-приложения на портале **dev.max.ru**.
