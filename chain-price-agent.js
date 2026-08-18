/**
 * CaskRoute — Chain Price & Availability Agent
 *
 * Раз в день обходит позиции в store_inventory, принадлежащие крупным сетям
 * (stores.store_type = 'chain'), и обновляет цену + статус наличия через
 * публичные страницы наличия по конкретному магазину (проверено на примере
 * Total Wine — у них есть выбор магазина + показ "available for pickup").
 *
 * Тот же паттерн, что и price-agent.js для StackBid: web_search/web_fetch
 * реальных страниц + разбор через Anthropic API, не угадывание чужого
 * внутреннего API.
 *
 * Требуемые переменные окружения (Render):
 *   ANTHROPIC_API_KEY
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

const MAX_RUNTIME_MS = 5 * 60 * 1000;
const startedAt = Date.now();

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function timeLeft() {
  return MAX_RUNTIME_MS - (Date.now() - startedAt);
}

async function supabaseFetch(path, options = {}) {
  const url = `${required('SUPABASE_URL')}/rest/v1/${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'apikey': required('SUPABASE_SERVICE_ROLE_KEY'),
      'Authorization': `Bearer ${required('SUPABASE_SERVICE_ROLE_KEY')}`,
      'Content-Type': 'application/json',
      'Prefer': options.prefer || 'return=representation',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase ${options.method || 'GET'} ${path} failed: ${res.status} ${body}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ---------- Anthropic — веб-поиск + разбор цены/наличия ----------

async function findChainPriceAndStock({ productName, chainName, storeCity, storeState }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': required('ANTHROPIC_API_KEY'),
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [
        {
          role: 'user',
          content: `Find the current price and pickup availability for "${productName}" at a ${chainName} store in ${storeCity}, ${storeState}.
Search the chain's own website for the specific product and check if it shows as available for pickup at a store in that city.

Respond with ONLY a JSON object, no markdown, no extra text:
{"price": number or null, "in_stock": "in_stock" | "low" | "out" | "unknown", "confidence": "high" | "medium" | "low", "source_url": "..."}`,
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
    return { price: null, in_stock: 'unknown', confidence: 'low', source_url: null };
  }
}

// ---------- Основной прогон ----------

async function main() {
  // Берём только позиции сетевых магазинов — независимые точки обновляются
  // сами через merchant-update, их эта функция не трогает.
  const items = await supabaseFetch(
    `store_inventory?select=id,store_id,product_variants(bottle_size_ml,products(name,category)),stores(name,city,state,store_type)&stores.store_type=eq.chain&limit=200`
  );

  let processed = 0;
  let updated = 0;
  let skipped = 0;

  for (const item of items || []) {
    if (timeLeft() < 15000) {
      console.log('Approaching runtime cap, stopping early.');
      break;
    }

    const store = item.stores;
    if (!store) {
      skipped++;
      continue;
    }

    try {
      const productName = item.product_variants?.products?.name;
      const bottleSize = item.product_variants?.bottle_size_ml;
      if (!productName) {
        skipped++;
        continue;
      }

      const result = await findChainPriceAndStock({
        productName: bottleSize ? `${productName} ${bottleSize}ml` : productName,
        chainName: store.name,
        storeCity: store.city,
        storeState: store.state,
      });

      // Низкая уверенность — не перезаписываем существующие данные плохим предположением.
      if (result.confidence === 'low' && result.price === null) {
        skipped++;
        continue;
      }

      // Маппинг LLM-confidence на схему verified-price: этот агент всегда читает
      // публичный сайт магазина (не POS, не подтверждение владельцем), поэтому
      // потолок — 'website_listed'. Низкая уверенность модели (даже если цена есть)
      // не дотягивает и до этого — остаётся 'unverified', чтобы не выдавать
      // сомнительные данные за проверенные.
      const confidence = result.confidence === 'low' ? 'unverified' : 'website_listed';

      await supabaseFetch(`store_inventory?id=eq.${item.id}`, {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: JSON.stringify({
          ...(result.price !== null ? { price: result.price } : {}),
          in_stock: result.in_stock,
          confidence,
          last_updated_by: 'scraper',
          updated_at: new Date().toISOString(),
        }),
      });

      await supabaseFetch('inventory_update_log', {
        method: 'POST',
        prefer: 'return=minimal',
        body: JSON.stringify({
          store_id: item.store_id,
          inventory_id: item.id,
          action: 'price_update',
          source: 'scraper',
        }),
      });

      updated++;
    } catch (err) {
      console.error(`Failed on item ${item.id} (${item.product_variants?.products?.name || 'unknown'}):`, err.message);
      skipped++;
    }

    processed++;
  }

  console.log(`Done. Processed ${processed}, updated ${updated}, skipped ${skipped} in ${Date.now() - startedAt}ms.`);
}

main().catch((err) => {
  console.error('chain-price-agent fatal error:', err);
  process.exit(1);
});
