// База задач — перенесена из документа «База знаний: уборка по комнатам».
// Поля задачи:
//   id     — постоянный ключ (на него ссылается история, не менять)
//   z      — зона
//   t      — текст шага
//   every  — частота, дней
//   min    — оценка времени, минут
//   ord    — порядок внутри зоны (сверху вниз, от сухого к мокрому)
//   tags   — floor (пол, идёт общей волной в конце), dust (пыль), linen (текстиль у тела),
//            hyg (гигиена: при просрочке берётся в уборку первой)
//   prep   — подготовительный шаг, который ставится в начало сессии
//   wait   — сколько минут должно пройти после prep, прежде чем дочищать
//   hint   — как делать
//   warn   — предупреждение по безопасности
//   kit    — что понадобится (если не указано — выводится из зоны и тегов, см. logic.kitFor)
//   when   — для ежедневных: 'morning' (утренние мелочи) или 'evening' (вечерние)
//   need   — задача есть, только если дома живёт: 'dog' | 'cat' | 'pet' (любой питомец)
//   В тексте {dog}, {cat}, {pets} заменяются на имена питомцев.

// order: 0 — самая дальняя от выхода зона, убирается первой.
export const ZONES = [
  { id: 'bedroom', name: 'Спальня', order: 0, on: true },
  { id: 'kids', name: 'Детская', order: 1, on: false },
  { id: 'work', name: 'Рабочее место', order: 2, on: false },
  { id: 'living', name: 'Гостиная', order: 3, on: true },
  { id: 'balcony', name: 'Балкон', order: 4, on: false },
  { id: 'kitchen', name: 'Кухня', order: 5, on: true },
  { id: 'bath', name: 'Ванная и туалет', order: 6, on: true },
  { id: 'pets', name: 'Питомцы', order: 6.5, on: true },
  { id: 'hall', name: 'Прихожая', order: 7, on: true },
  { id: 'home', name: 'Весь дом', order: 8, on: true },
];

const NO_BLEACH = 'Не смешивать с хлоркой. Между разными средствами — смыть водой.';

