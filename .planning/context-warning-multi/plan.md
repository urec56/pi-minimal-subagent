# План: множественные context warnings

## Цель

Расширить фичу context warning: вместо одного порога — список ворнингов на разные
проценты контекста. Каждый ворнинг шлёт содержимое своего `messageFile` как steer
(механизм `/subagent-msg`), не более одного раза за ран.

## Закрытые решения

- Формат конфига: **только массив** `{ percent, messageFile }[]`. Объектная форма не
  поддерживается (совместимость не нужна).
- `null` / отсутствие ключа / `[]` → фича **тихо выключена** (пустой массив == null).
- Не-массив → ошибка валидации.
- Дубликат `percent` → **ошибка** валидации.
- Один и тот же `messageFile` в разных entry → **разрешено**.
- Лимита на количество entry нет.
- Перепрыг нескольких порогов за одно событие (60% → 90%) → шлём **только
  максимальный**; пропущенные пороги **молча** и безвозвратно (контекст не
  уменьшается).
- Плавное пересечение (70% в один момент, 85% позже) → ворнинги срабатывают по
  очереди, каждый не более одного раза.
- README/документация **не трогаем**.

## Изменения по файлам

### 1. `src/context-warning.ts` — переписать

- `ContextWarning` остаётся: `{ percent: number; messageFile: string; content: string }`.
- `validateContextWarning(raw: unknown, cwd: string)` возвращает
  `{ ok: true; warnings: ContextWarning[] } | { ok: false; errors: string[] }`:
  - `undefined` / `null` / `[]` → `{ ok: true, warnings: [] }` (нормализация «тихо
    выключено» живёт здесь, в одном месте).
  - Не-массив → `{ ok: false, errors: ["contextWarning must be an array of
    { percent, messageFile } entries (got <describeValue>)] }`.
  - Массив: каждый entry валидируется теми же полевыми проверками, что сейчас, с
    префиксом индекса: `contextWarning[1].percent ...`,
    `contextWarning[1].messageFile ...`; не-объект entry →
    `contextWarning[1] must be an object (got ...)`. Все найденные ошибки по всем
    entry собираются в один список (текущее поведение «all problems in one alert»).
  - Дубликат percent (среди entry с валидным percent) → ошибка вида
    `contextWarning.percent 85 is specified more than once (entries 0 and 2)`.
  - Успех: warnings отсортированы по `percent` по возрастанию (стабильная
    сортировка); контент файлов уже прочитан в память.
- `evaluateContextWarning` **заменяется** на `selectContextWarning`:

  ```ts
  export function selectContextWarning(
    warnings: readonly ContextWarning[],   // отсортированы по percent
    nextIndex: number,                      // сколько позиций уже потреблено
    contextWindow: number | undefined,
    contextTokens: number | undefined,
  ): { index: number; percent: number } | undefined
  ```

  - Нет usable window/tokens (не числа, <= 0) → `undefined`.
  - Текущий percent считается один раз: `(contextTokens / contextWindow) * 100`.
  - Сканирует с конца списка до `nextIndex` и возвращает **самый высокий**
    невыстреливший ворнинг с `threshold <= current`; `percent` в результате —
    текущее заполнение контекста (для UI), как у нынешнего `evaluateContextWarning`.
  - Ничего не найдено → `undefined`.
- `describeValue` остаётся.

### 2. `src/runner.ts`

- Опция: `contextWarning?: ContextWarning[]` (отсортированный, непустой список;
  пустой не передаётся).
- `onContextWarning?: (runId: number, percent: number, threshold: number) => void`
  — порог теперь приходит от рауннера (у одного ворнинга его больше нет).
- `let contextWarningFired = false` → `let contextWarningIndex = 0` (сколько
  позиций уже потреблено: выстрелило или пропущено).
