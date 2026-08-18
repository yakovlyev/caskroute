/**
 * CaskRoute — Product Catalog Agent
 *
 * Наполняет таблицу `products` карточками товаров, включая фото.
 *
 * ИСТОРИЯ: раньше здесь стоял Wine Vybe (RapidAPI) как источник "лицензированных"
 * фото — проверили вживую 15-16.08 (и Beer, и отдельный Liquor API): их публичный
 * API нигде не отдаёт поле с фото, хотя на их же сайте карточки товаров с фото есть.
 * Wine Vybe как источник фото закрыт полностью, для всех их продуктов.
 *
 * ТЕКУЩАЯ СХЕМА (с 16.08): двухшаговая.
 *   Шаг 1 — по названию товара находим его реальный UPC-код через веб-поиск
 *           (Anthropic API + web_search) — тот же паттерн, что в chain-price-agent.js.
 *   Шаг 2 — с найденным UPC обращаемся к UPCitemdb (api.upcitemdb.com) — бесплатный
 *           тариф, регистрация не нужна, вживую подтверждено, что отдаёт реальные
 *           фото (проверено на Tito's Handmade Vodka, UPC 619947000020 — вернул
 *           массив images с рабочими ссылками на фото с сайтов Sam's Club, Walgreens,
 *           Walmart, Target).
 *
 * ВАЖНАЯ ОГОВОРКА (обсуждено с Игорем 16.08, решение — использовать, пока не
 * найдём стопроцентно чистый источник): эти фото не с сайта производителя
 * напрямую, а агрегированы UPCitemdb с сайтов ритейлеров. Параллельно нужно
 * рассылать запросы дистрибьюторам/брендам на официальные пресс-фото и потом
 * менять ссылки на них — этот агент явно печатает в консоль пометку
 * "upcitemdb_retailer_aggregate" для каждого вставленного фото, чтобы легко
 * найти и заменить позже (полноценный лог в БД появится вместе со схемой для
 * этого — сейчас inventory_update_log требует store_id, который тут неприменим).
 *
 * Требуемые переменные окружения:
 *   ANTHROPIC_API_KEY
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Стартовый список товаров — курировано вручную по приоритетным категориям
// (bourbon указан отдельно от общего whisky, т.к. в исходном ресёрче именно
// бурбон был назван приоритетом №1). Расширять по мере надобности.
const SEED_PRODUCTS = [
  { name: "Buffalo Trace Bourbon", brand: "Buffalo Trace", category: "bourbon", bottle_size_ml: 750 },
  { name: "Maker's Mark Bourbon", brand: "Maker's Mark", category: "bourbon", bottle_size_ml: 750 },
  { name: "Woodford Reserve Bourbon", brand: "Woodford Reserve", category: "bourbon", bottle_size_ml: 750 },
  { name: "Jack Daniel's Old No. 7", brand: "Jack Daniel's", category: "whisky", bottle_size_ml: 750 },
  { name: "Johnnie Walker Black Label", brand: "Johnnie Walker", category: "whisky", bottle_size_ml: 750 },
  { name: "Patrón Silver Tequila", brand: "Patrón", category: "tequila", bottle_size_ml: 750 },
  { name: "Casamigos Blanco Tequila", brand: "Casamigos", category: "tequila", bottle_size_ml: 750 },
  { name: "Tito's Handmade Vodka", brand: "Tito's", category: "vodka", bottle_size_ml: 750 },
  { name: "Grey Goose Vodka", brand: "Grey Goose", category: "vodka", bottle_size_ml: 750 },
  { name: "Bacardi Superior Rum", brand: "Bacardi", category: "rum", bottle_size_ml: 750 },
  { name: "Captain Morgan Spiced Rum", brand: "Captain Morgan", category: "rum", bottle_size_ml: 750 },
  { name: "Hennessy VS Cognac", brand: "Hennessy", category: "cognac", bottle_size_ml: 750 },
  { name: "Tanqueray London Dry Gin", brand: "Tanqueray", category: "gin", bottle_size_ml: 750 },
];

const CATEGORY_ES = {
  whisky: 'Whisky', bourbon: 'Bourbon', tequila: 'Tequila',
  vodka: 'Vodka', rum: 'Ron', cognac: 'Coñac', gin: 'Ginebra',
};

async function supabaseFetch(path, options = {}) {
  const url = `${required('SUPABASE_URL')}/rest/v1/${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      apikey: required('SUPABASE_SERVICE_ROLE_KEY'),
      Authorization: `Bearer ${required('SUPABASE_SERVICE_ROLE_KEY')}`,
      'Content-Type': 'application/json',
      Prefer: options.prefer || 'return=representation',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Supabase ${options.method || 'GET'} ${path} failed: ${res.status} ${await res.text()}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Шаг 1 — находим реальный UPC товара через веб-поиск (Anthropic API).
async function findUpc({ name, brand, bottleSizeMl }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': required('ANTHROPIC_API_KEY'),
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [
        {
          role: 'user',
          content: `Find the real, verified UPC barcode number for "${name}" by ${brand}, ${bottleSizeMl}ml bottle.
Cross-check it appears on at least one legitimate retailer or UPC database site (e.g. upcitemdb.com, a liquor store website, or the brand's own listing).

Respond with ONLY a JSON object, no markdown, no extra text:
{"upc": "1234567890" or null, "confidence": "high" | "medium" | "low", "source_url": "..."}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const textBlocks = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const cleaned = textBlocks.replace(/```json|```/g, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        // falls through
      }
    }
    return { upc: null, confidence: 'low', source_url: null };
  }
}

// Шаг 2 — по UPC берём фото из UPCitemdb (бесплатный trial-тариф, без ключа).
async function fetchPhotoByUpc(upc) {
  const res = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(upc)}`);
  if (!res.ok) {
    return null; // UPCitemdb не нашёл товар по этому UPC — не фатально, просто нет фото
  }
  const data = await res.json();
  const item = data?.items?.[0];
  const images = item?.images || [];
  return images.length > 0 ? images[0] : null;
}

async function main() {
  let inserted = 0;
  let skipped = 0;
  let noPhoto = 0;

  for (const seed of SEED_PRODUCTS) {
    const { name, brand, category, bottle_size_ml: bottleSizeMl } = seed;

    // Не дублируем — проверяем по названию+бренду.
    const existing = await supabaseFetch(
      `products?name=eq.${encodeURIComponent(name)}&brand=eq.${encodeURIComponent(brand)}&select=id`
    );
    if (existing && existing.length > 0) {
      skipped++;
      continue;
    }

    console.log(`Processing: ${name}...`);
    let photoUrl = null;
    let sourceUrl = null;

    try {
      const upcResult = await findUpc({ name, brand, bottleSizeMl });
      if (upcResult.upc && upcResult.confidence !== 'low') {
        photoUrl = await fetchPhotoByUpc(upcResult.upc);
        sourceUrl = upcResult.source_url || null;
      }
    } catch (err) {
      console.error(`  Failed to find photo for ${name}:`, err.message);
    }

    if (photoUrl) {
      console.log(`  Photo found via upcitemdb_retailer_aggregate: ${photoUrl}${sourceUrl ? ` (UPC source: ${sourceUrl})` : ''}`);
    } else {
      noPhoto++;
      console.log('  No photo found — leaving photo_url empty for now.');
    }

    const [product] = await supabaseFetch('products', {
      method: 'POST',
      body: JSON.stringify({
        name,
        brand,
        category,
        category_es: CATEGORY_ES[category] || category,
        photo_url: photoUrl,
      }),
    });

    if (product?.id) {
      await supabaseFetch('product_variants', {
        method: 'POST',
        prefer: 'return=minimal',
        body: JSON.stringify({ product_id: product.id, bottle_size_ml: bottleSizeMl }),
      });
    }

    inserted++;
    await sleep(2000); // не долбим оба API подряд — щадящий темп
  }

  console.log(`Done. Inserted ${inserted} products (${inserted - noPhoto} with photo, ${noPhoto} without), skipped ${skipped} duplicates.`);
}

main().catch((err) => {
  console.error('product-catalog-agent fatal error:', err);
  process.exit(1);
});