export const TASKS = [
  // Кухня
  { id: 'k-towels', z: 'kitchen', t: 'Полотенца и прихватки — в стирку', every: 3, min: 1, ord: 0 },
  { id: 'k-dishes', z: 'kitchen', t: 'Посуда', every: 1, min: 10, ord: 1, when: 'evening', tags: ['hyg'], hint: 'В посудомойку или вымыть, сушилку освободить.' },
  { id: 'k-top', z: 'kitchen', t: 'Верх шкафов и вытяжка снаружи', every: 14, min: 5, ord: 4, tags: ['dust'] },
  { id: 'k-fronts', z: 'kitchen', t: 'Фасады шкафов и ручки', every: 7, min: 5, ord: 5, hint: 'Жирные отпечатки — обезжиривателем.' },
  { id: 'k-appliances', z: 'kitchen', t: 'Техника снаружи', every: 7, min: 5, ord: 6, hint: 'Холодильник, чайник, духовка, кофемашина.' },
  { id: 'k-fridge', z: 'kitchen', t: 'Холодильник: выбросить просрочку, протереть полки', every: 30, min: 20, ord: 6, hint: 'Вода с содой, без запахов химии.' },
  {
    id: 'k-micro', kit: ['Миска', 'Лимон'], z: 'kitchen', t: 'Микроволновка внутри', every: 7, min: 3, ord: 7, wait: 5,
    prep: 'Микроволновка: миска воды с лимоном, 4 мин на полной мощности, дверцу не открывать',
    hint: 'Пар уже размягчил грязь — просто протереть.',
  },
  { id: 'k-hob', z: 'kitchen', t: 'Варочная панель и фартук', every: 7, min: 5, ord: 8, hint: 'Стеклокерамику — без абразивов, скребком.' },
  { id: 'k-counters', z: 'kitchen', t: 'Столешницы и стол', every: 1, min: 3, ord: 9, when: 'evening', tags: ['hyg'] },
  {
    id: 'k-hood', kit: ['Обезжириватель', 'Щётка'], z: 'kitchen', t: 'Фильтр вытяжки — промыть щёткой', every: 30, min: 10, ord: 10, wait: 20,
    prep: 'Замочить фильтр вытяжки в горячей воде с обезжиривателем',
  },
  {
    id: 'k-kettle', kit: ['Лимонная кислота'], z: 'kitchen', t: 'Чайник — слить, ополоснуть', every: 30, min: 2, ord: 10, wait: 15,
    prep: 'Чайник: вода + ложка лимонной кислоты, вскипятить',
  },
  { id: 'k-dishwasher', z: 'kitchen', t: 'Посудомойка: фильтр и уплотнители', every: 30, min: 10, ord: 10 },
  { id: 'k-sponge', z: 'kitchen', t: 'Сменить губку для посуды', every: 10, min: 1, ord: 11, tags: ['hyg'] },
  { id: 'k-sink', z: 'kitchen', t: 'Раковина и смеситель', every: 7, min: 5, ord: 11, tags: ['hyg'], hint: 'Последней из поверхностей — сюда стекает вся грязь. В конце кипяток в слив.' },
  { id: 'k-trash', z: 'kitchen', t: 'Вынести мусор', every: 2, min: 2, ord: 12, tags: ['hyg'] },
  {
    id: 'k-oven', kit: ['Перчатки', 'Средство для духовок'], z: 'kitchen', t: 'Духовка внутри', every: 75, min: 30, ord: 13, wait: 20,
    prep: 'Нанести средство для духовок внутрь духовки', warn: 'Проветривать. ' + NO_BLEACH,
  },
  { id: 'k-cabinets', z: 'kitchen', t: 'Шкафы внутри, разбор круп и специй', every: 90, min: 45, ord: 14 },
  { id: 'k-behind', z: 'kitchen', t: 'За и под техникой', every: 120, min: 30, ord: 15 },
  { id: 'k-floor', z: 'kitchen', t: 'Пол на кухне', every: 7, min: 7, ord: 20, tags: ['floor'] },

  // Ванная и туалет
  { id: 'b-sink-quick', z: 'bath', t: 'Раковина в ванной — сполоснуть и протереть насухо', every: 1, min: 2, ord: 1, when: 'morning' },
  { id: 'b-towels', z: 'bath', t: 'Полотенца — в стирку', every: 4, min: 1, ord: 0, tags: ['hyg'], hint: '60 °C. Кондиционера поменьше — от него полотенца хуже впитывают.' },
  { id: 'b-mat', z: 'bath', t: 'Коврик — в стирку', every: 7, min: 1, ord: 0 },
  { id: 'b-trash', z: 'bath', t: 'Мусорное ведро в ванной', every: 7, min: 2, ord: 0 },
  { id: 'b-vent', z: 'bath', t: 'Вентрешётка и светильник', every: 90, min: 10, ord: 2, tags: ['dust'] },
  { id: 'b-mirror', z: 'bath', t: 'Зеркала', every: 7, min: 2, ord: 3 },
  {
    id: 'b-tub', kit: ['Перчатки', 'Средство от налёта', 'Жёлтая тряпка'], z: 'bath', t: 'Кафель, ванна и душ — смыть и вытереть', every: 7, min: 10, ord: 4, tags: ['hyg'], wait: 10,
    prep: 'Нанести средство от налёта на ванну, душ и кафель в зоне брызг', warn: NO_BLEACH,
  },
  {
    id: 'b-limescale', kit: ['Уксус или лимонная кислота', 'Миска'], z: 'bath', t: 'Лейка, смесители, аэраторы — дочистить', every: 30, min: 10, ord: 5, wait: 60,
    prep: 'Замочить лейку душа и аэраторы в уксусе (или лимонной кислоте)', warn: 'Уксус нельзя рядом с хлоркой.',
  },
  { id: 'b-sink', z: 'bath', t: 'Ванная: раковина и смесители от налёта, стаканы, мыльница', every: 7, min: 4, ord: 6, tags: ['hyg'] },
  { id: 'b-touch', z: 'bath', t: 'Ручка двери, выключатель, кнопка слива', every: 7, min: 1, ord: 7 },
  {
    id: 'b-toilet', kit: ['Перчатки', 'Гель для унитаза', 'Ёршик', 'Красная тряпка'], z: 'bath', t: 'Унитаз целиком', every: 7, min: 7, ord: 8, tags: ['hyg'], wait: 10,
    prep: 'Нанести гель под ободок унитаза',
    hint: 'Красная тряпка. От чистого к грязному: бачок, крышка, сиденье с двух сторон, ободок, чаша ёршиком, основание.',
    warn: NO_BLEACH,
  },
  { id: 'b-grout', z: 'bath', t: 'Швы плитки', every: 30, min: 20, ord: 9, hint: 'Узкая щётка + кислородное средство.' },
  { id: 'b-drains', z: 'bath', t: 'Сливы — волосы и запах', every: 30, min: 5, ord: 9, hint: 'Трос для слива, потом кипяток. Сода + уксус бесполезны.' },
  { id: 'b-curtain', z: 'bath', t: 'Шторка душа — в стирку', every: 60, min: 2, ord: 9 },
  { id: 'b-washer', z: 'bath', t: 'Стиральная машина: манжета, лоток, фильтр, пустая стирка 90 °C', every: 30, min: 15, ord: 9 },
  { id: 'b-floor', z: 'bath', t: 'Пол в ванной и за унитазом', every: 7, min: 5, ord: 20, tags: ['floor'] },

  // Спальня
  { id: 's-bed', z: 'bedroom', t: 'Заправить кровать', every: 1, min: 2, ord: 9, when: 'morning' },
  { id: 's-clothes', z: 'bedroom', t: 'Одежда на места, чашки — на кухню', every: 1, min: 3, ord: 1, when: 'evening' },
  { id: 's-linen', z: 'bedroom', t: 'Снять постельное бельё и запустить стирку', every: 14, min: 3, ord: 0, tags: ['linen', 'hyg'], hint: 'Пока убираешь — оно стирается. 60 °C. Застелить чистое — в конце.' },
  { id: 's-dust', z: 'bedroom', t: 'Пыль: люстра, шкаф, полки, тумбочки, подоконник', every: 7, min: 5, ord: 2, tags: ['dust'] },
  { id: 's-throws', z: 'bedroom', t: 'Пледы и покрывала — в стирку', every: 30, min: 3, ord: 0 },
  { id: 's-mattress', z: 'bedroom', t: 'Пропылесосить матрас', every: 30, min: 10, ord: 3, tags: ['linen'] },
  { id: 's-flip', z: 'bedroom', t: 'Перевернуть или развернуть матрас', every: 90, min: 5, ord: 3 },
  { id: 's-pillows', z: 'bedroom', t: 'Постирать подушки', every: 105, min: 5, ord: 0 },
  { id: 's-duvet', z: 'bedroom', t: 'Постирать одеяло', every: 180, min: 5, ord: 0 },
  { id: 's-wardrobe', z: 'bedroom', t: 'Разбор шкафа, смена сезонной одежды', every: 180, min: 90, ord: 4 },
  { id: 's-floor', z: 'bedroom', t: 'Пол в спальне и под кроватью', every: 7, min: 7, ord: 20, tags: ['floor'] },

  // Гостиная
  { id: 'l-tidy', z: 'living', t: 'Вещи на места, подушки, плед', every: 1, min: 5, ord: 1, when: 'evening', hint: 'Всё чужое — в одну корзину и разнести за один проход.' },
  { id: 'l-dust', z: 'living', t: 'Пыль: углы потолка, полки, техника, подоконник', every: 7, min: 7, ord: 2, tags: ['dust'], hint: 'Экран ТВ — только сухой микрофиброй.' },
  { id: 'l-touch', z: 'living', t: 'Пульты, выключатели, ручки', every: 7, min: 2, ord: 4 },
  { id: 'l-plants', z: 'living', t: 'Цветы: полить, протереть листья', every: 7, min: 5, ord: 4 },
  { id: 'l-windows', z: 'living', t: 'Окна изнутри', every: 30, min: 15, ord: 3, hint: 'Не на солнце — останутся разводы.' },
  { id: 'l-sofa', z: 'living', t: 'Мягкая мебель — пылесосом', every: 30, min: 15, ord: 5, tags: ['dust'] },
  { id: 'l-covers', z: 'living', t: 'Чехлы подушек и пледы — в стирку', every: 30, min: 3, ord: 0 },
  { id: 'l-baseboards', z: 'living', t: 'Плинтусы и двери — влажно', every: 30, min: 15, ord: 6 },
  { id: 'l-curtains', z: 'living', t: 'Шторы и жалюзи', every: 135, min: 45, ord: 3 },
  { id: 'l-carpet', z: 'living', t: 'Ковёр — глубокая чистка', every: 270, min: 90, ord: 21 },
  { id: 'l-floor', z: 'living', t: 'Пылесос и пол в гостиной, под диваном', every: 7, min: 10, ord: 20, tags: ['floor'] },

  // Прихожая
  { id: 'h-shoes', z: 'hall', t: 'Обувь на полку', every: 1, min: 1, ord: 1, when: 'evening' },
  { id: 'h-mirror', z: 'hall', t: 'Зеркало, ручки, звонок, выключатели', every: 7, min: 3, ord: 3 },
  { id: 'h-mat', z: 'hall', t: 'Коврик у двери — вытряхнуть', every: 7, min: 2, ord: 5 },
  { id: 'h-door', z: 'hall', t: 'Входная дверь целиком', every: 30, min: 10, ord: 4 },
  { id: 'h-shoerack', z: 'hall', t: 'Полка для обуви внутри', every: 30, min: 10, ord: 4 },
  { id: 'h-season', z: 'hall', t: 'Разбор верхней одежды и обуви по сезону', every: 180, min: 45, ord: 2 },
  { id: 'h-floor', z: 'hall', t: 'Пол в прихожей — от квартиры к двери', every: 7, min: 5, ord: 20, tags: ['floor'] },

  // Детская
  { id: 'c-toys', z: 'kids', t: 'Игрушки по коробкам — вместе с ребёнком', every: 1, min: 7, ord: 1, when: 'evening' },
  { id: 'c-dust', z: 'kids', t: 'Пыль в детской', every: 7, min: 5, ord: 2, tags: ['dust'] },
  { id: 'c-wash-toys', z: 'kids', t: 'Помыть игрушки, которые берут в рот', every: 7, min: 10, ord: 3 },
  { id: 'c-soft', z: 'kids', t: 'Мягкие игрушки — в стирку', every: 30, min: 5, ord: 0 },
  { id: 'c-sort', z: 'kids', t: 'Разбор: что мало или сломано', every: 90, min: 60, ord: 4 },
  { id: 'c-floor', z: 'kids', t: 'Пол в детской', every: 7, min: 7, ord: 20, tags: ['floor'] },

  // Балкон
  { id: 'p-sweep', z: 'balcony', t: 'Подмести балкон', every: 14, min: 5, ord: 20 },
  { id: 'p-sills', z: 'balcony', t: 'Подоконники и рамы', every: 30, min: 15, ord: 2 },
  { id: 'p-sort', z: 'balcony', t: 'Разбор балкона, стёкла снаружи', every: 180, min: 90, ord: 1 },

  // Рабочее место
  { id: 'w-desk', z: 'work', t: 'Стол пустой в конце дня', every: 1, min: 2, ord: 1, when: 'evening' },
  { id: 'w-monitor', z: 'work', t: 'Монитор и пыль на проводах', every: 7, min: 3, ord: 2, tags: ['dust'], hint: 'Экран — только сухой микрофиброй.' },
  { id: 'w-devices', z: 'work', t: 'Клавиатура, мышь, телефон — спиртовой салфеткой', every: 7, min: 3, ord: 3 },
  { id: 'w-papers', z: 'work', t: 'Разбор бумаг и ящиков', every: 30, min: 20, ord: 4 },

  // Весь дом
  { id: 'x-smoke', z: 'home', t: 'Проверить датчики дыма', every: 30, min: 2, ord: 1 },
  { id: 'x-filters', z: 'home', t: 'Фильтры очистителя и кондиционера', every: 60, min: 10, ord: 2 },
  { id: 'x-windows', z: 'home', t: 'Окна снаружи, рамы, москитные сетки', every: 180, min: 60, ord: 3, hint: 'Весной и осенью, в пасмурную сухую погоду.' },
  { id: 'x-furniture', z: 'home', t: 'Отодвинуть мебель: пыль за ней и в батареях', every: 180, min: 120, ord: 4, tags: ['dust'] },

  // Питомцы
  { id: 'pt-bowls', z: 'pets', t: 'Миски: помыть, налить свежей воды', every: 1, min: 3, ord: 1, when: 'morning', need: 'pet', tags: ['hyg'], hint: 'Отдельной губкой, не той, что для посуды.', kit: ['Губка для мисок'] },
  { id: 'pt-litter', z: 'pets', t: 'Лоток {cat}: убрать комки', every: 1, min: 2, ord: 2, when: 'evening', need: 'cat', tags: ['hyg'], kit: ['Совок', 'Пакет'] },
  {
    id: 'pt-litter-full', z: 'pets', t: 'Лоток {cat}: сменить наполнитель, вымыть', every: 14, min: 15, ord: 3, need: 'cat', tags: ['hyg'],
    hint: 'Тёплой водой с мылом без запаха — резкие запахи отпугивают кошек от лотка.',
    warn: 'Без хлорки: с мочой в лотке она даёт ядовитый газ.', kit: ['Перчатки', 'Пакет', 'Наполнитель'],
  },
  { id: 'pt-litter-mat', z: 'pets', t: 'Коврик у лотка — вытряхнуть', every: 7, min: 2, ord: 4, need: 'cat' },
  { id: 'pt-hair', z: 'living', t: 'Шерсть с дивана и пледов — роликом', every: 3, min: 5, ord: 5, need: 'pet', kit: ['Ролик для шерсти'] },
  { id: 'pt-bed-dog', z: 'pets', t: 'Лежанка {dog}: вытряхнуть и пропылесосить', every: 7, min: 5, ord: 5, need: 'dog' },
  { id: 'pt-bed-dog-wash', z: 'pets', t: 'Лежанка {dog}: постирать', every: 30, min: 5, ord: 5, need: 'dog', hint: 'Без ароматизаторов, с двойным полосканием.' },
  { id: 'pt-house-cat', z: 'pets', t: 'Домик и когтеточка {cat} — пропылесосить', every: 14, min: 5, ord: 5, need: 'cat' },
  { id: 'pt-toys', z: 'pets', t: 'Игрушки {pets} — помыть', every: 30, min: 10, ord: 6, need: 'pet' },
  { id: 'pt-leash', z: 'hall', t: 'Поводок и шлейка {dog} — протереть', every: 30, min: 5, ord: 4, need: 'dog' },
  { id: 'pt-paws', z: 'hall', t: 'Пол у двери после прогулки {dog}', every: 2, min: 2, ord: 6, need: 'dog', hint: 'В сырую погоду — после каждой прогулки. Лапы — тряпкой у двери.' },
];