- `checkContextWarning()`:

  ```ts
  const warnings = opts.contextWarning;
  if (!warnings || contextWarningIndex >= warnings.length) return;
  const selection = selectContextWarning(
    warnings, contextWarningIndex, result.contextWindow, result.usage?.contextTokens,
  );
  if (!selection) return;
  const warning = warnings[selection.index];
  if (writeRpcCommand({ type: "steer", message: warning.content })) {
    contextWarningIndex = selection.index + 1; // fired + все пропущенные ниже
    result.sentContextAlerts = [...(result.sentContextAlerts ?? []), warning.content];
    if (activeRunId !== undefined) opts.onContextWarning?.(activeRunId, selection.percent, warning.percent);
  }
  ```

  - Индекс продвигается **только** при успешной записи (неудачная запись = ребёнок
    уже мёртв, повторимся на следующем событии — текущее поведение).
  - Комментарий над функцией обновить: «только максимальный достигнутый порог;
    перепрыгнутые пороги пропущены молча».
- Импорт: `evaluateContextWarning` → `selectContextWarning`.

### 3. `src/index.ts`

- `let contextWarning: ContextWarning[] | undefined;`
- Гейт: `if (rawContextWarning !== undefined)` (agents.ts кладёт ключ только при
  наличии; `null`/`[]` валидатор вернёт ok с пустым списком).
  - `validation.ok && validation.warnings.length > 0` → `contextWarning = validation.warnings`.
  - `validation.ok` с пустым списком → тихо off, без уведомления.
  - `!validation.ok` → текущее warning-уведомление со списком ошибок.
- `onContextWarning: (runId, percent, threshold)` → текст уведомления без изменений:
  `#${runId} ${agent.name} reached ${percent.toFixed(1)}% of context (threshold
  ${threshold}%) — stop instruction sent` (порог теперь из аргумента, а не из
  `contextWarning.percent`).
- В `runSubagent` передаётся массив.

### 4. `src/types.ts`

- `SubagentResult.sentContextAlert?: string` → `sentContextAlerts?: string[]`
  (комментарий обновить: контент всех отправленных ворнингов, для метки `alert`
  в event stream).
- `AgentConfig.contextWarning?: unknown` — без изменений (raw-значение).

### 5. `src/runner-events.js`

- `addUserMessageActivity`: матчинг реэмиссии steer'а — по membership:
  `Array.isArray(result.sentContextAlerts) && result.sentContextAlerts.some(
  (s) => typeof s === "string" && text === s.trim())` → `alert`, иначе `message`.
- Комментарий над функцией обновить (несколько ворнингов, множество отправленных
  текстов).

### 6. Тесты

`src/context-warning.test.js` (переписать под новый контракт):
- валидный массив → отсортированные warnings с resolved-путями и контентом;
  несортированный вход → отсортированный выход;
- `null` / `[]` → ok с пустым списком;
- не-массив (объект, строка) → ошибка `must be an array ... (got ...)`;
- поентные ошибки с индексом: `contextWarning[1].percent ...`,
  `contextWarning[0].messageFile ...`; все ошибки по всем entry в одном списке;
- дубликат percent → ошибка с индексами entry;
- один `messageFile` в двух entry → ok;
- все существующие file-кейсы (missing file, directory, empty/blank file, wrong
  extension, uppercase `.MD`, relative/absolute/`~` пути) — внутри entry;
- `selectContextWarning`:
  - пороги [70, 85], текущий 90 → index 1 (только максимум);
  - текущий 75 → index 0;
  - `nextIndex=1`, текущий 90 → index 1; `nextIndex=1`, текущий 80 → undefined;
  - после выстрела index 1 (`nextIndex=2`) → undefined (пропущенные не возвращаются);
  - нет window/tokens, window=0, tokens=0 → undefined;
  - threshold 0 → fires при любом usage data; граница: ровно порог → fires.

`src/runner-events.test.js`:
- существующие alert-тесты → `sentContextAlerts: [...]`;
- матчинг по любому элементу массива; несовпавший текст остаётся `message`.

`src/agents.test.js`:
- тест «nested contextWarning frontmatter block is captured as raw value» →
  array-форма (raw-значение захватывается как есть, логика не меняется).

Проверка: `npm test`, `npm run typecheck`.

## Вне scope

- README и прочие доки — не трогаем (по решению).
- Обратная совместимость с object-формой — не нужна.
- Глобальные/настраиваемые по умолчанию ворнинги — не вешаем.
